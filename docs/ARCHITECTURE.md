# State Hub 架构规范

> 本文是 State Hub 唯一规范性架构文档。`docs/legacy/` 中的材料均已废弃；若有冲突，以本文、共享协议类型和可执行测试为准。

## 1. 产品边界

State Hub 是本地优先的**信号路由与输出协调平台**，不是通用工作流引擎。它负责接收状态、匹配绑定、决定每个资源当前应呈现什么，并把动作可靠地交给驱动。首版不提供 LAN 入站、外部 Observer API、任意代码 UI、跨设备云同步或脚本工作流编排。

发行目标为 Windows x64 NSIS、macOS x64/arm64 DMG、Linux x64 AppImage 与 deb。stable v1 必须签名/公证；alpha/beta 可明确标记为未签名。

## 2. 进程与信任边界

```text
Tauri v2 desktop
  ├─ React + Ant Design management UI
  ├─ tray / autostart / single-instance / updater
  └─ supervises Node 24 sidecar, injects an ephemeral admin token
       ├─ Fastify on 127.0.0.1:<random>
       ├─ SQLite WAL: ledger + inbox/outbox + revisions
       ├─ binding/arbitration engine
       ├─ built-in drivers
       └─ one child process per community plugin package
```

生产者持有最小权限 token；管理 UI 使用 Tauri 创建的临时私有会话。社区扩展是故障隔离而非恶意代码沙箱。扩展不可注入 React，只能提供受版本控制的 JSON Schema，由宿主渲染配置界面。

密钥只存 OS credential store，SQLite 仅保存引用。credential store 不可用时依赖密钥的集成必须禁用，绝不降级为明文。日志、历史和支持包在写入前按字段分类脱敏。

## 3. 领域语义

### 3.1 输入

- `StateClaim`：某 producer/scope/signal 的最新事实。`PUT` 幂等覆盖；`clear` 删除事实；可带 TTL 和 stale policy。
- `OccurrenceEvent`：每次都独立成立的瞬时事实，必须有 event id 用于去重。

业务状态由 `SourceDefinition` 的 JSON Schema 定义，不固定为三态。平台只固定四级 urgency：`critical > action-required > informational > ambient`。绑定可覆盖 urgency。

过期策略为 `deactivate`、`demote` 或 `retain`，默认 `deactivate`。确认记录绑定到 claim + revision；是否尊重确认由绑定决定。

### 3.2 绑定与动作

绑定包含输入 selector、结构化条件、安全映射、目标 DriverInstance、resource channel、动作类别和可选顺序。首版不执行用户提供的 JavaScript。

动作类别：

- `stateful`：资源只保留当前投影；设备重连仅重放最新投影。
- `queued-effect`：每次触发，离线默认不重放。
- `append-only`：有界指数退避、TTL、死信和可选批处理窗口。

仲裁按具体 `DriverInstance + resourceChannel` 进行。先比较 urgency，再比较绑定 order，最后比较服务端 revision。同一通道上完全相同的动作合并贡献者。空投影代表 idle；不存在业务层 `restore()`。

通知类 StateClaim 只在值发生转换时触发，重复相同值不触发；OccurrenceEvent 每次触发。

### 3.3 全局暂停

暂停是持久设置。暂停时状态型输出立刻进入 idle/safe，effect/append 被抑制且恢复后不补发；输入账本继续更新。恢复时只重新计算并投递当前 stateful 投影。

## 4. 一致性与数据流

每条写命令在单个 SQLite 事务中完成：验证授权与 schema、幂等检查、写 inbox/ledger、更新投影、写 outbox、提交。只有提交成功才返回 `202`。驱动永远异步执行，不能让慢设备阻塞生产者。

```text
HTTP/CLI/plugin
  -> validate + authorize
  -> SQLite transaction [command, ledger, projection, outbox]
  -> 202 + commandId
  -> dispatcher claims outbox row
  -> driver
  -> delivery attempt/result/dead-letter
  -> SSE snapshot delta
```

SQLite 使用 WAL、foreign keys 和 busy timeout。历史保留滚动 7 天或 100 MB，以先到者为准。状态投影以 revision 防止旧任务覆盖新状态；进程崩溃后 lease 超时的 outbox 会被重新领取。

配置先保存草稿，完整校验并强制预览影响后，原子发布不可变 revision。回滚会创建新的 revision。新绑定立即针对当前 claim 重算 stateful 投影，但不重放历史事件。

## 5. HTTP API v1

Core 只监听 loopback 随机端口，并写 current-user discovery 文件。生产者 API：

- `PUT /api/v1/producers/{producerId}/scopes/{scopeId}/claims/{signalId}`
- `POST .../claims/{signalId}:clear`
- `POST /api/v1/producers/{producerId}/events`
- `PUT /api/v1/producers/{producerId}/snapshot`
- `GET /api/v1/producers/{producerId}/commands/{commandId}`
- `GET /health/live`

每个 token 只能操作自己的 producer；限制 origin、body、scope 数和速率。动态 scope 自动登记但受配额约束。错误使用稳定 machine-readable code。

管理 API 仅供 Tauri 私有会话，包含快照、配置 revision、暂停、确认、凭证引用、诊断与 SSE。UI 断线后先取快照再续订事件，不把 SSE 当事实来源。

## 6. 扩展协议

`.statehub-plugin` 是确定性 ZIP，包含 manifest、schema、checksums、签名、许可证和平台二进制或 TS bundle。正式模式只信任官方 root 或用户明确添加的 publisher；未签名包只在开发模式运行。

运行时为一包一子进程，使用 JSON-RPC 2.0 over stdio，并以 `Content-Length` framing。握手协商协议版本和 capability。更新在旁路进程中验证 schema/migration/health，成功后原子激活；卸载前检查实例与绑定依赖。

## 7. 官方集成

- Virtual Driver：首启向导和测试的默认输出。
- Codex Source：短同步 hook 调用 `state-hub-emit`；CLI 先原子写 spool，再尝试 Core，失败时 fail-open。
- PushPlus Driver：受密钥引用保护的 append-only 通知。
- Generic HTTP Driver：目标必须显式配置；默认拒绝 loopback、link-local、metadata endpoint 和私网，私网需逐目标授权并在解析后再次校验。
- VK87 Driver：仅允许 `VID 0x374A / PID 0xA270 / usagePage 0xFFFF / usage 0x0002`，且只加载校验通过的 65 字节 profile。旧 exe 仅可用于迁移期 shadow/fallback，不是运行依赖。

## 8. 性能、可观测与验收

设计容量：50 sources、50 outputs、500 bindings、持续 100 events/s、突发 1000。接受延迟 P95 不高于 100 ms；驱动启动和 UI 首屏 P95 不高于 1 s。必须有负载测试、崩溃恢复测试、断网/重连测试和三平台真实 smoke。

遥测和崩溃上传默认关闭，需明确 opt-in。支持包生成前展示清单和脱敏预览。

## 9. 交付阶段

1. 合同、monorepo、SQLite 账本与 Virtual Driver 纵切片。
2. Codex Source、CLI、PushPlus。
3. DSH 语义迁移与 VK87 原生 HID。
4. 扩展打包、签名、旁路升级与 SDK。
5. 安装、签名、公证、性能和真实设备/系统验收。
