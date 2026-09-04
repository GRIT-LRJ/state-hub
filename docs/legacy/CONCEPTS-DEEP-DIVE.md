# 深入讲解：JSON / JSON Schema、事件 API、驱动接口与生命周期

> 对象：新手（原硬件背景）。本文配合 `GLOSSARY.md` 阅读。
> 目标：讲懂这三个概念，并给出本平台的 v1 设计草案（**仍是讨论稿，未实现代码**）。

---

## 1. JSON：用"数据"告诉平台你是谁、你能干什么

### 1.1 JSON 是什么

JSON 是一种**纯数据格式**（没有逻辑、没有函数），只表达"键值对/数组/字符串/数字/布尔/null"。
浏览器、Node.js、任何语言都认识它；调试时人也能直接看懂。

示例——一个驱动在 JSON 里**声明**自己：

```json
{
  "id": "virtual",
  "name": "虚拟驱动",
  "kind": "virtual",
  "version": "0.1.0",
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "color": "#22c55e" },
    "decision":  { "color": "#f59e0b" },
    "none":      { "color": "#64748b" }
  }
}
```

逐字段解释：

| 字段 | 含义 |
|---|---|
| `id` | 驱动唯一标识（kebab-case，如 `virtual`、`vk87`、`wechat-push`） |
| `kind` | 驱动类型（`virtual` / `hid-keyboard` / `pushplus` / …），决定它怎么校验、怎么跑 |
| `states` | 支持哪些状态（v1 只有三个） |
| `stateActions` | **核心**：每个状态 → "我要做什么"（虚拟驱动=显示颜色；键盘=写报告字节；PushPlus=发什么消息） |

对比另外两种驱动（同一个平台、完全不同设备）：

```jsonc
// VK87 键盘驱动：状态 → 颜色（报告）
{
  "id": "vk87", "kind": "hid-keyboard",
  "device": { "vendorId": 14154, "productId": 41584, "usagePage": 65535, "usage": 2 },
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "reportHex": "00080100040700FF00EC00…", "label": "绿色" },
    "decision":  { "reportHex": "000802030407FFA50043…",   "label": "琥珀" },
    "none":      { "reportHex": "000802020407A02DF922…",   "label": "默认" }
  }
}
```

```jsonc
// PushPlus 微信驱动：状态 → 消息文本（甚至没有"颜色"概念）
{
  "id": "wechat-push", "kind": "pushplus",
  "config": { "token": "xxxx", "api": "https://www.pushplus.plus/send" },
  "states": ["completed", "decision"],
  "stateActions": {
    "completed": { "message": "✅ 任务已完成" },
    "decision":  { "message": "⚠️ 需要你回答问题" }
  }
}
```

**重点**：JSON 只描述"是什么"，不描述"怎么做"。怎么做由驱动实现代码负责。

---

## 2. JSON Schema：给 JSON 定规矩（校验）

### 2.1 为什么需要它

驱动是人（或 AI）写的，会写错：id 重复、颜色写成 "green"（不是 #RRGGBB）、报告字节只有 10 个。
如果平台不检查就加载，问题会在运行到一半才爆出来。
**JSON Schema = 一份描述"合法 JSON 长什么样"的规则文档**（它本身也是 JSON）。

平台加载驱动的流程：

```
读驱动目录
  → 读 manifest.json
  → 用 JSON Schema 校验
      ├─ 通过 → 注册驱动、调用 init()
      └─ 不通过 → 前端驱动管理页显示具体错误，不加载
```

### 2.2 v1 草案：通用 manifest schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["id", "kind", "states", "stateActions"],
  "properties": {
    "id":    { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "name":  { "type": "string" },
    "kind":  { "enum": ["virtual", "hid-keyboard", "pushplus"] },
    "states": {
      "type": "array",
      "items": { "enum": ["completed", "decision", "none"] },
      "minItems": 1
    },
    "stateActions": { "type": "object" }
  }
}
```

### 2.3 按 kind 的 action schema（分表校验）

因为不同 kind 的"动作"字段完全不同，所以再用 **discriminator（判别字段）** 分规则：

| kind | stateActions 里的动作字段 | 校验要求 |
|---|---|---|
| `virtual` | `color` | 必须匹配 `^#[0-9a-fA-F]{6}$` |
| `hid-keyboard` | `reportHex` | 必须是 65 字节的十六进制串（长度 130） |
| `pushplus` | `message` | 必须是非空字符串；`config.token` 必须存在 |

平台甚至可以用这份 schema 自动生成前端表单（这是"声明式"设计的红利：改 schema 就改 UI）。

### 2.4 举个例子：报错长这样

驱动写：`"color": "green"` → 校验失败，驱动管理页显示：

```
驱动 virtual 校验失败：stateActions.completed.color
  期望: 匹配 #RRGGBB（如 #22c55e）
  实际: "green"
```

**你只需要把错误信息写清楚，比平台任何隐藏故障都省事。**

---

## 3. 事件 API / 上报协议：应用怎么"告诉"平台

### 3.1 API 是什么

API = 程序之间约定好的"服务窗口"。我们的平台是本地服务（`http://127.0.0.1:3000`），
应用（或你手工测试）通过 **HTTP 请求 + JSON** 来调用它。
好处：任何语言都能调、`curl` 就能测、浏览器/F12 能看。

### 3.2 v1 上报协议草案

**应用上报自己状态（重点接口）：**

```
POST /api/events
Content-Type: application/json

{
  "app": "codex",                    // 哪个应用在说话
  "state": "completed",              // 标准状态：completed / decision / none
  "detail": {                        // 可选：附加信息（如会话 id、应用自己的说明）
    "session": "session-123"
  },
  "ts": 1730000000000                // 可选：应用侧时间戳（用于乱序判断，先不做也行）
}
```

平台响应：

```json
{
  "ok": true,
  "currentState": "decision",        // 状态机仲裁后的当前状态（可与会话上报不同！）
  "resolution": "kept-decision"      // 为什么是这个（如 "decision 优先于 completed"）
}
```

**关键认知**：应用上报的是"**我想表达**"，平台返回的是"**整体应该是什么**"——中间隔着一个状态机。
例如 Codex 上报 `completed`，但 DSH 正在等用户回答（`decision`），
平台仲裁后 `currentState` 仍是 `decision`（决策优先级更高）。

**查询当前状态：**

```
GET  /api/state      →  { "currentState": "decision", "apps": { "codex": "completed", "dsh": "decision" } }
```

**前端实时刷新（v1 简版）**：前端定时轮询 `GET /api/state`；
以后换成 SSE/WebSocket（服务端主动推）。

### 3.3 为什么先定这个协议

- 简单：一个接口 + 一个 JSON 字段集合，先跑通再说。
- 为 M4 铺路：Codex hooks / DSH 插件以后就是把"直接调 exe"改成"POST /api/events"。
- 本地服务只监听 `127.0.0.1`，安全边界小；token 类密钥只放平台自身的 `data/`。

---

## 4. 驱动接口与生命周期

### 4.1 统一接口（v1 草案，TypeScript）

```ts
type LightState = "completed" | "decision" | "none";

interface DriverManifest {
  id: string;
  name?: string;
  kind: string;               // virtual | hid-keyboard | pushplus | ...
  states: LightState[];
  stateActions: Record<LightState, unknown>;
  [key: string]: unknown;     // kind 特有的字段（device/config...）
}

interface Driver {
  readonly manifest: DriverManifest;

  /** 平台启动时调用：连接/初始化设备。失败则标为未连接，但不拖垮平台。 */
  init(): Promise<void>;

  /** 状态机广播某状态时调用：驱动自己查 stateActions 翻译成设备动作。 */
  apply(state: LightState): Promise<void>;

  /** 查询设备最近状态（在线？最后错误？），供前端显示。 */
  status(): Promise<{ connected: boolean; lastError?: string; detail?: unknown }>;

  /** 恢复正常/默认（例如解除警示）。 */
  restore(): Promise<void>;

  /** 平台关闭/卸载驱动时调用：断开设备、释放资源。 */
  dispose(): Promise<void>;
}
```

**每个字段都问自己：平台该不该知道细节？**——不该。平台只调 `apply("decision")`，
"amber 灯"还是"发微信"由驱动自己决定。

### 4.2 一次事件的全生命周期（时序）

```
应用         平台(状态机)          Runtime(驱动宿主)        虚拟驱动
 │ POST /api/events
 │───────────▶│
 │            │ 仲裁：currentState = "decision"
 │            │───────────────────────▶│
 │            │                        │ for each 已启用驱动:
 │            │                        │  apply("decision")
 │            │                        │──────────────────────▶│
 │            │                        │                        │ 查 stateActions.decision
 │            │                        │                        │  = { color: "#f59e0b" }
 │            │                        │                        │ 画色块/写日志
 │            │                        │◀───────────────────────│
 │            │◀───────────────────────│   (若无异常)
 │◀───────────│  { ok, currentState, resolution }
```

平台生命周期：

| 阶段 | Runtime 做什么 |
|---|---|
| 启动 | 扫描驱动目录 → 读 JSON → JSON Schema 校验 → `init()` → 注册到驱动管理页 |
| 运行 | 事件到达 → 状态机仲裁 → 对所有支持该状态的驱动 `apply()`（失败记录，不影响别的） |
| 手动操作 | 前端可 `restore()` / 查看 `status()` / 禁用某驱动 |
| 关闭/卸载 | 对每个驱动 `dispose()` |

### 4.3 错误隔离（重要原则）

一个驱动断电/写错，**平台和其他驱动照常工作**：

```ts
try {
  await driver.apply(state);
} catch (error) {
  driverRuntime.reportError(driver, error);   // 前端驱动管理页显示 lastError
}
```

### 4.4 虚拟驱动示例（伪代码，v1 真实就长这个样）

```ts
class VirtualDriver implements Driver {
  constructor(readonly manifest: DriverManifest) {}

  async init() { console.log('[virtual] ready'); }

  async apply(state: LightState) {
    const action = this.manifest.stateActions[state];
    console.log(`[virtual] light -> ${action.color}`);
    // 通知前端：把这个颜色画到测试台上
  }

  async status() { return { connected: true }; }
  async restore() { console.log('[virtual] restore default'); }
  async dispose() { console.log('[virtual] bye'); }
}
```

---

## 5. 串联：一张图看懂全部

```
 [Codex/DSH 应用]  POST /api/events ──▶ [平台服务：事件 API]
                                            │
                                  [状态机] 仲裁 → currentState
                                            │
                            [Runtime 驱动宿主] 广播 apply(currentState)
                                            │
        ┌──────────────┬──────────────┬────────────────┐
        ▼              ▼              ▼                ▼
   虚拟驱动        VK87驱动       PushPlus驱动        未来驱动
   （画色块）     （写HID报告）    （发微信）         （自定义）
```

---

## 6. 需要在写代码前敲定的细节（继续讨论）

1. **应用是否需要先注册？** v1 建议：即时报即接受，`app` 字段随意命名（同名覆盖）—— 待最终确认。
2. **驱动如何被发现？** ✅ 已定（2026-09-02）：扫描 `drivers/*/driver.json` 自动发现 + JSON Schema 校验。
3. **驱动是否要过滤状态？** ✅ 已定（2026-09-02）：驱动在 manifest 的 `states` 中声明子集，只响应自己关心的状态。
4. **"无活动"怎么判定？** ✅ 已定（2026-09-02）：**事件驱动 + 状态保持** ——
   应用有变化才上报；无上报 = 不广播 = 驱动保持上次状态；`none` 是显式"恢复默认"信号；TTL 不进 v1。
5. **同状态多应用**：两个 app 都 `completed`，状态机显示 `completed`（聚合），
   仲裁表只描述优先级，不描述来源 —— 暂定，待确认。
6. **上报乱序**：同一 app 快速"completed → decision → completed"，
   v1 按到达顺序处理即可；乱序防护（序号/时间戳）放 M2+ —— 暂定，待确认。

> 这 6 条回答完，M1 的设计就闭环了，我再开 PLAN.md 的"待定项"更新并开始写骨架。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
