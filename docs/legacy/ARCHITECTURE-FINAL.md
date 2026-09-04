# 最终版架构图（Mermaid）

> 本图是 state-hub 的**最终版架构图**。
> 已包含 2026-09-02 的全部修正：
> - 平台对外只有 **API 层（HTTP）**；
> - **Runtime 只对内（驱动宿主）**，应用不接触；
> - 状态机（业务层）负责**仲裁**；
> - 驱动层实现同一 `Driver` 接口，任意类型（虚拟/USB/网络）。
>
> 复制到支持 Mermaid 的地方即可渲染（VS Code + Mermaid 插件、Typora、mermaid.live 等）。

```mermaid
flowchart TB
    subgraph APPS["应用层（状态来源）"]
        CODEX["Codex"]
        DSH["DeepSeek Harness"]
        TEST["测试台 / 未来应用"]
    end

    subgraph PLATFORM["平台层 state-hub"]
        subgraph APIL["① API 层（对外 · 唯一窗口 · HTTP）"]
            API_E["POST /api/events<br/>应用上报"]
            API_S["GET /api/state<br/>查询当前状态"]
            API_H["GET /api/health<br/>探活"]
            API_D["GET /api/drivers …<br/>（M2 驱动管理）"]
        end
        subgraph BIZ["② 业务层（规则）"]
            SM["状态机 StateMachine<br/>apps 账本 + 优先级仲裁<br/>decision &gt; completed &gt; none"]
            CFG["配置 data/platform.json<br/>优先级表（M2 可配置）"]
        end
        subgraph RT["③ Runtime（只对内 · 驱动宿主）"]
            LOADER["驱动加载器 DriverLoader<br/>扫描 + JSON Schema 校验"]
            REG["驱动注册表 DriverRegistry<br/>Map&lt;id, manifest+instance&gt;"]
            DISP["调度器 Dispatcher<br/>broadcast(state) → 过滤 → apply"]
            BUS["事件总线 EventBus<br/>emit / on"]
            DCTX["DriverContext<br/>log / emit / status / config"]
        end
        subgraph FE["④ 前端（浏览器）"]
            FE1["测试台（色块 + 模拟按钮）"]
            FE2["驱动管理 / 映射 / 状态机视图（M2）"]
        end
    end

    subgraph DRV["驱动层（全部实现同一 Driver 接口）"]
        DRV_V["虚拟驱动<br/>色块 + 日志"]
        DRV_K["VK87 键盘驱动<br/>node-hid 65字节 feature report"]
        DRV_P["PushPlus 驱动<br/>HTTP 发送微信"]
        DRV_L["联网灯条驱动<br/>HTTP / 未来 WebSocket·MQTT"]
    end

    subgraph OUT["外部世界"]
        HW_K["VK87 键盘灯带（USB）"]
        HW_W["微信用户"]
        HW_N["同网段 / 公网设备"]
    end

    APPS -->|"HTTP + JSON（应用接口）"| API_E
    FE1 -->|"fetch /api/state"| API_S
    FE2 -.->|"fetch /api/drivers …"| API_D

    API_E -->|"直接调用 stateMachine.report(event)（同进程）"| SM
    CFG -.->|"规则（M2 可配）"| SM
    SM -->|"currentState"| DISP

    DISP -->|"调 Driver 接口 apply(state)"| DRV_V
    DISP -->|"调 Driver 接口 apply(state)"| DRV_K
    DISP -->|"调 Driver 接口 apply(state)"| DRV_P
    DISP -->|"调 Driver 接口 apply(state)"| DRV_L

    LOADER -.->|"扫描 / 校验 / 加载 / 注册"| REG
    REG -.->|"查询：谁支持该状态"| DISP
    BUS -.->|"内部模块广播"| DISP
    DCTX -.->|"ctx 工具包（给驱动用）"| DRV_V

    DRV_V -->|"ctx.emit('driver/rendered')"| BUS
    BUS -->|"订阅更新"| FE1

    DRV_K -->|"USB HID 报告"| HW_K
    DRV_P -->|"PushPlus API"| HW_W
    DRV_L -->|"HTTP / WebSocket"| HW_N

    classDef appBox fill:#e8f0fe,stroke:#4285f4,stroke-width:1px;
    classDef apiBox fill:#e0f0ff,stroke:#1a73e8,stroke-width:1px;
    classDef bizBox fill:#e6f4ea,stroke:#34a853,stroke-width:1px;
    classDef rtBox fill:#fff3cd,stroke:#f59e0b,stroke-width:1px;
    classDef feBox fill:#f3e8fd,stroke:#9333ea,stroke-width:1px;
    classDef drvBox fill:#fce8e6,stroke:#ea4335,stroke-width:1px;
    classDef outBox fill:#f1f3f4,stroke:#80868b,stroke-width:1px;

    class CODEX,DSH,TEST appBox;
    class API_E,API_S,API_H,API_D apiBox;
    class SM,CFG bizBox;
    class LOADER,REG,DISP,BUS,DCTX rtBox;
    class FE1,FE2 feBox;
    class DRV_V,DRV_K,DRV_P,DRV_L drvBox;
    class HW_K,HW_W,HW_N outBox;
```

---

## 读图指南（按箭头走一遍）

1. **应用上报**：Codex/DSH/测试台 → `POST /api/events`（只能走 API 层）。
2. **仲裁**：API 层直接调用 `stateMachine.report(event)` → 状态机更新账本、按优先级 `decision > completed > none` 算 `currentState`。
3. **调度**：`currentState` 交给 Runtime 的调度器 `broadcast(state)` → 查注册表 → 只对"声明支持该状态"的驱动调 `apply(state)`。
4. **驱动执行**：虚拟驱动画色块（`ctx.emit('driver/rendered')` → 事件总线 → 前端）、VK87 写 USB 报告、PushPlus 发微信、联网灯条发 HTTP。
5. **前端**：与 API 层交互（`/api/state`、M2 的 `/api/drivers`）；驱动反馈走事件总线。

## 边界速查（本图正式版）

| 边界 | 契约 | 谁实现 / 谁调用 |
|---|---|---|
| 应用 ↔ 平台 | HTTP API（JSON） | API 层实现；应用调用 |
| 平台内部（API→状态机→Runtime） | 直接函数调用 | 同进程 |
| 平台 ↔ 驱动 | `Driver` 接口 + manifest Schema | 驱动实现；Runtime 调用 |
| 驱动 → 平台（反馈） | `ctx.emit(...)` / 事件总线 | 驱动可选使用 |
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
