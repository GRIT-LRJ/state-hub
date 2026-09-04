# State Hub — 统一状态/通知平台（规划文档）

> 状态：**讨论阶段，未实现代码**（本文件是继续讨论和后续开发的唯一上下文入口）。
> 新会话开始前，请先读：`PLAN.md` + `docs/EXISTING-SOURCES.md`。

---

## 1. 项目要解决什么

本机目前有一个可用的 **Codex 状态灯**：Codex 完成回答时键盘灯带变绿、等待用户回答时变琥珀色。
它是"Codex 事件 → 键盘灯"一条直连链路，**只服务 Codex 这一种应用、只支持 VK87 这一种键盘**。

本项目目标是把它抽象成一个**平台**：

- 上层应用（Codex、DeepSeek Harness、未来任何工具）只负责**上报自己的状态**；
- 中层平台负责**仲裁出唯一当前状态**，并提供管理/设计前端；
- 下层驱动负责**把状态翻译成具体设备的动作**（键盘灯、微信消息、网络设备……），且**驱动是任意类型、可插拔**。

> 与现有实现的冲突背景：如果同时让 Codex 和 DSH 直接写同一把键盘灯，两边状态会互相覆盖
> （已实测确认）。平台化正是解决这个冲突的正路：应用只上报，仲裁在平台，驱动只管执行。

---

## 2. 目标架构

```
应用层（Apps）
  Codex │ DSH │ 未来工具
    │   上报：app + 状态语义（如 completed / decision / running / none）
    ▼
平台层（Platform —— 新项目，即本仓库）
  ├── 事件接口（API）       应用上报入口，例如 POST /api/events
  ├── 状态机                聚合 + 仲裁 → 唯一当前状态
  ├── 驱动注册表            JSON manifest + JSON Schema 校验 + 驱动实现
  ├── Runtime               v1 = 同进程插件加载器；接口稳定后可切成子进程
  ├── 配置/数据目录         驱动清单、映射、优先级、token 等（本地持久化）
  └── 前端（浏览器）        驱动管理 / 状态映射设计 / 状态机可视化 / 测试台
    │   广播：当前状态（语义）
    ▼
驱动层（Drivers —— 任意"反应器"）
  ├── 虚拟驱动   （v1）：不碰硬件，前端色块 + 日志
  ├── VK87 键盘  （M3）：状态 → 报告字节 → 键盘灯带
  ├── PushPlus   （M2）：状态 → 微信消息（token + 模板）
  └── 未来任意    （USB / 网络 / 灯光 …）：各自翻译
```

**核心原则：平台只说"语义状态"，驱动负责"动作翻译"。**
平台不知道"绿色"、"报告字节"、"微信消息"这些细节；驱动也不知道别的应用在干什么。

---

## 3. 已确认的决策（共识）

| 项 | 决定 |
|---|---|
| 项目位置 | `E:\TraePro\state-hub` |
| 技术栈 | Node.js + TypeScript |
| 平台形态 | 本地服务 + 浏览器前端 |
| 前端 | React + Vite + Ant Design |
| 驱动定义 | 每个驱动 = `JSON manifest`（JSON Schema 校验）+ 一段实现代码 |
| 状态→动作 | **配置在驱动层**：每个驱动自己的 `stateActions` 映射表（键盘=颜色/报告，PushPlus=消息文本…） |
| 状态词汇（v1） | 固定标准：`completed` / `decision` / `none`（暂不开放自定义状态） |
| 无活动语义（v1） | **事件驱动 + 状态保持**：应用有变化才上报；无上报 = 不广播 = 驱动保持上次状态；`none` 是显式"恢复默认"信号；TTL 不加 v1 |
| 颜色/响应语义 | 驱动层配置；不同设备不同响应方式 |
| 驱动类型 | 不限于键盘：HID 键盘 / PushPlus 微信 / 网络设备 / 虚拟驱动等 |
| M1 | 平台骨架 + 事件 API + 状态机 + **虚拟驱动** + 前端测试台（只做虚拟驱动） |
| 驱动接口 | v1 同进程加载；约定统一 `Driver` 接口，未来可切独立进程/WebSocket（传输换、接口不变） |
| 接口边界（2026-09-02 修正） | 平台对外只有 **HTTP API（API 层）**；**Runtime 只对内（驱动宿主）**；应用不接触 Runtime |
| 安全 | PushPlus token 等密钥放本地 `data/`，不进 git，前端不回显明文 |
| 现有代码 | codex/DSH 现有实现**原地保留**、只作参考；平台先以虚拟驱动独立开发，M3 再桥接 VK87 |

---

## 4. 关键概念说明（新人友好）

### 4.1 驱动 = 声明（JSON）+ 行为（代码）

驱动 manifest 示例（示意，最终 schema 待定稿）：

```jsonc
// 键盘驱动：状态 → 颜色/报告
{
  "id": "vk87",
  "kind": "hid-keyboard",
  "device": { "vendorId": 14154, "productId": 41584, "usagePage": 65535, "usage": 2 },
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "reportHex": "000801...", "label": "绿色" },
    "decision":  { "reportHex": "000802...", "label": "琥珀" },
    "none":      { "reportHex": "0008...", "label": "默认" }
  }
}
```

```jsonc
// PushPlus 驱动：状态 → 微信消息
{
  "id": "wechat-push",
  "kind": "pushplus",
  "config": { "token": "xxxx", "api": "https://www.pushplus.plus/send" },
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "message": "✅ 任务已完成" },
    "decision":  { "message": "⚠️ 需要你回答问题" },
    "none":      { "message": "" }
  }
}
```

### 4.2 驱动接口（v1 草案）

```ts
interface Driver {
  readonly manifest: DriverManifest      // 校验后的 JSON 声明
  init(): Promise<void>                  // 连接/初始化设备
  apply(state: LightState): Promise<void> // 按 stateActions 响应当前状态
  restore(): Promise<void>               // 恢复默认
  status(): Promise<{ connected: boolean; lastError?: string }>
  dispose(): Promise<void>               // 卸载/断开
}
```

### 4.3 状态机 v1（优先级仲裁）

- 固定状态集：`completed` / `decision` / `none`
- 仲裁优先级（草案，可配）：**`decision` > `completed` > `none`**
- 无任何应用活动 → `none`（驱动执行 restore/默认）
- 优先级表 v1 用配置 + 前端"可读列表"，可视化连线编辑器放到后续

### 4.4 Runtime 是什么

平台内部负责"发现/校验/加载/生命周期管理驱动"并承载事件总线与调度的宿主层。
v1 用同进程插件加载器；接口不变的前提下，后续可把驱动隔离到独立进程（崩溃不影响平台）。

---

## 5. 计划目录结构（M1 草案）

```
E:\TraePro\state-hub\
├── PLAN.md                     ← 本文件
├── README.md                   ← 项目入口说明
├── docs\
│   └── EXISTING-SOURCES.md     ← 现有实现（codex/DSH）清单与可复用事实
├── apps\                       （后续：Codex/DSH 适配器，M4）
├── packages\
│   ├── platform\               ← 平台核心：事件 API、状态机、驱动注册表、Runtime
│   ├── frontend\               ← React + Vite + AntD 前端
│   └── drivers\
│       ├── virtual\            ← M1 虚拟驱动
│       ├── vk87\               ← M3 桥接现有 exe
│       └── pushplus\           ← M2 微信通知驱动
└── data\                       ← 运行时数据/配置/密钥（不进 git）
```

> 目录/包名仅为草案，若新会话调整，请先改本文件再动工。

---

## 6. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1** | 平台骨架（Node/TS）+ 事件 API + 状态机 + 虚拟驱动 + 前端测试台 | 前端按钮模拟应用事件 → 状态机仲裁 → 虚拟驱动响应 → 色块/日志可见 |
| **M2** | 前端三件套（驱动管理 / 状态映射设计 / 状态机概览）+ PushPlus 驱动 | 可管理驱动、配置映射、收到微信消息；虚拟+PushPlus 共存演示 |
| **M3** | VK87 真机驱动（先桥接现有 `codex-keyboard-light.exe`，协议细节见 `docs/EXISTING-SOURCES.md`） | 平台仲裁结果真实驱动键盘灯带；不与 Codex 直连链路冲突 |
| **M4** | Codex hooks / DSH 插件改为"上报平台"（不再直接写灯） | 两应用同时活动，灯带/推送由平台统一仲裁 |

---

## 7. 待讨论/待定项（新会话继续）

1. **应用上报协议**：草案为 HTTP `POST /api/events`（`{ app, state, detail?, ts? }`），
   详见 `docs/CONCEPTS-DEEP-DIVE.md` §3 —— 待确认或调整。
2. ~~驱动发现机制~~ ✅ 已定（2026-09-02）：扫描 `packages/drivers/*` 目录自动发现 + JSON Schema 校验。
3. ~~驱动状态过滤~~ ✅ 已定（2026-09-02）：驱动在 manifest 的 `states` 中声明子集，只响应自己关心的状态。
4. ~~无活动判定~~ ✅ 已定（2026-09-02）：**事件驱动 + 状态保持** ——
   应用有变化才上报；无上报 = 不广播 = 驱动保持上次状态；`none` 是显式"恢复默认"信号；TTL 不进 v1。
5. **状态机细节**：多应用同状态（两个都 `completed`）聚合显示；优先级表是否放前端配置？
6. **前端可视化深度**：v1 是"状态概览 + 优先级表"，还是就要画节点迁移图？
7. **VK87 驱动形态**：桥接现有 exe（最快）还是把协议代码内化进驱动（彻底）？
8. ~~平台命名~~ ✅ 已定（2026-09-02）：**`state-hub`**（通用名：汇集/仲裁/分发任意应用状态到任意执行器）；包名前缀建议 `@state-hub/...`。
9. **实时通道**：前端如何实时看到状态变化（SSE / WebSocket）？v1 可用轮询简化。

---

## 8. 下一步（新会话的起点）

1. 先读本文件与 `docs/EXISTING-SOURCES.md`；
2. 回答第 7 节待定项（至少 1、3、4、6）；
3. 定稿 schema 后，再开始 M1 骨架（**切勿先写实现再讨论**）。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
