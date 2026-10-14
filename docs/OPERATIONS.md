# 开发与运行手册

架构约束见 [ARCHITECTURE.md](./ARCHITECTURE.md)。本文只说明如何运行和验证当前实现。

## 环境

- Node.js 24 LTS 与 pnpm 10+
- Tauri 桌面编译需 Rust stable、Cargo、平台 WebView/编译工具链
- Windows 原生依赖需要 MSVC；Linux 的 OS keyring 需要 Secret Service/libsecret

## 一键开发启动

在项目根目录执行：

```powershell
npm run dev
```

入口使用 pnpm 按锁文件安装依赖，随后构建共享包和最新 Core sidecar，再通过 `tauri dev` 启动 Vite、桌面窗口及受监督的 Core。运行到哪一步失败就停在哪一步，不继续启动旧构建。Node/pnpm、Rust 和系统编译工具链需预先安装；第一次启动编译耗时较长。

界面源码由 Vite 热更新，Rust 变更由 Tauri 重新编译。Core 和共享包变更需在终端 `Ctrl+C` 后重新运行同一条 `npm run dev`，入口会重建 sidecar。关闭窗口只隐藏到托盘，不等于结束开发。该入口使用现有本机配置与系统凭据，不重置数据，也不构建或安装发行包；无需单独启动 `dev:core` 或手工注入管理令牌。

`pnpm dev:desktop` 保留为仅前端 Vite 调试入口，不等同于完整桌面应用。依赖仍由 pnpm 管理，无需 `npm install`；依赖清单变更时先更新并提交 pnpm 锁文件，入口遇到锁文件不一致会明确失败。

## 验证与发行构建

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

桌面使用分步配置，各步可以独立完成：

1. 在“来源”的“Codex 接入引导”创建绑定到 `official.codex` 的接入方，并把 Token 保存到系统凭据库的 `dev.statehub.desktop / producer:codex`。已有授权与凭据时不会自动轮换。
2. 在“输出”的“虚拟输出引导”审阅并应用虚拟输出。可以到此结束，不要求同时创建规则。
3. 选择“继续添加规则”，在“规则”审阅并应用 Codex 状态到虚拟输出的联动。发送端还需配置下面的 Codex hook，才能实际报告状态。

来源授权与密钥保存立即生效，输出和规则分别审阅应用。如果系统凭据库写入失败，界面会保留一次性 Token 供用户处理并显示错误，不生成明文凭据文件，也不把凭据准备记作成功。完整六栏说明见 [界面设计与使用讲解](../apps/desktop/docs/UI-DESIGN.md)。

## Codex Hook

构建 `@state-hub/emit-cli` 后，将 [hooks.example.json](../integrations/codex/hooks.example.json) 中的条目合并到用户级 Codex hooks，而不是覆盖已有 hooks。当前适配器接收现有 hook stdin 字段：`hook_event_name`、`session_id`、`turn_id`、`tool_name`。

Hook 是短同步调用：先把命令原子写入 spool，再尝试 800ms loopback 请求。Core 或 keyring 不可用时 hook 仍以成功退出，命令留在 spool；运行 `state-hub-emit drain` 可重试。暂停期间被抑制的 effect 不会补发。

不同 Codex 会话使用不同 `scopeId=session_id`，因此账本不会互相覆盖。如果两个会话映射到同一输出通道，仲裁选择 urgency 更高的会话；同 urgency 再比较 binding order 和最新 server revision。高优先级会话 clear/过期后，投影自动回落到仍有效的另一个会话。

## 插件信任与安装

管理 API 使用 Tauri 注入的临时管理会话。先向 `POST /api/v1/admin/plugins/trusted-publishers` 提交 publisher ID 和 Ed25519 PEM 公钥，再将确定性的 `.statehub-plugin` 原始字节以 `application/vnd.statehub.plugin` 发送到 `POST /api/v1/admin/plugins/install`。`GET /api/v1/admin/plugins` 只列安装元数据与包哈希；`GET /api/v1/admin/catalog` 立即显示安装后的来源、驱动定义和动作契约。安装记录与信任库保存在 SQLite，不保存私钥或管理令牌。

正式模式拒绝未签名包。仅在受控开发运行中设置 `STATE_HUB_PLUGIN_DEVELOPMENT_MODE=true` 才允许安装并使用未签名定义；恢复正式模式后这些定义不会进入 Catalog 或来源校验。安装会检查全部 checksum、签名、许可证、当前平台入口和 JSON Schema，失败不改变 Catalog。插件安装后，Core 为每个启用的包启动一个独立进程；`GET /api/v1/admin/plugins/runtime` 返回包级运行状态、PID 与安全原因码。`POST /api/v1/admin/plugins/:id/disable` 停止进程并从可用 Catalog 移除定义，`POST /api/v1/admin/plugins/:id/enable` 重新验包、握手、健康检查后恢复。插件超时、异常退出或协议错误不会直接使 Core 退出；下一次相关投递可尝试重建进程。重新启用成功会向该插件驱动补发当前 stateful 投影，不补发历史 queued-effect。升级启用中的插件时，将同一 publisher 签名的新版本原始字节以 `application/vnd.statehub.plugin` 发送到 `POST /api/v1/admin/plugins/:id/upgrade`。Core 保持旧进程服务，同时在旁路子进程完成验包、定义 Schema、协议握手、健康检查和 `statehub.migrate` 配置迁移；迁移 RPC 只接收本包 DriverInstance 的 ID、类型和配置，并须返回相同 ID 的配置。Core 还会检查当前绑定、生产者来源、活动 claim 和待处理动作是否与新定义兼容。全部通过后等待在途投递结束，在同一 SQLite 事务内切换活动包并发布新配置 revision，再切换进程。失败不会改变活动版本或配置；`GET /api/v1/admin/plugins/:id/upgrade-status` 保留安全原因码。数据库提交后崩溃时，重启以已提交的新版本和 revision 恢复。停用的插件须先启用再升级。卸载前可查询 `GET /api/v1/admin/plugins/:id/dependencies`；`DELETE /api/v1/admin/plugins/:id` 仅在驱动实例、绑定、来源注册和待处理投递均解除后成功。拒绝时返回 `PLUGIN_IN_USE` 与按类别列出的 SHA-256 身份，避免在错误正文里回显用户填写的名称；管理界面可与当前配置身份比对。可通过发布移除实例/绑定的新配置、将来源重新注册到其他定义，并等待未完成投递结清。卸载与启用、禁用、安装写操作串行执行；中途崩溃在数据库删除前会保留包，重启后可重试。已有待处理 append-only 投递时，配置发布会拒绝移除或改变其驱动实例。

## VK87

[vk87-profile.example.json](../apps/core/assets/vk87-profile.example.json) 是已核实的 65 字节 profile。驱动强制匹配：

- VID `0x374A`
- PID `0xA270`
- usagePage `0xFFFF`
- usage `0x0002`
- 恰好一个可写 HID interface

配置不匹配、报告不是完整 65 字节或设备数量不是 1 时拒绝写入。测试不会向设备发送报告；真实硬件 smoke 必须由人工明确触发。

人工真机验收先运行 `pnpm --filter @state-hub/core build`。确认连接的是目标 VK87、当前没有其他程序控制灯带后，在交互式终端设置 `STATE_HUB_ALLOW_REAL_VK87=1`，再执行 `node apps/core/scripts/vk87-manual-smoke.mjs --write-real-vk87`。脚本只使用仓库内已核实的 profile，依次发送 decision 和 idle 恢复报告；选择器不唯一或报告不完整时拒绝写入。缺少环境变量、明确参数或交互式终端时脚本只显示说明，不加载 HID 或写设备。自动测试只通过 fake HID 运行。

## 功能验收与性能参考

可选容量与延迟测量运行 `pnpm test:performance`，或手动触发 `performance-report.yml`；不在日常 push/PR 执行。脚本启动真实 loopback Core 和临时 SQLite，发布 50 个来源、50 个虚拟输出及 500 条绑定；先以每 10 毫秒一条的节奏提交 500 条事件，再以最多 64 个在途 HTTP 请求提交 1000 条突发事件，强杀并重启 Core 后再测 100 条。输出包含 CPU、内存、Node/平台、各阶段 P50/P95/P99、接受速率、dispatcher 排空时间和投递总数。原 100 毫秒 P95 与 100/s 吞吐要求是待确认的参考目标，默认输出实际值与 `referenceTargetsMet`，超出参考不阻断当前功能验收；全部 1650 次虚拟投递仍须完成且没有死信。需要主动对照旧硬阈值时，可显式设置 `STATE_HUB_ENFORCE_PERFORMANCE_TARGETS=1`。发布环境应在空闲、规格固定的机器上重复运行并保存标准输出作为证据；共享 CI 机器的结果应连同环境信息审查。

标准验证必须包含 `pnpm test`、`pnpm test:acceptance`、`pnpm check` 和 `pnpm build`。process-level acceptance 保持独立，不混入普通 unit test。

stable v1 前必须在 Windows x64、macOS 实际目标架构和 Linux x64 分别执行安装/升级/卸载、单实例、托盘、开机启动、暂停恢复、断网重连与签名验证。未实测架构只能标记 preview。

### 原生安装包与更新验收

`pnpm test:release` 检查更新通道、四目标 manifest、签名/凭据缺失、stable 产品门禁和产物汇总。`pnpm test:driver-startup` 对 20 次真实 Core 冷启动，从发布 Virtual Driver 配置到第一次投递计时，1 秒 P95 仅作为待确认的参考值，真实投递失败仍拒绝。`pnpm build:sidecar` 后运行 `pnpm test:sidecar`，验证实际打包的 Core 能发现端口并响应健康检查。

`.github/workflows/package-smoke.yml` 在 Windows x64、macOS x64/arm64、Linux x64 上分别构建安装包，以实际安装后的程序运行 20 次首屏/Core 就绪测量，并检查安装、启动、健康和卸载。安装首屏与 Core 就绪记录实际 P95，旧 1 秒目标不再阻断；原有 15 秒启动等待、健康检查和子进程退出检查继续生效。`.github/workflows/updater-smoke.yml` 使用每次生成的临时测试密钥和本机更新服务，先验证畸形 manifest、错误签名、签名正确但安装内容损坏，再验证成功升级及 Core 数据保留；这些密钥不是 stable 发布密钥。两个工作流需要在对应平台真实运行，Windows 本地通过不代表 macOS/Linux 通过。

未经过操作系统签名的 alpha/beta 包必须使用 `tools/release/unsigned-config.mjs` 生成醒目的 `Alpha/Beta (Unsigned)` 名称和独立安装标识，且关闭正式 Updater。签名更新由 `tools/release/updater-config.mjs` 按通道写入固定公钥和 HTTPS manifest 地址；Updater 在桌面端只对有效配置启用。`tools/release/manifest.mjs` 能检查四平台签名文件并生成更新 manifest。

### Stable 候选

`.github/workflows/stable-candidate.yml` 只接受已经存在的 `vX.Y.Z` tag，并要求该提交的功能验收状态及四项基础门禁通过；仅 #22 明确标为 DEFERRED 时豁免待确认性能指标，其余 #1–#23 仍须 PASS。驱动启动记录参考指标，实际激活/投递失败仍拒绝。Windows 从受保护环境导入代码签名证书，实际检查安装器的 Authenticode、时间戳及篡改拒绝；macOS 导入 Developer ID，实际检查应用签名、Gatekeeper 和 DMG 公证；Linux 检查 AppImage 更新签名与 deb。每个平台还要通过真实安装 smoke，并对候选文件生成构建来源证明。汇总任务核验候选证明对应本次提交，生成四目标 `latest.json` 和五个安装包的 `SHA256SUMS`，把同名的两个 macOS 更新包改为互不覆盖的发布文件名。

候选工作流指定 `stable-signing` 环境；维护者须在 GitHub 为它配置审批保护和以下凭据。需配置更新密钥 `STATE_HUB_TAURI_PRIVATE_KEY`、可选的 `STATE_HUB_TAURI_PRIVATE_KEY_PASSWORD` 和变量 `STATE_HUB_TAURI_PUBLIC_KEY`；Windows 另需 `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`、`WINDOWS_TIMESTAMP_URL`；macOS 另需 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。私钥和公证凭据只注入需要它们的步骤，不写入仓库或产物。缺少任一必需值会拒绝构建。候选工作流必须在目标 tag 上手动触发；不能用本地测试密钥代替 stable 凭据。

此工作流只产生候选产物，不自动发布或推送。正式发布前须审查候选产物、签名、公证、证明、所有平台的真实 smoke 和当前仓库的 Issue 进度；缺少凭据或任一检查失败时不得标记 stable。目前 #23 的 macOS/Linux 真实运行证据仍不完整；Windows 旧首屏性能结果保留为待校准基线，不再是阻断项，#24 也没有正式凭据下的真实候选验证；两张 Issue 均未 PASS。
