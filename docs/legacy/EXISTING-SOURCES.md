# 现有实现清单（Codex / DSH 状态灯）

> 本项目改造/参考的**现有源码事实**。所有路径为本机路径；新会话可直接引用，无需重新发现。

---

## 1. Codex 状态灯（主参考，已可用）

### 1.1 运行时

| 项 | 值 |
|---|---|
| exe 路径 | `C:\Users\GRIT-LRJ\AppData\Local\CodexKeyboardLight\codex-keyboard-light.exe` |
| 状态文件 | `C:\Users\GRIT-LRJ\AppData\Local\CodexKeyboardLight\state.json` |
| 协议配置 | `C:\Users\GRIT-LRJ\AppData\Local\CodexKeyboardLight\protocol-profile.json` |
| 技术 | .NET（exe + dll + pdb；无源码可读，只能 CLI/黑盒） |

### 1.2 CLI 命令面（`codex-keyboard-light.exe --help` 实测）

```
daemon
hook                          read one Codex hook JSON object from stdin
signal completed|decision --session ID [--turn ID] [--tool NAME]
ack --session ID [--turn ID] [--tool NAME]
restore
status [--json] | devices
test completed|decision|restore | feature-read
profile show|validate|import PATH
paths
```

### 1.3 已实测的事件语义（关键！）

通过给 `hook` 喂 JSON 实测得到：

| hook JSON | 效果 |
|---|---|
| `{"hook_event_name":"Stop","session_id":"A"}` | 给 A 加 `completed` 警示（灯变 completed 色） |
| `{"hook_event_name":"UserPromptSubmit","session_id":"A"}` | **清除 A 的警示**（completed/decision 都清；只清 A，不影响其他会话） |
| `{"hook_event_name":"PreToolUse","session_id":"A","tool_name":"request_user_input"}` | 给 A 加 `decision` 警示 |
| `{"hook_event_name":"PostToolUse","session_id":"A","tool_name":"request_user_input"}` | 清除 A 的 decision |

其他实测事实：

- `ack --session A` **只清 decision，不清 completed**（completed 警示会常驻）。
- `restore` 清空**所有**警示（会同时影响 Codex 会话，谨慎）。
- `test completed|decision|restore` 只应用一次灯态、**不写会话警示**；用于手动验证。
- 多个会话的警示会**聚合**：任一 completed 存在 → desired=completed（decision 优先级更高，需进一步确认）。
- 多会话验证：`UserPromptSubmit` 只清对应会话，不误伤其他会话。

### 1.4 协议配置（protocol-profile.json）

```json
{
  "enabled": true,
  "vendorId": 14154,          // 0x374A
  "productId": 41584,         // 0xA270
  "usagePage": 65535,         // 0xFFFF
  "usage": 2,
  "featureReportLength": 65,
  "reportId": 0,
  "completedReportHex": "00080100040700FF00EC00...",   // 完成（绿色）
  "decisionReportHex":  "000802030407FFA50043...",     // 等待回答（琥珀）
  "restoreReportHex":   "000802020407A02DF922..."      // 默认
}
```

设备实测（`status --json`）：

- `VID_374A / PID_A270 / usagePage 0xFFFF / usage 0x0002 / featureReportLength 65` 是目标可写接口（`isWritableTarget: true`）。
- `protocolEnabled: true, profileStatus: ok`。
- 键盘断开时 exe 保留 pending 状态，重连后自动重放（平台应了解此行为，不必自行重试）。

### 1.5 Codex 侧接线

- `C:\Users\GRIT-LRJ\.codex\hooks.json`：用户级 Codex hooks，把 Codex 事件映射为：
  | Codex 事件 | exe 调用 |
  |---|---|
  | `PermissionRequest`（.*） | `hook` |
  | `PreToolUse`（`^request_user_input$`） | `hook` → decision |
  | `PostToolUse`（.*） | `hook` → 清 decision |
  | `UserPromptSubmit` | `hook` → 清本会话 |
  | `Stop` | `hook` → completed |
  | `SessionEnd`（`^other$`） | `hook` |
  - 均为异步、timeout 5s、fail-open。
  - **本项目未修改过它**（无任何 dsh 字样）。

### 1.6 skill（人可读说明）

- 主文件：`C:\Users\GRIT-LRJ\.agents\skills\codex-keyboard-light\SKILL.md`
- 命令参考：`C:\Users\GRIT-LRJ\.agents\skills\codex-keyboard-light\references\commands.md`
- 包装脚本：`C:\Users\GRIT-LRJ\.agents\skills\codex-keyboard-light\scripts\keyboard-light.ps1`
- 关键约束：运行时仅限该设备可写 HID 集合；勿发明报告字节、勿扩宽设备选择器、勿动固件更新。

---

## 2. DSH 版本（第二参考，当前已停用）

| 项 | 值 |
|---|---|
| 插件源码 | `C:\Users\GRIT-LRJ\.dsh\plugins\dsh-keyboard-light\` |
| 主逻辑 | `lib\index.js`（DSH 事件 → exe `hook` 命令） |
| bundle patch | `cordis.patch.yml` |
| 手诊 skill | `C:\Users\GRIT-LRJ\.dsh\skills\dsh-keyboard-light\SKILL.md` |
| profile 依赖 | `C:\Users\GRIT-LRJ\.dsh\profiles\web\package.json`（`@dsh-external/dsh-keyboard-light`） |
| 停用补丁 | `C:\Users\GRIT-LRJ\.dsh\profiles\web\cordis.patch.yml` 中的 `- id: dsh-keyboard-light / disabled: true` |
| 重新启用 | 删掉 disabled 行 → 重启 DSH；junction 丢失则 `dsh plugin --profile web add C:/Users/GRIT-LRJ/.dsh/plugins/dsh-keyboard-light` |

### 2.1 事件映射（已在 DSH 实机验证）

| DSH 事件 | 发送的 exe hook |
|---|---|
| `agent/status` `running → idle`（回合完成） | `Stop` |
| `agent/status` `idle → running`（新回合开始） | `UserPromptSubmit` |
| `session/event` `tool/call` `ask_user_question` | `PreToolUse` + `tool_name=request_user_input` |
| `session/event` `tool/result`（提问返回） | `PostToolUse` + `tool_name=request_user_input` |

### 2.2 容易踩的坑（已踩过）

1. **`agent/status` 载荷是单参数对象** `{ agent, status }`，不是双参数 `(subject, data)`；
   官方参考：`dsh-compaction-basic` / `dsh-goal-round-driver` 的
   `ctx.on("agent/status", ({ agent, status }) => …)`。
2. `session/event` 是双参数 `(session, event)`。
3. 热重载后 `statuses` 基线清空：重载当次回合结束的 idle 会被当作未知基线跳过，下一轮才恢复。
4. DSH 事件监听要用 host 级 `ctx.on`（官方插件同款），agent-scoped 事件对宿主全局监听器仍可见（未打标签时）。

---

## 3. 与平台化的关系

- 现有 exe 本质上是一个 **"Codex 事件 → VK87 灯带"的专用直连实现**，内部已经隐含了：
  状态语义（completed/decision）、会话聚合/仲裁、HID 驱动、协议报告四层；
  但全部耦合在一起、且只认一个设备。
- 平台化 = 把这四层拆开：
  - 应用层：Codex hooks / DSH 插件改造为"上报事件"（存量代码可先不动，作为参考行为）。
  - 平台层：状态机 + 驱动注册表 + Runtime + 前端（全新，Node/TS）。
  - 驱动层：VK87 驱动（可先**桥接现有 exe**，把 1.2–1.4 的事实封装成驱动实现）。
- **已有事实完全够实现 VK87 驱动**：CLI 命令面、事件语义表、协议配置、报告 hex、设备 VID/PID 全部已知。

---

## 4. 验收线索（后续 M3 用）

- 平台发出 `decision` → 期望看到 `protocol-profile.json` 的 `decisionReportHex` 对应灯色；
- 平台发出 `completed` → `completedReportHex`；
- 平台发出 `none` → `restoreReportHex`；
- 验收命令：`codex-keyboard-light.exe status --json`（看 desiredKind / alerts / lastHardwareMessage）。
> **已废弃：** 本文仅作历史背景，不再具有规范性。请以 `docs/ARCHITECTURE.md` 为准。
