# 驱动实例详解：虚拟 / USB 硬件设备 / 网络设备

> 核心认知：**驱动 = 任何能对平台"状态通知"做出反应的东西**。
> 虚拟驱动、USB 键盘灯、同网段联网灯条、甚至公网 Web 服务——**实现同一个 `Driver` 接口**，
> 只是"反应方式"（stateActions）和"通信方式"不同。

---

## 0. 三种驱动的对比总表

| | 虚拟驱动 | USB/HID 设备（VK87 键盘） | 网络设备（同网段/公网） |
|---|---|---|---|
| 物理对象 | 无（内存里的色块） | 电脑 USB 口接的键盘灯带 | 联网灯条/控制器/Web 服务 |
| 通信方式 | 无（纯内存） | HID feature report（node-hid 直连 USB） | HTTP/WebSocket 请求 |
| 典型库 | 无 | `node-hid`（或 `serialport` 做串口设备） | `fetch` / `ws` |
| 响应动作 | 色块 + 日志 | 65 字节报告 | `POST /api/light {"status":"amber"}` |
| 失败模式 | 几乎不会 | 拔插/被占用/协议不对 | 断网/超时/鉴权失败/设备重启 |

---

## 1. 虚拟驱动（最简单，v1）

- manifest：`kind: "virtual"`，`stateActions` 只放颜色。
- 实现：`apply()` 只会 `ctx.emit('driver/rendered', …)` 通知前端。
- 价值：调试/展示，验证整条链路。

```jsonc
// drivers/virtual/driver.json
{
  "id": "virtual", "kind": "virtual", "version": "0.1.0",
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "color": "#22c55e" },
    "decision":  { "color": "#f59e0b" },
    "none":      { "color": "#64748b" }
  }
}
```

```ts
// drivers/virtual/index.ts（关键方法）
async apply(state: LightState) {
  const action = this.manifest.stateActions[state];
  this.ctx.emit('driver/rendered', { driver: 'virtual', state, color: action.color });
}
```

---

## 2. USB 硬件设备（VK87 键盘灯带，M3 目标）

### 2.1 它本质是什么

- 电脑 USB 口上的一把键盘，有 3 个 HID 接口；我们要写的是**厂商自定义 HID 集合**：
  `VID 0x374A / PID 0xA270 / usagePage 0xFFFF / usage 0x0002`，**65 字节 feature report**。
- 在 Node 里操作它，最直白的库是 **`node-hid`**（Windows/Linux/macOS 都有预编译包）。

### 2.2 manifest（比虚拟驱动多了 device 和报告）

```jsonc
// drivers/vk87/driver.json
{
  "id": "vk87",
  "kind": "hid-keyboard",
  "device": { "vendorId": 14154, "productId": 41584, "usagePage": 65535, "usage": 2 },
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "reportHex": "00080100040700FF00EC00…", "label": "绿色" },
    "decision":  { "reportHex": "000802030407FFA50043…",   "label": "琥珀" },
    "none":      { "reportHex": "000802020407A02DF922…",   "label": "默认" }
  }
}
```

### 2.3 实现（关键方法）

```ts
import { HID } from 'node-hid';

class Vk87Driver implements Driver {
  private device?: HID;

  constructor(readonly manifest: DriverManifest, private ctx: DriverContext) {}

  async init() {
    // 1) 枚举 USB 里的 HID 设备
    const targets = HID.devices().filter(d =>
      d.vendorId === 14154 && d.productId === 41584 &&
      d.usagePage === 0xFFFF && d.usage === 2);
    if (targets.length === 0) {
      throw new Error('未找到 VK87 可写 HID 接口（设备没插/被占用）');
    }
    // 2) 打开目标接口
    this.device = new HID(targets[0].path!);
  }

  async apply(state: LightState) {
    const action = this.manifest.stateActions[state];
    if (!action?.reportHex) return;
    // 3) 十六进制字符串 -> Buffer -> 写 feature report
    this.device!.sendFeatureReport(Buffer.from(action.reportHex, 'hex'));
  }

  async status() {
    return { connected: !!this.device, lastError: undefined };
  }

  async restore() {
    const none = this.manifest.stateActions.none;
    if (none?.reportHex) this.device!.sendFeatureReport(Buffer.from(none.reportHex, 'hex'));
  }

  async dispose() {
    this.device?.close();
    this.device = undefined;
  }
}
```

### 2.4 这个驱动会遇到的问题（都在"驱动内"解决）

| 问题 | 现象 | 驱动怎么做 |
|---|---|---|
| 键盘没插 | `init()` 抛错 | `status()` 返回 `connected:false` + lastError |
| 中途拔掉 | `sendFeatureReport` 抛错 | 捕获 → `lastError`；平台其他驱动照常 |
| 键盘被厂商软件占用 | 打开失败（设备忙） | 记录错误，提示先关掉厂商软件 |
| 协议字节错了 | 灯不亮/乱色 | 只能按 protocol-profile 已验证的 hex 写，别发明报告 |

> 另一个可选路线（M3 再定）：**桥接现有 `codex-keyboard-light.exe`**——
> 平台驱动里用 `spawn` 调它（`signal/…`）而不是自己写 HID；最快，但多一个进程依赖。
> 上面对应的"内化"路线更彻底：平台 Node 直接写报告。

---

## 3. 网络设备（同网段联网灯条 / 控制器 / 任意 HTTP API）

### 3.1 它本质是什么

- 设备有自己的 IP（如 `192.168.1.50`），暴露一个 HTTP API（或将来 WebSocket/MQTT）。
- 平台驱动用 **`fetch`** 往它发 HTTP 请求即可——**不需要插 USB**，它在"同一网段/公网"都行。

### 3.2 manifest（多了 config：endpoint/token；动作变成 HTTP body）

```jsonc
// drivers/lan-lamp/driver.json
{
  "id": "lan-lamp",
  "kind": "network-http",
  "config": {
    "endpoint": "http://192.168.1.50:8080/light",
    "token": "my-secret-token"      // 只存在本地 data/，不进 git
  },
  "states": ["completed", "decision", "none"],
  "stateActions": {
    "completed": { "method": "POST", "body": { "status": "green" } },
    "decision":  { "method": "POST", "body": { "status": "amber" } },
    "none":      { "method": "POST", "body": { "status": "off" } }
  }
}
```

### 3.3 实现（关键方法）

```ts
class LanLampDriver implements Driver {
  constructor(readonly manifest: DriverManifest, private ctx: DriverContext) {}

  private async request(action: any) {
    const cfg = this.manifest.config as any;
    await fetch(cfg.endpoint, {
      method: action.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(action.body ?? {}),
      signal: AbortSignal.timeout(3000),   // 超时：3 秒没回应就算失败
    });
  }

  async init() { await this.health(); }      // 启动时先探活

  async apply(state: LightState) {
    const action = this.manifest.stateActions[state];
    if (!action) return;                     // 没声明就保持原状（过滤已在 Runtime 做）
    await this.request(action);
  }

  async status() {
    try { await this.health(); return { connected: true }; }
    catch (error) { return { connected: false, lastError: String(error) }; }
  }

  async restore() { const a = this.manifest.stateActions.none; if (a) await this.request(a); }

  async dispose() { /* HTTP 无长连接可关；若用 WebSocket 就在这 close() */ }

  private async health() {
    const cfg = this.manifest.config as any;
    await fetch(`${cfg.endpoint}/health`, {
      signal: AbortSignal.timeout(3000),
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    });
  }
}
```

### 3.4 网络设备的问题

| 问题 | 现象 | 处理 |
|---|---|---|
| 设备没开机 | 连接超时 | `status()` 显示未连接；平台照常 |
| 同网段 IP 变了 | 找不到设备 | 以后用 mDNS/DHCP 发现（M2+ 议题） |
| 鉴权失败 | 401/403 | `lastError` 提示 token 不对 |
| 公网设备 | 数据过公网 | 用 HTTPS + token；不推荐明文 |
| 设备崩溃重启 | 短暂断线 | `status()` 探活 + 超时重试（驱动内做） |

### 3.5 未来还有哪些"网络驱动"

- **WebSocket**（长连接实时控制）
- **MQTT / CoAP**（物联网协议，适合大量小设备）
- **mDNS / SSDP 发现**（同网段自动找设备，不用填 IP）
- **PushPlus 通知**（其实也是"网络驱动"的一种：状态 → 调 PushPlus API 发微信）

---

## 4. 全景图（三种驱动同框）

```
┌─────────────────────────── 平台（state-hub）──────────────────────────┐
│                                                                        │
│   应用（Codex/DSH/测试台）──HTTP──▶ Runtime（对外：接单；对内：调度）        │
│                                      │                                │
│                              状态机仲裁 ──▶ currentState                │
│                                      │ apply(state)                    │
│   ┌──────────────┬───────────────────┴────────────────┬──────────────┐  │
│   ▼              ▼                                     ▼              │  │
│ [虚拟驱动]   [VK87 USB 驱动]                    [网络设备驱动（HTTP）]      │  │
│   │              │                                     │              │  │
│   │ ctx.emit     │ node-hid 写 65 字节 feature report  │ fetch POST    │  │
│   ▼              ▼                                     ▼              │  │
│ 前端色块/日志    USB 线 ──▶ VK87 键盘灯带            局域网/公网 ──▶     │  │
│                                                         联网灯条/控制器 │  │
└────────────────────────────────────────────────────────────────────────┘
```

### 同一时刻的"同一状态，三种反应"

假设状态机算出 `decision`：

```
Runtime.broadcast("decision")
 ├── virtual.apply("decision")   → ctx.emit('driver/rendered') → 前端色块变琥珀
 ├── vk87.apply("decision")      → node-hid 写 000802…          → 键盘灯带变琥珀
 └── lan-lamp.apply("decision")  → fetch POST {"status":"amber"} → 联网灯条变琥珀
```

> **平台只喊"decision"；三种驱动各自翻译成自己的动作。** 加的驱动越多，平台代码零改动。

---

## 5. 你要记住的三句话

1. **驱动=反应器**：对平台的状态通知做反应；虚拟/USB/网络只是通信方式不同。
2. **接口不变**：所有驱动都实现 `init/apply/status/restore/dispose`，平台不关心你用的库。
3. **坏驱动不拖平台**：USB 拔了、网络断了、HTTP 401，都是该驱动的 `lastError`；平台和其他驱动照常。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
