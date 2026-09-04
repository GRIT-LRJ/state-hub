# Runtime 常见疑问逐条解答（FAQ）

> 配合 `RUNTIME-DEEP-DIVE.md` 阅读。全部为设计讨论稿，未实现代码。

---

## Q1. JSON Schema 是谁发给谁的？平台定义的还是 Runtime 内部定义的？

**Schema 是平台定义的（作为项目规范的一部分），由 Runtime 持有并使用；驱动只提供"符合 Schema 的数据"。**

准确说法：

- **产生方/定义方**：平台（`state-hub` 项目）定义 Schema 文件，
  比如 `packages/platform/schemas/driver.manifest.schema.json`。
- **持有方/使用方**：Runtime（它是平台的一个组件），启动时读取这份 Schema，
  用它校验每个驱动提交的 `driver.json`。
- **驱动侧**：驱动开发者不需要"拿到 Schema 再发给谁"，只需要**按 Schema 的规则填写 JSON**。
- 类比：平台印了一张"报名表"（Schema），驱动照表填（JSON），
  Runtime 是"收表窗口"，收上来先检查填写是否合规（校验），不合规退回去并说明哪里错。

> 所以：**Schema 不是驱动发给平台的，而是平台公布的规则；驱动给的是数据（JSON）。**
> Schema 与 Runtime 都属平台侧；驱动侧永远只有"数据 + 实现代码"。

---

## Q2. 驱动和 Runtime 之间是否还有一个 Adapter？

**v1 同进程：不需要额外的 Adapter。** 驱动直接实现 `Driver` 接口，Runtime 直接调用它。

- `Driver` 接口本身就是"适配约定"——它已经定义了"插头形状"，
  再包一层 Adapter 反而多余。
- Runtime 可以做一个**薄壳**（把它当成自己内部代码）来处理"错误隔离、状态过滤、日志"，
  但那不是"驱动开发者写的 Adapter"，只是 Runtime 的封装：
  ```
  Runtime 内部（薄壳） → 调用 driver.apply(state)
                           ├─ 过滤：manifest.states.includes(state)
                           ├─ try/catch：失败记 lastError
                           └─ 日志/前端通知
  ```
- **未来跨进程时**：才会出现"传输适配器"（Runtime 侧 client、驱动进程侧 server），
  但 `Driver` 接口方法不变，传输只是"函数调用 ↔ 进程消息"的互换。

> 结论：v1 不要 Adapter；"接口"就是适配器约定本身。只有将来换进程边界/协议时才加传输适配器。

---

## Q3. 什么是应用接口？什么是驱动接口？

| | 应用接口（对外） | 驱动接口（对内） |
|---|---|---|
| 连接双方 | 平台 ↔ 应用（Codex/DSH/测试台） | 平台 ↔ 驱动（虚拟/VK87/PushPlus…） |
| 形式 | HTTP + JSON | TypeScript interface + JSON Schema |
| 例子 | `POST /api/events`、`GET /api/state` | `Driver` 的 `init/apply/status/restore/dispose` + manifest |
| 谁实现 | **Runtime**（HTTP 服务） | **每个驱动** |
| 谁调用 | 应用 | Runtime |

一句话：**应用接口是"顾客的点餐窗口"，驱动接口是"后厨设备的插头规格"。**

---

## Q4. Runtime 为什么是一个 HTTP 服务？

**准确说：Runtime 不只是 HTTP 服务；HTTP 只是它对"应用"的那一扇门。**

Runtime = 驱动宿主 + 状态机调用 + 事件处理 + **对外 HTTP 接口**（应用接口）的组合体。

为什么应用接口选 HTTP：

1. **通用**：Python、Node、curl、浏览器都能调——Codex hooks 脚本、DSH 插件以后都能 POST。
2. **好调试**：浏览器 F12、`curl`、Swagger 都能直接看请求/响应。
3. **跨进程/跨机器**：应用和平台可能不在同一进程，甚至以后不在同一台电脑；HTTP 天然适合。
4. **简单**：本地只监听 `127.0.0.1`，没有额外协议学习成本。

而**驱动接口在 v1 不用 HTTP**：驱动和 Runtime 本来就在同一个 Node 进程里，
直接函数调用最省事；将来要隔离进程才换 WebSocket / stdin-stdout JSON-RPC。

> 结论：Runtime 是"HTTP 服务 + 驱动宿主"的**组合体**；HTTP 只是它对应用的对外窗口，
> 不是它存在的全部理由。

---

## Q5. 状态机算出当前状态后，Runtime 怎么知道该调用哪个驱动？是平台告诉它的吗？

**先说关系：状态机、Runtime 都是"平台"这个整体内部的组件，不是"平台告诉 Runtime"的三方对话。**

推荐 v1 的调用链很简单（同步流程）：

```
HTTP 请求进来
  → handler 解析事件 {"app":"codex","state":"completed"}
  → 调 stateMachine.reduce(event)        // 状态机仲裁
  → 得到 currentState
  → 调 runtime.broadcast(currentState)   // Runtime 调度
```

`runtime.broadcast(state)` 内部怎么知道调谁？——**Runtime 自己持有"驱动注册表"**：

```ts
class Runtime {
  private registry = new Map<string, RegisteredDriver>(); // id → 驱动实例+manifest

  async broadcast(state: LightState) {
    for (const { manifest, instance } of this.registry.values()) {
      if (!manifest.states.includes(state)) continue;   // ← 关键过滤（Q6）
      await instance.apply(state);
    }
  }
}
```

所以：

- **状态机只给 Runtime 一个"状态"**，不告诉它该调谁；
- **"该调谁"由 Runtime 查自己的注册表 + 驱动的 states 声明决定**；
- 你可以把"状态机 + Runtime + HTTP handler"整体理解成"平台"，
  它们是一个程序里的不同职责模块，不是"A 告诉 B"的独立系统。

> 用户理解纠正："平台把支持此状态的驱动告诉 Runtime"——可以简化为这句话，
> 但更精确：**注册表就在 Runtime 里，它自己知道；状态机只负责出"状态"。**

---

## Q6. 驱动怎么声明支持哪些状态？Runtime 如何知道？靠 JSON 吗？——对，靠 JSON

流程：

```
驱动开发者
  ├─ 写 drivers/vk87/driver.json：
  │    { "id":"vk87", "states":["completed","decision"], "stateActions":{...} }
  └─ 写 drivers/vk87/index.ts：实现 Driver 接口（怎么执行动作）

Runtime 启动
  ├─ 扫描 drivers/*/driver.json
  ├─ 按平台 Schema 校验（states 必须是标准状态的子集）
  ├─ 加载驱动实现 → 创建实例
  └─ 注册表存入：{ id, manifest(states...), instance }

事件到来
  ├─ 状态机 → currentState
  └─ broadcast(state)：遍历注册表，看 manifest.states.includes(state)
        命中 → instance.apply(state)
        不命中 → 跳过（驱动保持原状）
```

**所以你的理解基本对**：驱动支持的状态**写进 JSON**；**Runtime 加载时读进注册表**；
广播时**它自己过滤**出该调谁，然后调用对应驱动的方法。
只是"平台"那条线可以更精确地表达为：**平台=状态机+Runtime，注册表是 Runtime 自己的**。

---

## Q7. 虚拟驱动：Runtime 调用过程手把手演一遍

### 场景：虚拟驱动已加载，测试台点击"模拟 Codex 完成"

**第 0 步：驱动文件**（虚拟驱动两件套）

`drivers/virtual/driver.json`：
```json
{
  "id": "virtual",
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

`drivers/virtual/index.ts`（关键部分）：
```ts
export default class VirtualDriver implements Driver {
  constructor(public manifest: DriverManifest) {}

  async init()   { console.log('[virtual] init OK'); }
  async apply(state: LightState) {
    const action = this.manifest.stateActions[state];
    console.log(`[virtual] apply(${state}) -> 色块 ${action.color}`);
    await events.emit('driver/rendered', { driver: 'virtual', state, color: action.color });
  }
  async status() { return { connected: true }; }
  async restore(){ console.log('[virtual] restore default'); }
  async dispose(){ console.log('[virtual] dispose'); }
}
```

**第 1 步：平台启动，Runtime 加载驱动**

```
Runtime: 扫描 drivers/virtual/driver.json
Runtime: Schema 校验 ✅（id、kind、states、stateActions 都合法）
Runtime: import 驱动代码 → new VirtualDriver(manifest)
Runtime: 注册表 registry.set("virtual", { manifest, instance })
Runtime: 调 instance.init()          → 日志 "[virtual] init OK"
前端:    驱动管理页显示"虚拟驱动 · 已连接"
```

**第 2 步：测试台点击"模拟 Codex 完成"**

```
前端:  POST /api/events  {"app":"codex","state":"completed"}
平台:  handler 解析事件
平台:  stateMachine.reduce({app:"codex", state:"completed"})
       → currentState = "completed"            （只有一个应用，直接采用）
平台:  runtime.broadcast("completed")
```

**第 3 步：Runtime 过滤 → 调用（这就是 Q5/Q6 的落地）**

```
Runtime: 遍历注册表（只有 virtual 一个）
Runtime: virtual.manifest.states.includes("completed") → true ✅
Runtime: await instance.apply("completed")
虚拟驱动: 查 stateActions.completed = { color:"#22c55e" }
虚拟驱动: 控制台 → "[virtual] apply(completed) -> 色块 #22c55e"
虚拟驱动: 通知前端 → "driver/rendered"
前端:     测试台色块变成绿色，并显示 currentState=completed
平台:     返回 { ok:true, currentState:"completed" }
```

**第 4 步：再来一个"DSH 等待回答"（看仲裁与过滤）**

```
POST /api/events  {"app":"dsh","state":"decision"}
→ stateMachine 仲裁：decision > completed
→ currentState = "decision"
→ runtime.broadcast("decision")
→ virtual 支持 decision ✅ → 色块变琥珀 #f59e0b
→ 前端显示 currentState=decision
```

**第 5 步：显式恢复默认**

```
POST /api/events  {"app":"dsh","state":"none"}
→ currentState = "none"
→ broadcast("none")
→ virtual.manifest.states 含 "none" ✅ → 色块变 #64748b（或调用 restore）
```

> 若某个驱动（如 v1 的 PushPlus）states 里**没有** "none"，
> 第 5 步时它会被过滤跳过——**保持上次状态**。这正是"事件驱动 + 状态保持"。

**第 6 步：平台关闭**

```
Runtime: 对每个注册驱动调 dispose()
虚拟驱动: "[virtual] dispose"
```

---

### 复盘：这六步里"接口/契约"各在哪一步

| 契约 | 出现在 |
|---|---|
| JSON Schema | 第 1 步（Runtime 校验驱动 JSON） |
| Driver 接口 | 第 1 步实现、第 3/4/5 步被调用 |
| 应用接口（HTTP） | 第 2 步（应用/测试台 POST） |
| 状态机仲裁 | 第 2/4 步 |
| Runtime 过滤机制 | 第 3 步（manifest.states.includes） |

---

## Q8. Runtime 什么时候启动对外的 HTTP 服务？

**答案：平台进程启动（`npm run dev` / `node server.ts`）时，由平台启动流程触发；
推荐顺序是"先备好后厨，再开门营业"——驱动全部就绪后，HTTP 服务才对外监听。**

### 启动时序（推荐）

```
平台进程启动
  1. 读配置（端口、数据目录、是否启用待定）
  2. 打开数据目录（data/）与日志
  3. Runtime 扫描驱动目录
     → Schema 校验 → 加载代码 → 创建实例 → init()（设备/通道就绪）
  4. 状态机初始化（空状态 = none）
  5. Runtime 启动 HTTP 服务        ← 对外就绪（此时才对外开门）
     → 监听 http://127.0.0.1:3000
  6. 打印 ready 信息（端口、已加载的驱动列表、当前状态）
  → 此后应用才能 POST /api/events
```

### 为什么"驱动先就绪、HTTP 后开门"

- 餐厅比喻：**后厨先准备好，再挂"营业中"牌子**。
  如果先开门再接单，客人来了却上不了菜（驱动还没加载完）。
- 若极端情况下必须先开 HTTP，则设计成"未就绪时返回 503"，等驱动加载完再放行——
  但这会多一层状态机，v1 不推荐。
- 启动顺序由**平台入口（server.ts / main.ts）编排**，不是 Runtime 自己"随机启动"。

### 常驻与关闭

- HTTP 服务**常驻**：从启动一直服务到平台进程退出（本地开发时 Ctrl+C 或关窗口退出）。
- 关闭时序与启动相反：
  ```
  停止进程
    → 停止接收新请求（关闭 HTTP 服务）
    → Runtime 对每个驱动调用 dispose()
    → 保存状态/日志
    → 进程退出
  ```

### 常见问题

| 问题 | 表现 | 处理 |
|---|---|---|
| 端口被占用 | 启动报 `EADDRINUSE` | 换端口（配置 `PORT`）或关掉占用程序（和 DSH 的 webserver 行为一致） |
| 驱动 init 失败 | 该驱动显示"未连接"，**HTTP 仍能启动** | 错误隔离：平台照常运行，驱动管理页显示 lastError |
| 应用在 ready 前调用 | 连接被拒（服务未监听） | 正常现象；等 ready 信息后再调 |
| 重启 = 重跑上面全部步骤 | 驱动重新扫描/连接 | 设计上无状态，重新加载 |

---

## Q9. Runtime 对内提供的接口是什么？每个驱动都实现全部吗？

### 9.1 先说清"对内接口"有两类

| 类别 | 方向 | 内容 | 谁必须做 |
|---|---|---|---|
| **契约接口**（Driver Interface） | Runtime 规定 → 驱动实现 → Runtime 调用 | `init/apply/status/restore/dispose` + manifest | **每个驱动必须提供**（可空实现） |
| **运行时服务**（DriverContext） | Runtime 提供 → 驱动选用 | `log / emit / getCurrentState / readConfig` | **驱动可选**，不是必须 |

"接口"这个词容易混：**契约接口是"驱动要交的作业"，运行时服务是"Runtime 给驱动的工具包"。**

### 9.2 契约接口：每个驱动都要实现全部 5 个方法

```ts
interface Driver {
  readonly manifest: DriverManifest;          // 数据：driver.json

  init(): Promise<void>;                      // 启动时：连接设备/初始化
  apply(state: LightState): Promise<void>;    // 状态广播：按 stateActions 执行动作
  status(): Promise<{ connected: boolean; lastError?: string }>;
  restore(): Promise<void>;                   // 恢复默认
  dispose(): Promise<void>;                   // 关闭/卸载：释放资源
}
```

| 方法 | 什么时候被 Runtime 调用 | 不想要时怎么办 |
|---|---|---|
| `init()` | 平台启动加载驱动时 | 空实现 `async init() {}`（无硬件可连） |
| `apply(state)` | 状态机广播时（且 states 声明了该状态） | **必须有实现**（这是驱动的本职） |
| `status()` | 前端刷新/平台查询时 | 返回固定值 `{ connected: true }` |
| `restore()` | 平台/手动调用恢复时 | 空实现（表示"我不关心恢复"） |
| `dispose()` | 平台关闭/卸载时 | 空实现（无资源可释放） |

**所以答案是：每个驱动都要"实现全部 5 个方法 + 提供 manifest"（否则不是合法驱动），
但很多方法可以空实现。** 平台会提供 `BaseDriver` 基类给默认空实现，驱动只写自己关心的部分。

### 9.3 运行时服务（Runtime 提供给驱动的"工具箱"，可选）

```ts
interface DriverContext {
  log(...args): void;                    // 写平台日志（不用自己开日志文件）
  emit(event: string, payload: unknown); // 通知平台/前端（如 "driver/rendered"）
  getCurrentState(): LightState;         // 驱动想查当前整体状态
  readConfig(): unknown;                 // 读自己 driver.json 里 kind 特有配置
}
```

- 驱动**不需要**实现这些；Runtime 在创建驱动实例时把 `ctx` 传给驱动，
  驱动想用就用（比如虚拟驱动调用 `ctx.emit('driver/rendered', …)` 让前端变色）。
- 好处：驱动不需要自己写日志、自己搞前端推送；平台统一提供。

### 9.4 三个容易混的点

1. **"实现全部方法" ≠ "响应所有状态"**：方法全实现（能力），
   但只响应 `manifest.states` 里声明的状态（意图）。比如 PushPlus 实现全部 5 个方法，
   但 `states` 只写 `["completed","decision"]`，那 `none` 事件不会广播给它。
2. **`restore()` 与 `none` 的区别**：`none` 是"一个状态"（走 `apply("none")`，
   需在 states 里声明）；`restore()` 是"平台明确叫它恢复默认"（独立方法，不需要声明）。
3. **契约是统一的**：Runtime 对所有驱动就用这同一套方法调用——这正是"平台不关心设备长什么样"的保证。

---

## Q10. `await events.emit('driver/rendered', { driver: 'virtual', state, color })` 是什么意思？

### 一句话

**驱动在"广而告之"：我要告诉大家（平台/前端），我已经把 `state` 渲染成了 `color`。**
`emit` 是"广播一个事件"，第二个参数是这件事**附带的数据**。

### 拆开看

```ts
await events.emit(
  'driver/rendered',                                  // ① 事件名（给谁听）
  { driver: 'virtual', state, color: action.color }   // ② 事件数据（听的人拿到什么）
);
```

| 部分 | 含义 |
|---|---|
| `events` | 平台内部的一根"广播线"（**事件总线 / EventBus**） |
| `emit(...)` | 发广播：把事件名 + 数据交给所有"订阅了这个事件"的监听者 |
| `'driver/rendered'` | 事件名（命名约定：谁/干了什么；这里=驱动完成了渲染） |
| `{ driver, state, color }` | 载荷（payload）：谁渲染的、什么状态、什么颜色 |
| `await` | "等这次广播被处理完"（若监听者是异步的就得等；同步则可省） |

### 谁在听？—— 前端/日志/其他模块

```ts
// 前端/平台侧订阅：
events.on('driver/rendered', ({ driver, state, color }) => {
  frontend.setSwatch(color);      // 把测试台色块更新成 color
  log(`${driver} -> ${state} = ${color}`);
});
```

这就是"**发布-订阅**"（publish / subscribe）：发送方不直接呼叫接收方，
而是往广播站喊一嗓子；想听的人自己订阅。**发送方不知道、也不需要知道谁在听。**

### 为什么需要它（虚拟驱动的典型场景）

驱动本身**不应该**直接操作前端界面（那是平台的事）。
但虚拟驱动没有真实灯带，前端色块怎么知道"灯变成了什么颜色"？
于是虚拟驱动**发一个事件告诉平台"我渲染了"**，平台/前端收到后更新页面——

```
虚拟驱动 apply("completed")
   └─ events.emit('driver/rendered', { state:"completed", color:"#22c55e" })
        └─ 前端监听 → 色块变绿 + 日志
```

### 与之前概念的对应

- 这是 **DriverContext 里的 `emit`（运行时服务）**：
  Runtime 给驱动提供的"工具箱"，驱动**选用**（不是必须实现）。
- `apply(state)` 是"**平台 → 驱动**"的命令（让驱动执行）；
  `events.emit(...)` 是"**驱动 → 平台**"的反馈（告诉平台我做了什么）。
  两个方向都有，驱动不是只被动听命。

### 实际写法上的小修正

之前 FAQ 里写的 `events.emit` 是**示意**。最终 v1 设计会更明确：

```ts
// 运行时服务（Runtime 传给每个驱动）
ctx.emit('driver/rendered', { driver: 'virtual', state, color });
```

- 事件名不固定，只要是同一平台约定的字符串即可；
- `await` 按设计决定：v1 可以让 `emit` 同步（不需要 await），
  也可以做成"等所有监听器处理完"（异步，需要 await）。**设计定稿时二选一，不会两可。**

---

## Q11. 驱动的 manifest 是什么？就是那个 driver.json 吗？

**对——manifest 就是驱动文件夹里的 `driver.json`（声明文件）。**
它相当于驱动的"身份证/简历"：平台只读这份 JSON 就知道"你是谁、支持什么"，
不需要看你的实现代码。

### 目录结构（驱动两件套）

```
drivers/virtual/
├── driver.json      ← manifest（声明：身份证）
└── index.ts         ← 实现（行为：怎么干活）
```

### 虚拟驱动的 manifest 完整示例

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

| 字段 | 含义 | 类比 |
|---|---|---|
| `id` | 驱动唯一标识 | 身份证号 |
| `name` | 显示名 | 姓名 |
| `kind` | 类型（virtual/hid-keyboard/pushplus…） | 职业 |
| `version` | 驱动版本 | 版本号 |
| `states` | **支持哪些状态**（声明给 Runtime 过滤用） | 我能干哪些活 |
| `stateActions` | **每个状态 → 我做什么**（虚拟=颜色） | 每一门活的具体产出 |

### 三个关系要分清

| 东西 | 是什么 | 谁写 |
|---|---|---|
| **manifest** | `driver.json`，一份 JSON **数据** | 驱动作者 |
| **Schema** | JSON Schema，描述"manifest 必须长什么样"的**规则** | 平台 |
| **实现** | `index.ts`，`class VirtualDriver implements Driver` | 驱动作者 |

Runtime 启动时：读 `driver.json` → 用平台的 Schema 校验 → 通过 → 加载 `index.ts`。
所以：**manifest = JSON 数据；Schema = 规则；实现 = 代码。三者缺一不可。**

---

## Q12. 平台内部的事件总线（EventBus）是什么意思？

### 一句话

**事件总线 = 平台内部的一根"广播线"（通知中心）。**
模块之间不直接喊话，而是：谁有消息就 `emit`（发广播），谁关心就 `on`（订阅）。

```
  [ 发消息方 ] ──emit("事件名", 数据)──▶ [ 事件总线 ] ──▶ [ 订阅方A on(...) ]
                                                  └──▶ [ 订阅方B on(...) ]
```

### 最小代码示例

```ts
const bus = new EventBus();          // 一根广播线（平台内部一个对象）

// 订阅方：我想听"driver/rendered"
bus.on('driver/rendered', ({ state, color }) => {
  console.log(`收到渲染：${state} -> ${color}`);
});

// 发送方：广播事件（自己不需要知道谁在听）
bus.emit('driver/rendered', { state: 'completed', color: '#22c55e' });
// 输出：收到渲染：completed -> #22c55e
```

### 为什么需要它（解耦）

- 没有事件总线：前端要"直接"被驱动调用 → 前端和驱动互相依赖，乱成一团。
- 有事件总线：虚拟驱动只喊"我渲染了"，前端自己订阅。
  **发送方不知道谁在听；接收方不用改发送方的代码。** 以后加新模块只需 `on(...)`。

### 我们平台里的事件流（例子）

```
应用上报        → runtime/event 事件
状态机订阅      → 仲裁 → 广播 state/changed
Runtime 订阅    → 调驱动 apply(state)
驱动 ctx.emit   → 广播 driver/rendered
前端订阅        → 更新色块 + 日志
```

### 和"HTTP 应用接口"的区别（重点）

| | 应用接口（HTTP） | 事件总线（EventBus） |
|---|---|---|
| 通信双方 | 应用 ↔ 平台（**跨进程/可能跨机器**） | 平台内部模块 ↔ 模块（**同一进程内**） |
| 形式 | HTTP 请求/响应 | emit/on 函数调用 |
| 谁用 | 应用（Codex/DSH） | Runtime/状态机/驱动/前端粘合代码 |
| 是否网络 | 是（监听 127.0.0.1） | 否（纯内存） |

> 类比：HTTP = 客人到柜台点餐（跨门）；事件总线 = 后厨内部"对讲机"（同屋）。
> 应用**不直接**连事件总线；前端也不直接连（前端走 HTTP/未来 WebSocket 与平台通信）。

### v1 实现选择（待定稿，先记下）

- 可以用 Node 内置的 `EventEmitter` 直接当事件总线（零依赖）。
- 也可以自封装一个极简 EventBus（约定事件名、错误隔离、日志钩子），便于定契约。
- **推荐自封装薄层**：方便统一事件命名、记录谁发谁收、以后切换到支持 async 的实现。

---

## Q13. 很多驱动的话，是不是都写在一个 driver.json 里？——不是！

**一个驱动 = 一个文件夹 + 一份自己的 `driver.json`。** 不存在"所有驱动写进同一个 JSON"。

### 目录结构（多个驱动）

```
packages/drivers/
├── virtual/                 ← 驱动 1
│   ├── driver.json          ← 只声明 virtual 自己
│   └── index.ts
├── vk87/                    ← 驱动 2
│   ├── driver.json          ← 只声明 vk87 自己
│   └── index.ts
├── pushplus/                ← 驱动 3
│   ├── driver.json
│   └── index.ts
└── 未来键盘/                ← 再装一个，就再放一个文件夹
    ├── driver.json
    └── index.ts
```

Runtime 启动时：**扫描 `drivers/` 下每个子文件夹**，各自读自己的 `driver.json` → Schema 校验 → 加载。

### 为什么"一驱动一份 JSON"

| 好处 | 说明 |
|---|---|
| 归属清晰 | 这份声明只描述它自己，改一个驱动不影响别人 |
| 独立安装/卸载/升级 | 整个文件夹就是一个"驱动包"，移除文件夹=卸载 |
| 独立校验 | 哪个驱动 JSON 错，就只报哪个驱动，不连坐 |
| 可分发 | 以后别人做新键盘，交付一个文件夹就能插进平台 |

### 会不会有"汇总清单"？

可能要，但那是**另一份文件**，不是 manifest：

```
data/platform.json（可选，平台配置）
{ "drivers": { "vk87": { "enabled": true }, "pushplus": { "enabled": false } } }
```

- **manifest（driver.json）**：驱动声明"我是谁、支持什么"——**每驱动一份**，由驱动作者维护。
- **平台配置（可选）**：平台声明"哪些驱动启用、优先级"——**全局一份**，由平台/用户维护。

v1 可以只有 manifest（扫描到即全部加载）；启用/停用/优先级这类"平台清单"留到 M2 前端做了再定。

> 一句话：**很多驱动 = 很多文件夹；每个文件夹里都有它自己的 driver.json；平台扫目录来发现它们。**

---

## Q14. `class Vk87Driver implements Driver` 里的 `Driver` 是什么？为什么不是 `implements Runtime`？

### Driver 是什么？

**`Driver` 是一个 TypeScript 接口（interface）——即"契约/插头规格"，由平台定义。**

```ts
// packages/platform/types/driver.ts   ← 平台定义契约
export interface Driver {
  readonly manifest: DriverManifest;
  init(): Promise<void>;
  apply(state: LightState): Promise<void>;
  status(): Promise<{ connected: boolean; lastError?: string }>;
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
```

- **接口（interface）** = "只有形状、没有实现"的类型约定：它规定"必须有哪些方法、参数、返回值"。
- `class Vk87Driver implements Driver` = **"这个类保证遵守这套契约"**，TypeScript 会在编译时检查：
  你少了 `apply`？报错；`apply` 参数写错？报错。**这就是"合规检查"。**

### 为什么不是 `implements Runtime`？

因为方向**反了**：

| 对象 | 角色 | 类比 |
|---|---|---|
| `Driver`（接口） | 平台定义的**岗位职责** | 司机工作规范（会开车、会停靠…） |
| `Vk87Driver`（类） | 驱动实现这个岗位 | 你考驾照、按规范干活 |
| `Runtime`（类） | 平台内的**调度中心** | 公交公司调度台（不是员工技能） |

**员工（驱动）实现的是"岗位职责（Driver）"，而不是实现"公司（Runtime/平台）。"**
`implements Runtime` 的语义是"这个驱动要变成调度中心"——完全反了。
Runtime 不是"被实现的接口"，它是**被实例化、被使用的服务**：

```ts
// Runtime 是"创建出来、拿去用"的，不是"被驱动实现"的
const runtime = new Runtime({ port: 3000 });
await runtime.start();
```

### 三方角色速记（这次别再反）

| 谁 | 干什么 | 对应代码 |
|---|---|---|
| 平台 | **定义** `Driver` 接口 + Schema | `export interface Driver {...}` |
| 驱动 | **实现** `Driver` 接口 | `class Vk87Driver implements Driver {...}` |
| Runtime | **调用** `Driver` 接口 | `await driver.apply(state)` |

### 完整三段代码（一看就懂）

```ts
// ① 平台：定义契约（一个文件，所有驱动共用）
export interface Driver {
  apply(state: LightState): Promise<void>;
  init(): Promise<void>;
  status(): Promise<{ connected: boolean; lastError?: string }>;
  restore(): Promise<void>;
  dispose(): Promise<void>;
}

// ② 驱动：实现契约（每个驱动一个类）
export class Vk87Driver implements Driver {
  async apply(state: LightState) { /* 写 HID 报告 */ }
  async init() { /* 打开设备 */ }
  async status() { return { connected: true }; }
  async restore() { /* 恢复默认 */ }
  async dispose() { /* 关闭设备 */ }
}

// ③ Runtime：只管调用，不关心具体是谁
const driver: Driver = new Vk87Driver();
await driver.apply("decision");   // Runtime 里就这样调
```

> 补充一个容易混的点：Runtime 确实"提供"了一些东西给驱动，但那是 **DriverContext 工具包**
> （`log/emit/getCurrentState/readConfig`），是"**给驱动用**"的，不是"**让驱动实现**"的。
> **要实现的只有一个：`Driver` 接口（平台定义）。**

---

## Q15. Runtime 里面是什么？

**Runtime 不是一个"单一方法"，而是一个"组件集合"（平台内部的大管家）。** 内部大致有这些模块：

```
Runtime（一个类/一组模块，职责分开）
├── 驱动加载器 DriverLoader      扫描 drivers/*/driver.json → Schema 校验 → import 实现
├── 驱动注册表 DriverRegistry    Map<id, { manifest, instance }>   ← Q2 的花名册在这
├── 调度器 Dispatcher           broadcast(state) → 过滤 states → apply → 错误隔离
├── 事件总线 EventBus             emit/on（内部模块间广播线）
├── HTTP 应用接口 ApiServer      POST /api/events、GET /api/state（对外的那张脸）
├── 状态机调用 StateMachine      仲裁 currentState（平台的大脑，Runtime 请它出结果）
├── 配置 Logger 等               端口/数据目录/日志（基础设施）
└── 生命周期管理 start()/stop()  启动：init 所有驱动；关闭：dispose 所有驱动
```

### 规划的目录（M1 会创建，现在是方案）

```
state-hub/
└── packages/
    └── platform/
        ├── runtime.ts                 ← Runtime 主类（start/stop/broadcast）
        ├── driver-loader.ts           ← 扫描/校验/加载驱动
        ├── driver-registry.ts         ← 注册表（Map）
        ├── event-bus.ts               ← 事件总线
        ├── state-machine.ts           ← 状态机（仲裁）
        ├── api-server.ts              ← HTTP 应用接口
        ├── types/
        │   └── driver.ts              ← 【Q16】Driver 接口在这里
        ├── schemas/
        │   └── driver.manifest.schema.json   ← 校验 driver.json 的规则
        └── config.ts / logger.ts      ← 配置与日志
```

> 一句话：**Runtime = 加载器 + 注册表 + 调度器 + 事件总线 + HTTP 服务 + 生命周期管理**；
> 它是"平台内部把所有零件装起来并指挥运转"的那一层。

---

## Q16. `Driver` 在哪个目录下？

要分清**两个"Driver 相关"的东西**：

| | 位置 | 是什么 |
|---|---|---|
| **`Driver` 接口**（契约） | `packages/platform/types/driver.ts` | 只有方法签名，所有驱动共同遵守（属于平台） |
| **驱动实现**（每个驱动一个文件夹） | `packages/drivers/<id>/index.ts` | `class Vk87Driver implements Driver`（属于各驱动） |
| **manifest 校验规则** | `packages/platform/schemas/driver.manifest.schema.json` | 校验 driver.json 的 Schema |

### 目录树（谁在哪）

```
state-hub/
├── packages/
│   ├── platform/                       ← 平台（包含契约）
│   │   ├── types/driver.ts             ← 【接口】export interface Driver {...}
│   │   ├── schemas/driver.manifest.schema.json   ← 【规则】JSON Schema
│   │   ├── runtime.ts                  ← 【实现】Runtime
│   │   └── ...
│   └── drivers/                        ← 驱动们（每个文件夹一个驱动）
│       ├── virtual/
│       │   ├── driver.json             ← 【数据】virtual 的 manifest
│       │   └── index.ts                ← 【实现】class VirtualDriver implements Driver
│       ├── vk87/
│       │   ├── driver.json
│       │   └── index.ts                ← class Vk87Driver implements Driver
│       └── lan-lamp/
│           ├── driver.json
│           └── index.ts                ← class LanLampDriver implements Driver
```

### 谁 import 谁（方向很重要）

```
drivers/vk87/index.ts
   import type { Driver } from '../../../platform/types/driver'   ← 驱动←平台（契约）
   class Vk87Driver implements Driver { ... }

runtime.ts（platform 内部）
   import type { Driver } from './types/driver'                   ← Runtime←同一份契约
   注册表里存的都是 Driver 类型，调用 driver.apply(...)
```

> 一句话：**`Driver` 接口在"平台"目录（`packages/platform/types/driver.ts`）；**
> **实现它的每个驱动在"驱动"目录（`packages/drivers/<id>/index.ts`）。**
> 现在这些路径是规划方案，M1 写代码时会真正创建。

---

## Q17. "平台承载业务配置，Runtime 协调管理资源，具体执行让 Runtime 执行"——对吗？

### 打分

| 你的说法 | 评价 |
|---|---|
| 平台承载业务配置 | ✅ 基本对（但要说清"配置"具体指什么） |
| Runtime 协调管理资源 | ✅ 对 |
| 具体执行让 Runtime 执行 | ❌ **要改**：Runtime 是"编排执行"，不是"亲手执行" |

### 修正后的三层职责

| 层 | 角色 | 负责 | **不负责** |
|---|---|---|---|
| 应用 | 事件来源 | 上报状态（Codex/DSH/测试台） | 不决策、不操设备 |
| 平台 | 业务规则与配置 | 状态词汇（completed/decision/none）、优先级规则、驱动启用清单、前端"设计"页 | 不亲自调设备 |
| Runtime | 协调/资源管理 | 发现/加载/生命周期驱动、注册表、事件总线、调度、错误隔离、HTTP 应用接口 | **不亲手执行设备动作**；不定义业务规则 |
| 驱动 | 具体执行 | 把状态翻译成动作并**实际执行**（写 HID 报告 / 发微信 / 请求设备 / 显示色块） | 不决策优先级 |

### "执行"要拆成两层（关键）

```
① 平台内部流程的执行   ← Runtime 做
   接 HTTP 请求、解析事件、请状态机仲裁、广播状态、记日志

② 设备/外部动作的执行   ← 驱动做
   写 USB 报告、发起网络请求、发送微信、渲染色块
```

**Runtime 只做 ①，不做 ②。** 如果 Runtime 亲自做 ②，它就必须认识所有设备
（HID 字节、网络协议、微信 API……），那就又回到"平台和驱动耦合"的原点，
违背了我们整个设计的前提：**平台只懂语义，驱动才懂设备。**

- Runtime 是 **导演**（安排谁上场、什么时候上场、出错了怎么处理）；
- 驱动是 **演员**（真正表演——写灯、发微信）。
- Runtime 调 `driver.apply(state)`，但"怎么 apply"是驱动的事。

### 一个例子（decision 到达），职责各在哪

```
应用  ──POST /api/events──▶ Runtime(HTTP接口)      ← ① 平台内部流程
                                  │
                          状态机: decision 优先      ← 平台业务规则
                                  │
                        Runtime 广播 decision       ← ① 调度
                                  │
        ┌──────────────┬──────────────┴──────────────┐
        ▼              ▼                              ▼
   虚拟驱动         VK87驱动                     网络灯条驱动
   (画色块)        (写HID报告)                    (发HTTP请求)    ← ② 驱动执行
```

### 修正后的一句话（建议背这个）

> **平台承载业务配置与规则；Runtime 协调管理资源并编排执行流程；具体设备动作由驱动执行。**
> Runtime 只执行"平台内部流程"（接口、仲裁、调度），**不亲手执行设备动作**。

### 餐厅类比（至此最完整）

| 层 | 类比 | 负责 |
|---|---|---|
| 应用 | 客人 | 点单（上报状态） |
| 平台 | 老板 + 菜单/营业规则 | 定菜品、定规则（业务配置） |
| Runtime | 大堂经理 | 安排人、催菜、处理意外（协调资源）——**不亲自炒菜** |
| 驱动 | 后厨/设备 | 真正做出菜（写设备、发消息） |

---

## Q18. Runtime 不应该暴露给应用吧？HTTP Server 应该放在哪里？——你说得对，修正！

### 结论先行

- **Runtime 只对内（驱动侧），不对外。** 应用永远看不到 Runtime 接口。
- **HTTP Server 是平台单独的一层（API 层 / 应用接口层），不是 Runtime 的一部分。**
- 之前说"Runtime 有一张对外脸"是**我表述不严谨**（把"平台整体"和"Runtime"混在一起了），
  正确说法是：**平台 = API 层 + 业务层 + Runtime(驱动宿主) + 前端**，
  Runtime 只是平台内部的**驱动运行时**，只和驱动打交道。

### 修正后的分层

```
应用（Codex / DSH / 测试台）
   │  HTTP（唯一对外接口）
   ▼
平台（Platform）
 ├── API 层（HTTP Server）      ← 对外：应用接口（给应用用，不是 Runtime！）
 │     POST /api/events   GET /api/state
 ├── 业务层（状态机/配置）       ← 业务规则：状态词汇、优先级、驱动清单
 ├── Runtime（驱动宿主）        ← 只对内：加载/注册/调度驱动、事件总线、错误隔离
 └── 前端（浏览器）             ← 与 API 层通信（HTTP/未来 WebSocket）
        │  Runtime 内部调用
        ▼
驱动（虚拟 / VK87 / 网络设备…）
```

### 谁在这个架构里调用谁（边界清晰版）

```
应用 ──HTTP──▶ [API 层]            （对外边界：平台↔应用）
                    │ 内部调用
                    ▼
              [业务层/状态机]        （业务边界：规则）
                    │ 内部调用
                    ▼
              [Runtime]             （对内边界：平台↔驱动）
                    │ Driver 接口
                    ▼
               [驱动类]             （设备动作执行）
```

### 为什么要这么分

| 边界 | 契约 | 暴露给谁 |
|---|---|---|
| 平台 ↔ 应用 | HTTP API（JSON） | 应用（对外） |
| 平台 ↔ 驱动 | `Driver` 接口 + manifest Schema | 驱动（对内） |
| 平台内部（API→状态机→Runtime） | 内部函数/事件总线 | 谁都不暴露 |

- 应用**不需要知道**平台有 Runtime、有驱动注册表——它只调 `/api/events`。
- Runtime **不需要理解**业务规则（状态优先级），它只负责"驱动管理 + 调度"。
- HTTP Server 放在 **`packages/platform/api-server.ts`**（= API 层），
  Runtime 放在 **`packages/platform/runtime.ts`**（= 驱动宿主），
  两者是**兄弟模块**，由平台入口（`main.ts`）组装。

### 修正后的目录

```
packages/platform/
├── main.ts              ← 平台入口：组装 API 层 + 状态机 + Runtime
├── api-server.ts        ← 【API 层（对外）】HTTP Server：/api/events、/api/state
├── state-machine.ts     ← 【业务层】仲裁规则
├── runtime.ts           ← 【Runtime（对内）】驱动宿主：加载/注册/调度
├── driver-loader.ts
├── driver-registry.ts
├── event-bus.ts         ← 平台内部广播线（API层/状态机/Runtime 都会用）
├── types/driver.ts
└── schemas/driver.manifest.schema.json
```

### 一句话总结（修正版）

> **平台对外只有 HTTP API（API 层）；Runtime 只对内（驱动宿主）；应用永远不接触 Runtime。**

> 以前那个"Runtime 两张脸"的说法作废。今后文档统一：
> **对外=平台 API 层，对内=Runtime（驱动宿主）。**

---

## Q19. 同一进程内的变量（资源）可以共享吗？——可以，但有几个必须懂的坑

### 先给结论

**可以。同一进程里的所有模块（API 层、状态机、Runtime、驱动实例）共享同一块内存空间。**
所以 API 层可以直接把 `stateMachine` 对象传给状态机、直接调用它的方法，
不需要序列化、不需要网络——**这就是"同进程直接函数调用"能成立的根本原因**。

```ts
// 同进程：stateMachine 是同一个对象，API 层直接引用它
const stateMachine = new StateMachine();

app.post('/api/events', (req, res) => {
  const snap = stateMachine.report(normalize(req.body));  // 直接调用，共享同一对象
  res.json({ ok: true, currentState: snap.currentState });
});
```

### "资源"包括什么

同一进程内可共享的：变量、对象、`Map`（注册表）、`EventBus`（广播线）、
日志器、定时器、文件句柄、`Driver` 实例（含它持有的 USB 设备句柄）……都是"资源"。

### 对比：进程之间不能随便共享

| | 同一进程 | 不同进程 |
|---|---|---|
| 内存 | **共享**同一个内存空间 | **各自独立**（隔离） |
| 传递信息 | 直接传对象引用/调用函数 | 只能靠 IPC/网络/文件（序列化） |
| 类比 | 同一块电路板上的芯片（共享总线/寄存器） | 两台设备用线缆通信（协议） |

> 所以未来驱动要独立进程时，Runtime 不能"直接调用"它，只能走 JSON-RPC/WebSocket 消息。
> （接口不变，传输变了——之前 Q14 讲的就是这个。）

### 共享的三个坑（新手必看）

**坑 1：对象是"引用"，不是复制品**

```ts
const a = { state: 'completed' };
const b = a;            // b 和 a 指向同一个对象！
b.state = 'none';
console.log(a.state);   // 'none'  ← a 也被改了！
```

- 想传"一份拷贝"：用 `{ ...a }`（浅拷贝）或 `structuredClone(a)`（深拷贝）。
- 想只读：别把内部对象直接"丢出去"给别人改，给一个 getter/方法。

**坑 2：异步共享状态的"竞态"（race condition）**

JS 是单线程，但 `await` 会让出控制权，两个请求可以交错：

```ts
// 危险例子：两个请求同时操作共享数组
async function handler(req) {
  const cur = await getState();      // await 让出
  if (cur.state !== req.state) {
    setState(req.state);             // 可能覆盖了别人的更"新"状态
  }
}
```

- v1 简化法：**状态机用同步方法**（不给别的模块塞异步读取），
  或在"一次上报"的处理里用**单一模块改状态**（API 层只调 `stateMachine.report`，
  不直接碰内部 Map）。
- 将来复杂了再加"队列/Mutex"（如 `p-queue`、AsyncMutex）。

**坑 3：生命周期——模块卸载后引用还在**

- 如果热重载/停用某个组件，旧的 `Driver` 实例、旧的 `EventBus` 订阅要清理，
  否则"引用还挂着一个已经卸掉的模块"。
- 这就是为什么文档反复强调：**资源的注册/销毁要跟生命周期走**
  （`init ↔ dispose`、`on ↔ off`、`start ↔ stop`）。

### 一个安全共享的习惯（推荐）

> 谁拥有，谁修改。共享的结构（注册表、apps 账本、EventBus）**只让属主模块改**，
> 其他模块通过公开方法访问；不要"export 全局变量到处改"。

```ts
// 推荐：状态机自己持有内部 Map，只暴露方法
class StateMachine {
  private apps = new Map<string, AppState>();   // 私有：别人不能直接改
  report(event: Event) { /* 唯一修改 apps 的地方 */ return this.snapshot(); }
  snapshot() { /* 只读视图 */ }
}
```
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
