# State Hub

State Hub 是一个本地优先的桌面信号路由与输出协调平台。它接收来自 Codex、脚本、HTTP 或插件的状态声明与瞬时事件，经绑定、优先级仲裁和可靠投递后，驱动虚拟面板、通知、Webhook 与受支持的硬件。

首版采用 **Tauri v2 + Node 24 sidecar**：Tauri 负责桌面生命周期与私有管理会话，Node sidecar 负责 SQLite 账本、API、仲裁、outbox 和驱动。

## 开发

安装好 Node.js 24、pnpm 10.17.1、Rust 和 Tauri 平台编译依赖后，在项目根目录运行：

```powershell
npm run dev
```

这条命令自动按锁文件安装依赖、构建共享包和 Core sidecar，再启动 Vite 与 Tauri 桌面窗口；桌面会自动启动并管理 Core。无需另开终端运行服务，也无需手动设置管理令牌。第一次编译 Rust 和准备 sidecar 会较慢。

修改 `apps/desktop/src` 中的界面代码后会热更新；修改 Rust 代码后 Tauri 会重新编译。修改 Core 或共享包后，按 `Ctrl+C` 停止，再运行 `npm run dev`，便会重新构建并加载最新代码。关闭窗口默认隐藏到托盘；结束开发请在终端按 `Ctrl+C`。这是本地开发启动，不生成安装包。

底层仍使用 pnpm 管理 workspace 依赖，不需要执行 `npm install`。仅调试前端可用 `pnpm dev:desktop`；仅调试 Core 的令牌要求见 [运行手册](docs/OPERATIONS.md)。

核心服务启动后会在当前用户运行目录写入只对当前用户开放的 discovery 文件，并监听随机 loopback 端口。生产者 API 需要独立 bearer token；管理 API 只接受由桌面壳注入的私有会话令牌。

## 工作区

- `apps/core`：Node sidecar、SQLite、HTTP/SSE、投递执行器
- `apps/desktop`：React/Ant Design 管理界面与 Tauri v2 壳
- `packages/protocol`：跨进程协议与 JSON Schema
- `packages/domain`：纯函数领域模型、绑定与仲裁
- `packages/sdk`：社区扩展 TypeScript SDK
- `packages/plugin-kit`：确定性扩展打包、checksum 与 Ed25519 publisher 校验
- `packages/emit-cli`：fail-open、spool-first 的 `state-hub-emit`
- `docs/ARCHITECTURE.md`：唯一规范性架构文档

历史设计稿已移入 `docs/legacy/`，仅作背景资料，不再具有规范性。

提交前运行 `pnpm verify`。其中 unit test 与真实 Core process acceptance 是两个独立门禁，后者不会被 `pnpm test` 隐式替代。

## 许可证

MIT
