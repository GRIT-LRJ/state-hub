# API 层详解（平台对外唯一窗口）

> 对象：零基础。目标：看懂"API 层是什么、里面有什么、怎么工作"。

---

## 0. 一句话

**API 层 = 平台对外的"服务窗口"**：一个 HTTP 服务，
接收应用发来的 JSON 请求 → 转交给平台内部（状态机/Runtime）→ 把结果用 JSON 返回。
应用只跟它打交道，**永远看不到平台内部**（Runtime/驱动/注册表）。

```
应用 ──HTTP+JSON──▶ 【API 层】 ──内部调用──▶ 状态机 ──▶ Runtime ──▶ 驱动
```

---

## 1. API 层里面有什么

| 组成部分 | 干什么 |
|---|---|
| **HTTP 服务器** | 监听 `127.0.0.1:3000`，接收 TCP 连接（这就是"平台在跑"的象征） |
| **路由表** | 一张"路径 → 处理函数"的对照表（`POST /api/events` 由谁处理） |
| **请求解析** | 把 HTTP 请求体里的 JSON 读出来（`req.body`） |
| **参数校验** | 检查 `state` 是否合法、字段类型对不对；不对 return 400 |
| **业务调用** | 调"内部服务"的入口函数（如 `stateMachine.report(...)`） |
| **响应生成** | 把结果包成 JSON + HTTP 状态码返回 |
| **错误处理** | 统一错误格式 `{ "ok": false, "error": "..." }` |
| **日志** | 记录谁调了、参数、耗时、报错（排查用） |
| （以后可选） | 鉴权 token、CORS、限流、前端静态文件托管 |

> API 层**不包含**：驱动逻辑、设备协议、状态机规则本身。
> 它只负责"接客 + 传话 + 回执"。

---

## 2. HTTP 请求的生命周期（一次完整调用）

假设你在终端敲：

```bash
curl -X POST http://127.0.0.1:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{"app":"codex","state":"completed"}'
```

服务器内部发生：

```
1. TCP 连接到达（127.0.0.1:3000）
2. HTTP 解析：方法=POST，路径=/api/events
3. 路由匹配 → 找到对应处理函数
4. 解析 JSON body → { app:"codex", state:"completed" }
5. 校验：state 必须是 completed/decision/none ✅
6. 调状态机：stateMachine.report({app:"codex", state:"completed"})
7. 状态机返回 currentState="completed"
8. 序列化 → { "ok": true, "currentState": "completed" }
9. 响应返回给客户端（curl 看到这段 JSON）
```

---

## 3. v1 的端点（API 层提供的"窗口"）

| 方法 + 路径 | 谁用 | 作用 | 返回示例 |
|---|---|---|---|
| `POST /api/events` | 应用/测试台 | 上报状态 | `{ "ok": true, "currentState": "decision" }` |
| `GET /api/state` | 前端/调试 | 查当前状态 + 各应用状态 | `{ "currentState":"decision", "apps":{"codex":"completed","dsh":"decision"} }` |
| `GET /api/health` | 前端/运维 | 探活 | `{ "ok": true, "version": "0.1.0", "drivers": 1 }` |
| `GET /api/drivers` | 前端（M2） | 驱动列表/在线状态 | `[ { "id":"virtual", "connected":true, "states":[...] } ]` |
| `POST /api/drivers/:id/restore` | 前端（M2） | 手动恢复某驱动 | `{ "ok": true }` |

v1 只做前三个；驱动管理类留给 M2。

---

## 4. 最小示例代码（Express，逐行讲）

```ts
// packages/platform/api-server.ts（v1 草案；这里用 Express，新手最易上手）
import express from 'express';

const app = express();
app.use(express.json());              // ① 解析请求体里的 JSON

// ② 路由：POST /api/events（应用上报）
app.post('/api/events', async (req, res) => {
  const body = req.body ?? {};                        // ③ 拿到请求体
  const appName = body.app;                           //    哪个应用
  const state = body.state;                           //    什么状态

  // ④ 校验：状态必须是标准三个
  if (!['completed', 'decision', 'none'].includes(state)) {
    return res.status(400).json({ ok: false, error: `unknown state: ${state}` });
  }

  // ⑤ 调平台内部：状态机仲裁（业务层）
  const result = stateMachine.report({ app: appName, state });

  // ⑥ 返回结果
  res.json({ ok: true, currentState: result.currentState });
});

// ⑦ 路由：GET /api/state（查当前状态）
app.get('/api/state', (_req, res) => {
  res.json(stateMachine.current());
});

// ⑧ 启动服务器（对外就绪）
app.listen(3000, '127.0.0.1', () => {
  console.log('State Hub API ready: http://127.0.0.1:3000');
});
```

逐行要点：

| 行 | 作用 |
|---|---|
| `express()` | 创建 HTTP 应用对象（Express 帮我们处理底层的 HTTP 细节） |
| `app.use(express.json())` | 以后每个请求自动解析 JSON body |
| `app.post('/api/events', fn)` | 注册"路径+方法"的处理函数（路由） |
| `req.body` | 解析后的请求数据（就是 curl 发的 JSON） |
| `res.status(400).json(...)` | 返回 400 + 错误 JSON |
| `stateMachine.report(...)` | 调业务层（API 层不写规则，只传话） |
| `app.listen(3000, '127.0.0.1')` | 只监听本机，不对外网暴露 |

> 注：`stateMachine` 是另一个模块的对象；API 层通过**内部函数调用**它，
> 不是通过 HTTP 再调一次自己。

---

## 5. API 层"不做什么"（边界）

| 不做 | 谁做 |
|---|---|
| 不认识驱动/设备协议 | 驱动层 |
| 不写状态机规则（优先级） | 状态机（业务层） |
| 不管理驱动加载/生命周期 | Runtime |
| 不持久化业务配置 | 配置/存储（业务层） |
| 不直接写 USB / 发微信 | 驱动 |

---

## 6. 错误约定（跟前端/应用说好）

| 情况 | HTTP 状态码 | 返回体 |
|---|---|---|
| 参数不对（state 非法） | 400 | `{ "ok": false, "error": "unknown state: ..." }` |
| 路径不存在 | 404 | `{ "ok": false, "error": "not found" }` |
| 内部异常 | 500 | `{ "ok": false, "error": "internal error" }` |
| 成功 | 200 | `{ "ok": true, ... }` |

---

## 7. 与前端（浏览器页面）的关系

- 开发时：前端跑 Vite 开发服务器（如 `5173`），通过代理把 `/api` 转发到 `3000`。
- 生产时（以后）：可以把前端打包的静态文件交给 API 层托管，同一个端口提供服务。
- 前端代码里就是：`await fetch('/api/events', { method:'POST', body: JSON.stringify(...) })`。

---

## 8. 新手常见疑问

| 问题 | 答案 |
|---|---|
| 为什么用 JSON 而不是表单？ | JSON 通用、可读、几乎所有语言/工具原生支持 |
| 为什么监听 127.0.0.1？ | 只允许本机访问，安全；以后要跨机再改 0.0.0.0 + token |
| Express 还是 Node 原生 http？ | v1 推荐 Express：代码少、生态成熟、新手友好 |
| 要不要鉴权？ | v1 本机 127.0.0.1 不需要；跨机/公网再加 token（M2+） |
| 应用怎么知道"调用成功"？ | 看返回 JSON 的 `ok` 和 `currentState` |

---

## 9. API 层只服务应用吗？——不是！

**API 层 = 平台对外的"所有 HTTP 客户端"的统一窗口**，包括应用、前端、调试工具、运维探活。

| 客户端 | 会用哪些端点 | 说明 |
|---|---|---|
| **应用**（Codex/DSH） | `POST /api/events` | 只上报状态；应用**只需要这一个端点** |
| **前端**（浏览器页面） | `GET /api/state`、`GET /api/drivers`、`POST /api/drivers/:id/restore`… | 展示 + 管理；M2 后更多 |
| **调试/运维** | `GET /api/health`、`GET /api/state` | 探活、看当前状态 |

所以准确说法是：

- **`/api/events` 是"应用专用"**（别的客户端一般不用）；
- **API 层整体是"平台对外"**——应用、前端、调试都走它；
- **平台内部不走 API**：状态机 ↔ Runtime ↔ 驱动是**内部函数/事件总线调用**，不是 HTTP。
  内部再互相调 HTTP 会多一层没必要的网络往返，还容易出环。

### 一句话记法

> **API 层 = 平台对外的门；应用是来"上报"的客人，前端是来"管理/查看"的客人，调试是来"体检"的客人；内部干活（状态机/Runtime/驱动）不经过这门。**

### 未来要不要拆？

如果应用和管理权限需求变大，可以把 API 层**内部再分两组**（对外仍是一个服务）：

```
/api/events        → 应用专用（以后跨机可加 token）
/api/state         → 前端/调试
/api/drivers/*     → 前端/调试（管理）
/api/health        → 运维
```

v1 不需要拆，先把"对外一个窗口、按路径分工"做出来即可。

---

## 10. API 拿到应用的消息后，怎么告诉状态机？

### 一句话

**API 层把请求体"规范化"成一个事件对象（Event），然后**直接调用**状态机的内部函数：
`stateMachine.report(event)`。**不是再发一次 HTTP**，是同一个进程里的普通函数调用。**

```
[HTTP 请求体 JSON]
   → API 层校验 + 包装成 Event 对象
   → stateMachine.report(event)     ← 内部函数调用（同进程）
   → 状态机记录"每个应用当前状态"
   → 状态机按优先级仲裁 → 返回 { currentState, apps }
   → API 层把 currentState 交给 Runtime.broadcast(...)
   → Runtime 调驱动
```

### Event 对象长什么样（API 层传给状态机的"消息"）

```ts
interface Event {
  app: string;              // 哪个应用（codex / dsh / test-demo）
  state: LightState;        // completed | decision | none
  ts?: number;              // 可选：应用侧时间戳（乱序防护以后用）
  meta?: Record<string, unknown>; // 可选：应用自带的补充信息
}
```

API 层负责"翻译"：`req.body`（可能是任意 JSON）→ 标准 Event。
比如原来是 `{ "app":"codex", "state":"completed", "detail":{...} }`，
API 层校验后变成 `Event { app:"codex", state:"completed", meta:{...} }` 再传给状态机。

### 代码（API 层与状态机怎么连接）

```ts
// api-server.ts
app.post('/api/events', (req, res) => {
  const event = normalizeEvent(req.body);            // 校验 + 转成标准 Event
  const snapshot = stateMachine.report(event);       // ← 关键：内部函数调用！
  res.json({ ok: true, currentState: snapshot.currentState });
});

// state-machine.ts
const stateMachine = {
  // 每个应用当前上报的状态（状态机的"账本"）
  apps: new Map<string, { state: LightState; at: number }>(),

  report(event: Event) {
    this.apps.set(event.app, { state: event.state, at: Date.now() });

    // 仲裁：按优先级找出当前唯一状态
    const currentState = arbitrate(this.apps);       // 如 decision > completed > none

    return {
      currentState,
      apps: Object.fromEntries(this.apps),           // 给前端/日志看
    };
  },
};
```

### 为什么是"直接调用"而不是"再发 HTTP"？

| 方式 | 说明 |
|---|---|
| **直接函数调用**（v1 推荐） | API 层和状态机在**同一个进程**里，`stateMachine.report(event)` 一步到位；简单、快、好调试 |
| **事件总线 emit**（可选项） | API 层 `emit('app/event', event)`，状态机 `on('app/event', ...)` 订阅；解耦更好，但多一层间接 |
| **HTTP 再调用** | ❌ 反对：同进程内部再走网络是没有必要的，还容易绕环 |

v1 设计：**API 层 → 状态机 = 直接函数调用；状态机 → Runtime = 也是直接函数调用**
（`runtime.broadcast(currentState)`）。事件总线留给"驱动反馈前端"这类需要多方监听的场景。

### 状态机到底"拿到"了什么、做了什么

```
拿到：Event { app:"codex", state:"completed" }
做了：
  1. 记账：apps.set("codex", { state:"completed" })
  2. 仲裁：拿整张账本（codex:completed + dsh:none ...）比优先级：
         decision > completed > none
  3. 输出：{ currentState:"completed", apps:{ "codex":"completed", ... } }
```

> 关键认知：**API 层不参与仲裁**。它只负责"把消息变成标准 Event 并转交"。
> **规则在状态机**；"哪个状态优先"是业务层（平台规则/前端可配）的事。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
