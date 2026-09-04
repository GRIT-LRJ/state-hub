# 状态机仲裁算法详解（平台的大脑）

> 目标：把"多个应用各自报的状态"仲裁成**唯一**的当前状态。
> 这是平台最核心的规则，也是"Codex + DSH 同时用不打架"的正解。

---

## 0. 输入 / 输出

```
输入：Event 流（每个应用随时上报）
      { app:"codex",   state:"completed" }
      { app:"dsh",     state:"decision"  }
      { app:"test",    state:"none"      }

输出：{ currentState, winner, apps }
      currentState = 唯一当前状态（如 "decision"）
      winner       = 谁"赢了"仲裁（用于日志/前端提示）
      apps         = 每个应用当前状态的账本（快照）
```

---

## 1. 数据模型：状态机的"账本"

状态机内部维护一张表（`Map`），记录**每个应用当前是什么状态**：

```ts
interface AppState {
  state: LightState;   // completed | decision | none
  at: number;          // 最近一次上报时间（可选，将来做 TTL/乱序）
}

class StateMachine {
  private apps = new Map<string, AppState>();
  // 例如：
  //   "codex" → { state:"completed", at: 1730000000000 }
  //   "dsh"   → { state:"decision",  at: 1730000000200 }
}
```

- 上报 = **记账**：`apps.set(app, { state, at: now })`
- 查询 = **逐项比较**：拿出所有应用的状态，比优先级 → 当前状态

---

## 2. 优先级规则（v1 固定）

```ts
const PRIORITY: Record<LightState, number> = {
  decision: 3,      // 最高：等待用户回答（最"紧急"）
  completed: 2,     // 次之：任务完成
  none: 1,          // 最低：无活动/恢复
};
```

规则：**取"优先级最高"的那个状态作为当前状态。** 平级就保持同状态（聚合）。

> 为什么 decision 最高？因为它代表"系统在等用户"，比"完成了"更需要引起注意。
> 以后这个表会变成**前端可配置**（M2），状态机只是"读规则执行"。

---

## 3. 仲裁算法（核心代码）

```ts
function arbitrate(apps: Map<string, AppState>): { currentState: LightState; winner: string | null } {
  let currentState: LightState = 'none';   // 空账本默认 none
  let bestPriority = 0;
  let winner: string | null = null;

  for (const [app, entry] of apps) {
    const priority = PRIORITY[entry.state] ?? 0;   // 未知状态按 0（不参与）
    if (priority > bestPriority) {                 // 严格大于：平级保持先到
      currentState = entry.state;
      bestPriority = priority;
      winner = app;
    }
  }

  return { currentState, winner };
}
```

处理一次上报的完整方法：

```ts
class StateMachine {
  private apps = new Map<string, AppState>();

  report(event: Event): Snapshot {
    // 1. 记账（同一应用重复上报 = 覆盖，最新为准）
    this.apps.set(event.app, { state: event.state, at: Date.now() });

    // 2. 仲裁
    const { currentState, winner } = arbitrate(this.apps);

    // 3. 返回快照（API 层拿它去广播 + 回给应用）
    return {
      currentState,
      winner,
      apps: Object.fromEntries(this.apps),   // 只读快照
    };
  }

  current(): Snapshot { /* 返回当前快照，不修改账本 */ }
}
```

**为什么代码这么短？** 因为规则就是一句话："看谁优先级最高"。
真正的工作量在规则可配置化、日志、前端展示上。

---

## 4. 工作示例（背下来就懂了）

| 账本（apps） | currentState | winner | 说明 |
|---|---|---|---|
| （空） | `none` | null | 无任何应用上报 |
| codex=completed | `completed` | codex | 单应用 |
| codex=completed, dsh=decision | `decision` | dsh | decision 优先级高 |
| codex=completed, dsh=none | `completed` | codex | none 最低，忽略 |
| codex=completed, dsh=completed | `completed` | codex | **聚合**：同状态不叠加 |
| codex=decision, dsh=decision | `decision` | codex | 同状态聚合，先到为准 |
| codex=none, dsh=none | `none` | codex | 全都不活动 |

---

## 5. 边界情况与设计决策

| 情况 | v1 处理 | 说明 |
|---|---|---|
| 空账本 | `none` | 默认恢复 |
| 未知状态 | API 层校验直接拒绝（400）；状态机**不接** | 保证账本里只有合法状态 |
| 同一应用连续上报 | **后者覆盖前者**（last write wins） | 如 codex 先 completed 再 decision → 变成 decision |
| 多应用同状态 | 聚合（还是那个状态） | 灯/推送只表达一个状态，这是唯一正确行为 |
| 应用停止上报 | **保持最后状态** | 事件驱动+状态保持（无 TTL；要恢复默认请显式上报 none） |
| 并发请求 | v1 状态机**同步方法**；单线程事件循环内不会交错 | 复杂后加队列/Mutex |
| 乱序上报 | v1 按到达顺序；M2+ 加 `ts`/序号防护 | 短时间内快速切换不常见 |
| TTL 自动恢复 | **不进 v1** | 将来可配置（如 10 分钟无事件→none） |

---

## 6. 与 Runtime 的衔接（下一步）

API 层拿到结果后，只做一件事：

```ts
// api-server.ts
const snapshot = stateMachine.report(event);   // ① 仲裁
runtime.broadcast(snapshot.currentState);       // ② 广播给驱动的活交给 Runtime
res.json({ ok: true, currentState: snapshot.currentState, resolution: snapshot.winner });
```

- API 层**不参与仲裁**；状态机**不参与驱动调度**；Runtime **不参与规则**。
- 未来可加 `state/changed` 事件总线消息，让"前端实时刷新""日志""审计"都订阅它。

---

## 7. 可配置化（M2 再做的升级）

把优先级表从"写死在代码里"变成"配置"：

```jsonc
// data/platform.json（前端可改）
{
  "statePriority": {
    "decision": 3,
    "completed": 2,
    "none": 1
  }
}
```

状态机启动时读这份配置；改规则=改一份 JSON + 前端表单，**不用改代码**。

---

## 8. 一句话总结

> **状态机 = 一张"每个应用当前状态"的账本 + 一个"按优先级取最高"的仲裁函数。**
> 应用只管上报；状态机负责"算出一个唯一状态"传给 Runtime；Runtime 只负责广播给驱动。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
