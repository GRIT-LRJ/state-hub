# State Hub

统一"状态 / 通知"平台：应用上报状态 → 平台状态机仲裁 → 任意驱动执行
（键盘灯带、PushPlus 微信、USB/网络设备……）。

> **当前状态：讨论阶段，未实现代码。**
> 先读 `PLAN.md`（架构与共识）与 `docs/EXISTING-SOURCES.md`（现有 Codex/DSH 实现事实）。

## 文档

| 文件 | 内容 |
|---|---|
| [PLAN.md](./PLAN.md) | 项目目标、三层架构、已确认决策、里程碑、待定项 |
| [docs/EXISTING-SOURCES.md](./docs/EXISTING-SOURCES.md) | 现有 codex-keyboard-light / dsh-keyboard-light 的全部可复用事实 |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | 新手术语表：平台 / Runtime / 驱动 / 状态机（硬件→软件对照） |
| [docs/CONCEPTS-DEEP-DIVE.md](./docs/CONCEPTS-DEEP-DIVE.md) | 深入讲解：JSON / JSON Schema、事件 API、驱动接口与生命周期（含 v1 草案） |
| [docs/RUNTIME-DEEP-DIVE.md](./docs/RUNTIME-DEEP-DIVE.md) | Runtime 深讲：平台接口、定义/实现/调用三方角色、调用链与信息传递 |
| [docs/FAQ-RUNTIME.md](./docs/FAQ-RUNTIME.md) | Runtime 常见疑问 FAQ：Schema 归属、Adapter、两种接口、HTTP、过滤机制 + 虚拟驱动手把手推演 |
| [docs/ARCHITECTURE-DIAGRAM.md](./docs/ARCHITECTURE-DIAGRAM.md) | 完整关系图：应用/平台/Runtime/驱动/注册表（一张图读懂 + 餐厅比喻） |
| [docs/DRIVERS-EXAMPLES.md](./docs/DRIVERS-EXAMPLES.md) | 驱动实例详解：虚拟 / USB(HID) / 网络设备 三种实现 + 全景图 |
| [docs/API-LAYER.md](./docs/API-LAYER.md) | API 层详解：平台对外窗口的组成、请求生命周期、端点清单、Express 示例代码 |
| [docs/STATE-MACHINE.md](./docs/STATE-MACHINE.md) | 状态机仲裁算法详解：优先级规则、核心代码、工作示例表、边界情况 |
| [docs/ARCHITECTURE-FINAL.md](./docs/ARCHITECTURE-FINAL.md) | **最终版 Mermaid 架构图**（应用/平台/API/状态机/Runtime/驱动，含边界速查） |
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
