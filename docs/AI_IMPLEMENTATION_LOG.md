# AI 施工日志

本轮从已有工作树继续实施。PASS 指本地规格、正确性、架构、安全审查和四项基础门禁通过；提交均未推送。

## Issue #13 — Append-only 有界投递和真实批处理

### 这张 Issue 要解决什么

让同一窗口的兼容事件通过一次驱动调用发送，并在故障后按固定预算重试。

### 原来有什么问题

早期 `batchWindowMs` 只延迟单条调用。批处理实现后，review 发现最后一次调用若在写回前崩溃，过期 lease 会导致第九次调用，突破默认八次预算。

### 我改了什么

dispatcher 在领取待处理或过期 lease 时先检查已发起次数。耗尽者直接进 dead-letter；同批次仍有额度的记录继续一起发送。完成、重试、死信仍按 lease 值隔离旧 owner。

### 为什么这样改

预算必须在下一次外部副作用前检查；在驱动返回后检查覆盖不了调用后崩溃的窗口。

### 哪些文件发生变化

`apps/core/src/dispatcher.ts`、`dispatcher.test.ts`、`acceptance/append-only-delivery.acceptance.test.ts`。本轮前的 `de8b4e6` 已提供持久批处理窗口。

### 数据库是否变化

无新增 schema；沿用 delivery 的 attempt、状态和 lease 字段。

### 外部行为是否变化

预算用尽后不再调用驱动，进入可诊断的 dead-letter。远端成功但本地未确认的较早尝试仍采用稳定 identity 的 at-least-once 语义。

### 风险

旧 leased 记录可能在恢复时直接停止，需要结合死信确认远端最终结果。

### 测试

单元测试直接断言最终尝试、混合预算批次和旧 owner 迟到写回的 driver invocation count。真实 Core 验收让 HTTP 第八次请求停在响应前、杀死 Core、等待 lease 过期并重启，确认没有第九次请求。

### Reviewer 曾发现的问题

发现最后一次调用后崩溃可突破预算，已在领取事务中预先封顶，并补黑盒验收。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Critical 0；High 0。`pnpm verify` 通过。

### Commit

`de8b4e6`（本轮前批处理）、`cfe4d86`（本轮恢复边界）。

## Issue #14 — 支持包 Claim 派生数据脱敏

### 这张 Issue 要解决什么

让支持包保留可用运行状态，又不暴露 claim 值、映射动作、凭据和外部响应正文。

### 原来有什么问题

旧逻辑按字段名猜敏感数据；映射到普通字段的值会漏出。旧数据库的自由文本标识、错误和时间也可能原样导出。预览列四个文件，实际只导出一个。

### 我改了什么

支持包按来源构造允许列表：投影保留状态、计数和哈希身份；配置保留安全枚举和数量；历史仅保留受控类别及数值；驱动错误改为状态码或固定摘要。预览清单改为真实单文件。

### 为什么这样改

来源分类覆盖用户自定义字段与旧版本遗留数据；哈希仍可关联不同诊断记录。

### 哪些文件发生变化

`service.ts`、`drivers.ts`、`dispatcher.ts`、`delivery-diagnostics.ts`、`dedupe-identity.ts`、对应单元测试和 `acceptance/diagnostics.acceptance.test.ts`。

### 数据库是否变化

无。导出时对当前和历史记录重新分类。

### 外部行为是否变化

诊断身份从原文变为稳定哈希；HTTP 失败不再保存远端正文；预览准确列出导出的 JSON 文件。

### 风险

依赖原文诊断字段的本地脚本需改用哈希关联；支持人员不再能直接读取 claim/action 内容。

### 测试

真实管理 preview/export API 测试核对响应头文件名，并注入映射 claim、嵌套 header/cookie、邮箱/电话及旧记录自由文本，检查最终序列化无敏感原文。单元测试检查 SQLite attempt、SSE 和支持包无驱动异常正文。

### Reviewer 曾发现的问题

发现旧记录自由文本字段仍可能泄漏，补充哈希、枚举和时间校验；又发现预览与实际导出不一致，已修正并加入响应头断言。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Critical 0；High 0。`pnpm verify` 通过。

### Commit

`5c9992d`。

## Issue #15 — 跨历史数据的保留边界

### 这张 Issue 要解决什么

限制本地历史占用，同时保留恢复与防重必需的最小状态。

### 原来有什么问题

容量清理只统计 history；event、delivery、attempt 和 command 能突破总量。直接删除 command/event 还会让相同幂等键或 eventId 在重启后再次生效。

### 我改了什么

新增统一 retention 服务，以 UTF-8 逻辑字节统计五类历史和轻量防重身份；先按年龄、再按最旧可清理记录收缩容量。保护 `pending`/`leased` 和引用。command 键、eventId 的哈希身份独立持久保存，旧记录在数据库打开时事务性回填。Core 启动和定时维护，无法安全回收时报告超额。

### 为什么这样改

完整 payload 可删除，防重身份必须保留；容量目标不能破坏重试或恢复。

### 哪些文件发生变化

`retention.ts`、`database.ts`、`service.ts`、`config.ts`、`main.ts`、单元/验收测试、`docs/ARCHITECTURE.md` 和 `docs/OPERATIONS.md`。

### 数据库是否变化

新增 `command_dedupe`、`event_dedupe` 及维护索引；启动时回填旧 command/event 身份，不擅定身份到期窗口。

### 外部行为是否变化

历史 payload 清理后相同命令仍返回原 commandId，相同 eventId 不再触发外部请求。无法安全压到预算时 stderr 输出已脱敏的 `state-hub.retention-over-budget`。

### 风险

首次启动回填会扫描现有历史；永久身份本身可能超预算，此时 Core 保留正确性并报告超额。已清理的历史完整 payload 不再可查。

### 测试

可控时间/小容量测试覆盖年龄、跨表容量、最旧优先、未完成引用、外键和重复维护。真实 Core 验收覆盖启动/定时清理、重启后防重、HTTP 请求次数、投影恢复和超预算报告。

### Reviewer 曾发现的问题

发现直接清理 command/event 会破坏幂等与 event 去重；已用独立哈希身份和事务性回填修复。受保护记录不再强删，剩余超额显式报告。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Critical 0；High 0。`pnpm verify` 通过。

### Commit

`4d3c178`。

## 测试基础设施 — Core 冷启动争用

七个验收文件并发运行时多次出现 Core 进程在 20 秒内没有输出或发现文件。将 Vitest worker 上限设为 2 后，单独验收和完整 `pnpm verify` 均通过，未放宽产品断言。Commit：`865bd5d`。


## Issue #7 — 消除 ClaimIdentity 键碰撞

### 这张 Issue 要解决什么

让不同 producer、scope、signal 三元组始终是不同 claim，避免确认或通知转换串线。

### 原来有什么问题

旧身份直接用控制字符拼接。一个 scope 含分隔符与另一个 signal 含分隔符时会得到同一键。快照重复检查也用相同拼接；清理 transition 使用 SQL `LIKE`，producer ID 中的下划线会被当通配符。

### 我改了什么

`claimKey` 改为 JSON 元组编码；快照重复检查使用无歧义的 scope/signal 元组；替换快照时只按 prior claim 的精确键删除 transition。重复快照错误不再回显用户输入的 identity。

### 为什么这样改

JSON 数组编码对合法字符串元组是一一对应的，精确 SQL 键删除不会跨 producer 清理。

### 哪些文件发生变化

`packages/domain/src/index.ts`、`apps/core/src/service.ts`、对应领域/服务测试、`acceptance/claim-identity.acceptance.test.ts` 与验收 Harness。

### 数据库是否变化

没有 schema 或 backfill。本项目当前未要求旧版本正式用户数据迁移；旧格式的确认/transition 行不会与新格式身份混用。

### 外部行为是否变化

管理快照中的 `contributorClaimKeys` 改为 JSON 元组字符串。含旧分隔符的 HTTP claim 参数可以分别写入、确认和触发 transition。重复快照错误只返回安全类别。

### 风险

依赖旧 contributor 键文本格式的客户端需把该字段视为不透明身份。旧数据库已有确认记录不再匹配新编码；此兼容边界符合本 Issue 的明确范围。

### 测试

领域测试验证旧碰撞对的新键不同。真实 Core 验收在同一快照 revision 下确认一个 claim，检查另一个仍有效；通过编码 URL 写入两个 claim，观察两次 Virtual Driver 调用；还验证含下划线的 producer 替换快照不清掉另一 producer 的 transition。

### Reviewer 曾发现的问题

发现快照校验仍使用裸拼接，以及 SQL `LIKE` 的下划线通配符会跨 producer 清理。两处已一并改为精确元组身份和精确删除。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Critical 0；High 0。`pnpm verify` 四项门禁通过。

### Commit

`ecd9ef6`。
