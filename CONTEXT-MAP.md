# Context map

State Hub 的规范性业务边界见 [架构规范](docs/ARCHITECTURE.md)。修改某个上下文前，阅读其上下文文档；涉及桌面交互时同时阅读桌面术语和设计约定。

- [桌面外壳与界面](apps/desktop/CONTEXT.md)：配置、运行观察、凭据和系统集成。
- [Core 本地服务](apps/core)：接受输入、持久化、配置发布、投递与插件运行。
- [领域模型](packages/domain)：状态匹配、映射与输出仲裁。
- [通信协议](packages/protocol)：跨上下文共享的消息和配置契约。
- [公共 SDK](packages/sdk)：生产者接入。
- [插件工具包](packages/plugin-kit)：扩展定义和驱动通信。
- [事件 CLI](packages/emit-cli)：命令行提交、Codex hook 与本地待发送文件。

尚未有独立上下文文档的部分，以架构规范及该上下文代码为准；旧版材料位于 docs/legacy，不作为现行术语来源。
