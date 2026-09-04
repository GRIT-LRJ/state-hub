# Runtime 深讲：平台接口、调用链与信息传递

> ⚠️ **2026-09-02 修正（重要）**
> 早期表述"Runtime 对外是 HTTP 服务"不准确——**HTTP 应用接口属于平台的 API 层，
> 不是 Runtime；Runtime 只对内（驱动宿主）**。正式定义见 `FAQ-RUNTIME.md` Q18。

> 本文回答四个问题：
> 1. Runtime 到底是什么？
> 2. 每个驱动有自己的 Runtime 吗？
> 3. "平台开放的接口"是什么意思？Runtime 要实现吗？
> 4. Runtime 怎么调用驱动、靠什么传递信息？

---

## 0. 先给一句话答案

- **Runtime 是平台内部的一个组件"驱动宿主"**：负责把所有驱动"装上、点亮、喂状态、管生死"。
- **不是每个驱动一个 Runtime**：平台里只有一个 Runtime，管**所有**驱动；每个驱动有它自己的**实例**（加载后的一份对象/状态），但那不是 Runtime。
- **"平台开放的接口" = 平台公布的两类契约**：给应用用的（HTTP API）和给驱动用的（TS 接口 + JSON Schema）。
- **Runtime 要"实现"的是应用接口（HTTP 服务）；驱动接口（Driver）由驱动实现、由 Runtime 调用。**
- **信息传递**：v1 同进程 = 直接函数调用，传的就是 JS 参数对象；未来隔离 = 进程间消息（JSON-RPC/WebSocket），接口形状不变。

---

## 1. Runtime 是什么（再拆细一点）

### 1.1 先区分三个"运行时"概念

| 名字 | 是什么 | 谁提供 |
|---|---|---|
| **语言运行时**（Node.js / .NET） | 让代码跑起来的环境（事件循环、内存、模块加载） | 系统/平台装了它 |
| **平台的 Runtime**（我们要做的） | 平台内部**管理驱动**的宿主组件 | 我们自己写 |
| **驱动实例**（每个驱动一份） | 某个键盘/微信通道加载后的对象（内存里的一个 class 实例，有自己的连接状态） | 我们写的驱动代码 |

### 1.2 平台的 Runtime 具体干什么

```
平台启动
  → Runtime 扫描 drivers/*/driver.json
  → 用 JSON Schema 校验
  → 加载驱动代码，创建"驱动实例"
  → 调用 driver.init()（连接设备）
  → 记入驱动注册表（id → 实例）
运行中
  → 收到应用上报 → 状态机仲裁出新状态
  → Runtime 找"声明支持该状态"的驱动实例
  → 逐个调用 driver.apply(state)
  → 失败者记 lastError，其他照常
关闭
  → 逐个调用 driver.dispose()
```

---

## 2. 每个驱动有自己的 Runtime 吗？—— 不是

正确的关系是：

```
平台
└── Runtime（一个，全平台共用）
    ├── 驱动实例 A（虚拟驱动）   ← 独立对象，独立连接状态
    ├── 驱动实例 B（VK87 键盘）  ← 独立对象，独立连接状态
    └── 驱动实例 C（PushPlus）   ← 独立对象，独立 token
```

**类比**：车站的调度系统（Runtime）只有一个，但它同时管着所有公交线路；
每条线路有自己的车（驱动实例），车不需要各自带调度系统。

> 未来要做"崩溃隔离"时，可以把某个驱动放进**独立子进程**（进程 A=虚拟、进程 B=VK87）。
> 那时结构是：**Runtime 仍是合并后的一个组件**，只是"调用方式"从直接函数调用变成
> **跨进程消息**（Runtime ↔ 驱动进程）。这仍然不是"每个驱动一个 Runtime"。

---

## 3. "平台开放的接口"是什么意思？

**接口 = 契约**：双方约定好"你按我的形状来，我就按我的形状调你"。
平台开放**两类**接口，方向相反：

### 3.1 对应用开放的接口（对外，平台当"服务员"）

```
应用（Codex/DSH/测试台）
   │  POST /api/events   {"app":"codex","state":"completed"}
   ▼
平台（实现这个 HTTP 接口，解析请求，喂给状态机）
   │  返回 { "ok":true, "currentState":"decision" }
```

- 这里**平台是服务端、应用是客户端**。
- 定义方：平台；实现方：平台（Runtime 里的 HTTP 服务）；调用方：应用。

### 3.2 对驱动开放的接口（对内，驱动当"服务员"）

```ts
interface Driver {
  init(): Promise<void>
  apply(state: LightState): Promise<void>
  status(): Promise<{ connected: boolean; lastError?: string }>
  restore(): Promise<void>
  dispose(): Promise<void>
}
```

```jsonc
// 驱动还要提供"数据接口"：manifest（用 JSON Schema 校验）
{ "id": "vk87", "kind": "hid-keyboard", "states": ["completed","decision"], ... }
```

- **定义方：平台（公布"插槽形状"）**
- **实现方：每个驱动（填 JSON + 写代码）**
- **调用方：Runtime（按接口去调驱动）**

### 3.3 一张表分清"定义/实现/调用"

| 契约 | 谁定义 | 谁实现 | 谁调用 |
|---|---|---|---|
| 应用 API（HTTP /api/events） | 平台 | Runtime（HTTP 服务） | 应用 |
| Driver 接口（TS interface） | 平台 | 每个驱动 | Runtime |
| 驱动 manifest（JSON + Schema） | 平台定 Schema | 每个驱动填 JSON | Runtime 校验并读取 |
| 状态语义（completed/decision/none） | 平台 | 应用上报 / 状态机输出 | 所有驱动 |

---

## 4. Runtime 要"实现"这些接口吗？

**要分清两个方向：**

- **对外（应用接口）**：Runtime **要实现**——它内部就是一个 HTTP 服务，
  把 `POST /api/events` 读进来解析成事件对象。
- **对内（Driver 接口）**：Runtime **不要实现** Driver 的方法（它不会写 HID、不会发微信）；
  Runtime 只负责**按接口调用**驱动。实现者是驱动自己。

> 一句话：**平台定契约；Runtime 是"对外服务员 + 对内调度员"；驱动是"对内服务员"。**

---

## 5. Runtime 如何调用驱动、靠什么传递信息？

### 5.1 v1：同进程，直接函数调用（最简单）

驱动注册表就是一个 `Map<driverId, DriverInstance>`：

```ts
// Runtime 内部（示意）
const drivers = new Map<string, Driver>();

async function broadcast(state: LightState) {
  for (const driver of drivers.values()) {
    // state 过滤：驱动声明了支持这个状态才调用
    if (!driver.manifest.states.includes(state)) continue;
    try {
      await driver.apply(state);        // ← 信息传递 = 函数参数（JS 对象）
    } catch (error) {
      driverRuntime.reportError(driver, error);  // 错误隔离
    }
  }
}
```

**传递的信息是什么？**

- **平台 → 驱动**：只有一个语义参数 `state`（如 `"decision"`）。
  - 驱动自己再查 `manifest.stateActions["decision"]` 找动作（颜色/报告/消息）。
  - 平台**不需要、也不应该**把"颜色、字节、消息文本"传下去——那是驱动自己的事。
- **驱动 → 平台**：完成/失败信号（Promise resolve/reject），以及 `status()` 查询结果。
- **驱动 ↔ 驱动**：不直接通信；全部由平台汇聚（这正是"平台仲裁"的意义）。

### 5.2 v2（以后）：跨进程消息，接口不变

如果某个驱动（比如 VK87 的协议代码）要独立进程跑：

```
Runtime                                 驱动进程
  │  { "method": "apply",                │
  │    "params": ["decision"],  ───────▶ │ 执行 apply("decision")
  │    "id": 1 }                         │
  │  { "result": null, "id": 1 }  ◀────── │
  └（传输：stdin/stdout 或 WebSocket）────┘
```

这是标准的 **JSON-RPC**：方法名、参数、编号。**Driver 接口（apply/status/…）不变**，
变的只是"函数调用"换成了"发一条消息"。这就是"接口稳定、传输可换"的具体含义。

---

## 6. 完整时序（综合）

```
应用                   平台(Runtime)                驱动实例
 │ POST /api/events        │                            │
 │ {"app":"codex",         │                            │
 │  "state":"completed"}    │                            │
 │──────────▶              │                            │
 │                          │ 解析 → 状态机仲裁          │
 │                          │ currentState="completed"   │
 │                          │                            │
 │                          │ broadcast("completed")     │
 │                          │      │ (只调 states 含     │
 │                          │      │  completed 的驱动)   │
 │                          │      ├─────────▶ virtual  │ 画色块
 │                          │      ├─────────▶ vk87     │ 写HID报告
 │                          │      └─────────▶ pushplus │ 发微信
 │                          │                            │
 │ ◀── {ok, currentState} ──│                            │
```

---

## 7. 小结（背下来这三句）

1. **Runtime 是平台的一个组件**（驱动宿主），一个就行，管所有驱动；每个驱动是独立实例。
2. **接口 = 契约**：平台定两种——给应用的 HTTP API、给驱动的 Driver 接口 + Schema；
   Runtime 实现前者、调用后者，驱动实现后者。
3. **信息传递**：v1 直接函数参数（状态语义），v2 跨进程消息（JSON-RPC）；
   平台只传"状态"，动作翻译永远在驱动自己手里。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
