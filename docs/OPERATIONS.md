# 开发与运行手册

架构约束见 [ARCHITECTURE.md](./ARCHITECTURE.md)。本文只说明如何运行和验证当前实现。

## 环境

- Node.js 24 LTS 与 pnpm 10+
- Tauri 桌面编译需 Rust stable、Cargo、平台 WebView/编译工具链
- Windows 原生依赖需要 MSVC；Linux 的 OS keyring 需要 Secret Service/libsecret

```powershell
pnpm install
pnpm test
pnpm test:acceptance
pnpm check
pnpm build
```

也可运行 `pnpm verify` 串行执行完整标准门禁。`pnpm test` 只运行 unit/in-process tests；真实 Core、临时 SQLite、loopback HTTP/SSE 与 dispatcher 的 process-level acceptance 由 `pnpm test:acceptance` 单独运行，两者都必须通过。

`pnpm build:sidecar` 会用 `@yao-pkg/pkg` 生成 Node 24 自包含 sidecar，并按 Tauri 要求命名为 `apps/desktop/src-tauri/binaries/state-hub-core-<target-triple>`。该目录是生成物，不提交版本库。随后可执行：

```powershell
pnpm --filter @state-hub/desktop tauri build
```

## 单独运行 Core

Core 要求桌面监督者提供至少 32 字符的临时管理令牌：

```powershell
$env:STATE_HUB_ADMIN_TOKEN = '<random-32+-character-session-token>'
pnpm dev:core
```

它只监听 `127.0.0.1` 随机端口，并将端口、PID 和 instance id 原子写入 current-user runtime 目录的 `discovery.json`。文件中不包含令牌。

Core 启动时运行一次历史保留维护，之后默认每小时运行。生产默认边界为 7 天和 100 MiB，适用于可清理的业务与诊断数据；测试或受控诊断可用 `STATE_HUB_RETENTION_MAX_AGE_MS`、`STATE_HUB_RETENTION_MAX_BYTES` 与 `STATE_HUB_RETENTION_INTERVAL_MS` 注入更小的正整数阈值。容量是五类历史记录主要字段及轻量 command/event 去重身份的 UTF-8 逻辑字节总量，不以 SQLite 文件高水位计量；SQLite 会复用已释放页面。未完成 delivery 及其引用、去重身份不得为满足容量目标而删除；受保护数据超预算时，Core 在 stderr 输出 `state-hub.retention-over-budget` 结构化事件及超额字节数。

## 首次配置

桌面首页的“配置 Codex + 虚拟输出”会：

1. 创建绑定到 `official.codex` SourceDefinition 的 `codex` producer。
2. 将 producer token 写入 OS keyring 的 `dev.statehub.desktop / producer:codex`，不生成明文凭据文件。
3. 创建配置草稿并显示影响预览。
4. 用户确认后发布 `Codex status → virtual-main/codex-status` 绑定。

如果 OS keyring 不可用，配置应保持禁用；不得改用明文文件。

## Codex Hook

构建 `@state-hub/emit-cli` 后，将 [hooks.example.json](../integrations/codex/hooks.example.json) 中的条目合并到用户级 Codex hooks，而不是覆盖已有 hooks。当前适配器接收现有 hook stdin 字段：`hook_event_name`、`session_id`、`turn_id`、`tool_name`。

Hook 是短同步调用：先把命令原子写入 spool，再尝试 800ms loopback 请求。Core 或 keyring 不可用时 hook 仍以成功退出，命令留在 spool；运行 `state-hub-emit drain` 可重试。暂停期间被抑制的 effect 不会补发。

不同 Codex 会话使用不同 `scopeId=session_id`，因此账本不会互相覆盖。如果两个会话映射到同一输出通道，仲裁选择 urgency 更高的会话；同 urgency 再比较 binding order 和最新 server revision。高优先级会话 clear/过期后，投影自动回落到仍有效的另一个会话。

## 插件信任与安装

管理 API 使用 Tauri 注入的临时管理会话。先向 `POST /api/v1/admin/plugins/trusted-publishers` 提交 publisher ID 和 Ed25519 PEM 公钥，再将确定性的 `.statehub-plugin` 原始字节以 `application/vnd.statehub.plugin` 发送到 `POST /api/v1/admin/plugins/install`。`GET /api/v1/admin/plugins` 只列安装元数据与包哈希；`GET /api/v1/admin/catalog` 立即显示安装后的来源、驱动定义和动作契约。安装记录与信任库保存在 SQLite，不保存私钥或管理令牌。

正式模式拒绝未签名包。仅在受控开发运行中设置 `STATE_HUB_PLUGIN_DEVELOPMENT_MODE=true` 才允许安装并使用未签名定义；恢复正式模式后这些定义不会进入 Catalog 或来源校验。安装会检查全部 checksum、签名、许可证、当前平台入口和 JSON Schema，失败不改变 Catalog。插件安装后，Core 为每个启用的包启动一个独立进程；`GET /api/v1/admin/plugins/runtime` 返回包级运行状态、PID 与安全原因码。`POST /api/v1/admin/plugins/:id/disable` 停止进程并从可用 Catalog 移除定义，`POST /api/v1/admin/plugins/:id/enable` 重新验包、握手、健康检查后恢复。插件超时、异常退出或协议错误不会直接使 Core 退出；下一次相关投递可尝试重建进程。重新启用成功会向该插件驱动补发当前 stateful 投影，不补发历史 queued-effect。插件升级和依赖感知卸载分别由后续 Issue 完成。

## VK87

[vk87-profile.example.json](../apps/core/assets/vk87-profile.example.json) 是已核实的 65 字节 profile。驱动强制匹配：

- VID `0x374A`
- PID `0xA270`
- usagePage `0xFFFF`
- usage `0x0002`
- 恰好一个可写 HID interface

配置不匹配、报告不是完整 65 字节或设备数量不是 1 时拒绝写入。测试不会向设备发送报告；真实硬件 smoke 必须由人工明确触发。

## 发布门禁

标准验证必须包含 `pnpm test`、`pnpm test:acceptance`、`pnpm check` 和 `pnpm build`。process-level acceptance 保持独立，不混入普通 unit test。

stable v1 前必须在 Windows x64、macOS 实际目标架构和 Linux x64 分别执行安装/升级/卸载、单实例、托盘、开机启动、暂停恢复、断网重连与签名验证。未实测架构只能标记 preview。
