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
