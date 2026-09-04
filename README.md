# State Hub

State Hub 是一个本地优先的桌面信号路由与输出协调平台。它接收来自 Codex、脚本、HTTP 或插件的状态声明与瞬时事件，经绑定、优先级仲裁和可靠投递后，驱动虚拟面板、通知、Webhook 与受支持的硬件。

首版采用 **Tauri v2 + Node 24 sidecar**：Tauri 负责桌面生命周期与私有管理会话，Node sidecar 负责 SQLite 账本、API、仲裁、outbox 和驱动。

## 开发

```powershell
corepack enable
pnpm install
pnpm test
pnpm build
pnpm dev:core
```

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

## 许可证

MIT
