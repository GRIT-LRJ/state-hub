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

发现最后一次调用后崩溃可突破预算，已在领取事务中预先封顶，并补黑盒验收。跨 Issue 集成审查又发现不同绑定/action 的旧批次键可碰撞，已改为元组身份，真实 Core 测试确认两次独立驱动调用。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Critical 0；High 0。`pnpm verify` 通过。

### Commit

`de8b4e6`（本轮前批处理）、`cfe4d86`（本轮恢复边界）、`b5f47f4`（集成碰撞修复）。

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

没有新增 schema。ClaimIdentity 旧格式确认/transition 行不回填，符合本 Issue 不要求正式数据迁移的范围；集成审查发现资源键同类碰撞后，启动时在单个 SQLite 事务中回填旧投影 resource_key，并保留 revision。

### 外部行为是否变化

管理快照中的 `contributorClaimKeys` 改为 JSON 元组字符串。含旧分隔符的 HTTP claim 参数可以分别写入、确认和触发 transition。重复快照错误只返回安全类别。

### 风险

依赖旧 contributor 键文本格式的客户端需把该字段视为不透明身份。旧数据库已有确认记录不再匹配新编码；此兼容边界符合本 Issue 的明确范围。

### 测试

领域测试验证旧碰撞对的新键不同。真实 Core 验收在同一快照 revision 下确认一个 claim，检查另一个仍有效；通过编码 URL 写入两个 claim，观察两次 Virtual Driver 调用；还验证含下划线的 producer 替换快照不清掉另一 producer 的 transition。

### Reviewer 曾发现的问题

发现快照校验仍使用裸拼接，以及 SQL `LIKE` 的下划线通配符会跨 producer 清理。两处已改为精确身份和精确删除。跨 Issue 集成审查进一步确认资源键也能碰撞，已修复并验收两个独立资源的投影及驱动调用。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Critical 0；High 0。`pnpm verify` 四项门禁通过。

### Commit

`ecd9ef6`、`b5f47f4`（跨 Issue 集成修复）。

## Issue #11 — Generic HTTP 精确目标授权

### 这张 Issue 要解决什么

只让 HTTP 驱动访问明确批准的目标，避免一个宽泛开关意外开放本机、内网或云服务元数据地址。

### 原来有什么问题

旧的 `allowPrivateNetwork` 一旦开启，会同时放行所有私网、loopback、link-local 和其他特殊地址；配置者无法只批准一个具体目标。DNS 有多个答案时，旧逻辑在这个开关下也不会阻止危险答案。

### 我改了什么

改用 `privateTargetOrigin`，其规范化后的协议、主机和端口必须与 `baseUrl` 一致。默认拒绝本机、私网和特殊用途地址；具体授权只开放常规私网与 loopback，link-local、metadata 等始终拒绝。每次请求检查全部 DNS 答案，拒绝公网和私网混合解析，只连接本次检查过的 IP。禁止配置覆盖 HTTP Host 头。旧开关即使留在已有配置里也不再产生授权效果。

### 为什么这样改

授权边界应与配置中的唯一目标一致；DNS 和 HTTP 连接必须使用同一次解析结果，才不会在检查后换地址。Host 头也必须与批准目标一致。

### 哪些文件发生变化

`apps/core/src/http-target-policy.ts`、`drivers.ts`、`builtins.ts`、HTTP 策略单元测试、真实 Core 验收测试、原有 HTTP 投递验收配置及 `docs/ARCHITECTURE.md`。

### 数据库是否变化

没有 schema 或迁移。已有 driver 配置若只含旧开关，仍可读取，但对私网目标会安全拒绝投递；管理员需为所需目标配置精确授权。

### 外部行为是否变化

HTTP 驱动的私网授权配置字段变更。未授权投递在发起 HTTP 请求前失败并按现有重试机制处理；准确授权的目标可正常收取投递。管理配置 schema 显示新的字段。

### 风险

依赖旧开关的现有内网投递会暂停成功交付，直到补上精确目标授权。保守的特殊用途地址分类可能拒绝部分有意使用的非公网地址。

### 测试

21 条新增策略/传输测试覆盖 IPv4、IPv6、映射地址、本机、内网、link-local、metadata、特殊用途地址、目标规范化匹配、混合 DNS、DNS 答案变化、固定地址连接与 Host 头。真实 Core 验收先用旧开关投递并断言 HTTP 服务端收到零次请求，再发布精确授权并断言恰好收到一次。原有 append-only、恢复和 retention 的真实 HTTP 测试均已迁移并通过。`pnpm verify` 的四项门禁通过。

### Reviewer 曾发现的问题

复核发现配置可自定义 Host 头，让实际服务按另一个虚拟主机处理；已在请求前拒绝覆盖并加入零请求测试。还补拒绝 IPv6 文档地址和映射形式的 metadata 地址。最终 Critical 0、High 0。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS。

### Commit

`50767f6`。

## Issue #3 — 插件安装、信任与动态 Catalog

### 这张 Issue 要解决什么

让用户明确信任的社区插件能被 Core 安装，其来源、驱动和动作定义可供管理界面查询及后续配置使用。

### 原来有什么问题

插件工具可以打包和验签，但 Core 没有安装记录或 publisher 信任库。管理 Catalog 只返回内置定义，生产者也无法使用社区来源的 JSON Schema。失败包是否会留下部分状态没有可验证的边界。

### 我改了什么

Core 新增持久 publisher 公钥库和插件包记录。管理 API 可以登记 Ed25519 公钥、上传原始插件包、查询安装元数据与动态 Catalog。安装前验证签名、checksum、协议版本、许可证、文件路径、平台入口及定义 JSON Schema；验证完整通过后才用一个 SQLite 事务保存包和版本化定义。社区来源立即进入生产者值校验。正式模式隐藏未签名定义，开发模式必须显式开启。插件 Kit 还限制解压容量、符号链接、ZIP 路径穿越和大小写碰撞。

### 为什么这样改

信任决定和包内容必须先完整验证，才允许定义改变 Core 的行为。把包和定义放在同一个数据库事务中，崩溃或拒绝安装时不会出现半安装记录。动态 Catalog 是后续配置校验、插件执行、升级与卸载共同依赖的接口。

### 哪些文件发生变化

`packages/plugin-kit/src/index.ts`、`apps/core/src/plugin-repository.ts`、`database.ts`、`server.ts`、`schema-validation.ts`、`service.ts`、启动配置与验收 Harness、依赖锁文件、插件 Kit 契约测试、真实 Core 安装验收，以及架构/运行手册。

### 数据库是否变化

新增 `plugin_publishers` 和 `plugin_packages`；旧数据库通过 `CREATE TABLE IF NOT EXISTS` 自动增加。包字节、哈希、manifest 与定义同事务保存；安装元数据不含私钥、管理令牌或生产者 token。

### 外部行为是否变化

新增管理信任、二进制安装、插件列表 API；Catalog 从静态内置列表变为内置加已准许插件。来源注册和 claim 校验可使用安装的 SourceDefinition。环境变量 `STATE_HUB_PLUGIN_DEVELOPMENT_MODE=true` 显式允许未签名定义，仅限开发模式。插件子进程执行属于后续 Issue。

### 风险

已授权管理员上传的插件包会增加 SQLite 占用；上传上限为 128 MiB。开发模式安装的未签名包在正式模式保留安装记录但不进入 Catalog，因此对应来源需回到开发模式或后续替换为可信签名包才能继续使用。

### 测试

插件 Kit 测试验证同一来源两次打包字节一致，拒绝未知 publisher、篡改 checksum、目录穿越、Windows 保留路径、缺许可证与入口，无签名仅开发模式通过。真实 Core API 验收覆盖管理鉴权、信任登记、动态定义和 action contract、生产者 schema 拒绝、重启后持久、坏包不留半成品、错误平台入口及正式/开发模式切换。`pnpm verify` 四项门禁通过。

### Reviewer 曾发现的问题

发现 ZIP 目录项和大小写路径别名可能绕过最初的路径检查，已在解压过滤阶段拒绝。发现开发模式安装的未签名包在正式模式重启后可能仍被读取，已统一 Catalog 与生产者校验的模式策略。发现跨数据库或插件复用 JSON Schema `$id` 可能污染全局编译缓存，已按数据库与实际 schema 隔离编译。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS；Critical 0；High 0。

### Commit

`c42694a`。

## Issue #4 — 独立插件进程与故障隔离

### 这张 Issue 要解决什么

让已安装的社区插件真正以独立进程参与投递。一个插件退出或说错协议时，Core 与其他插件仍能运行，管理员能看到明确状态。

### 原来有什么问题

仓库已有插件包、验签和 JSON-RPC 基础类，但 Core 没有从安装记录启动插件，也不会把插件驱动连接到投递器。进程退出、超时、非法 frame 和未知响应没有真实 Core 的隔离证据。

### 我改了什么

Core 启动或启用插件时重新校验归档和签名，将包释放到受控临时目录，每个启用包运行一个子进程。协议握手核对版本及全部来源/驱动定义，健康检查通过后才投递。插件驱动只收到自己的实例配置和当前投递；异常退出、超时或畸形响应转换为安全原因码，不传播插件的任意输出。禁用会停止进程并移除可用定义；重新启用会启动新进程，并仅向它补发当前 stateful 投影，不补发历史 queued-effect。正常退出和 Core 崩溃重启会清理带标记的运行目录。

### 为什么这样改

进程隔离需要有真实的安装到执行路径，不能只保留未接线的进程工具类。握手、健康和重新验包阻止运行内容与已安装能力不一致。按插件划分故障状态、目录和驱动调用，可让单插件失败不牵连其他输出。恢复时只补发当前状态，避免过期的瞬时提示重新出现。

### 哪些文件发生变化

Core 的 `plugin-runtime.ts`、`plugin-host.ts`、`plugin-repository.ts`、`drivers.ts`、`main.ts`、`server.ts`、`database.ts`；公共 SDK、协议与插件 Kit；插件契约/真实 Core 验收测试；`docs/ARCHITECTURE.md` 与运行手册。验收测试运行器改为线程 worker，维持两个并行 worker 和全部原有用例。

### 数据库是否变化

`plugin_packages` 增加 `enabled` 列，默认启用；旧安装数据库自动增列。启停状态持久化，归档字节和信任记录仍在原表。

### 外部行为是否变化

安装成功后会启动插件进程。新增管理运行状态查询及启用/禁用 API；运行状态只给出包 ID、状态、PID 和稳定原因码。社区驱动现在能通过现有配置与投递路径实际执行。禁用会暂时从 Catalog 移除定义。

### 风险

插件进程会增加内存和启动开销；不遵守公共协议的包会显示故障状态。管理员禁用已有绑定的插件时，该插件输出不可用；重新启用后仅恢复当前 stateful 状态。遭强制终止且完全忽略 stdin 关闭的非 SDK 原生插件，可能需要操作系统处理残留进程；公共 SDK 在 Core 管道关闭时退出。

### 测试

公共协议测试覆盖 framing、长度上限、握手、超时、非法 frame、未知或畸形响应以及启动失败。真实 Core 验收安装两个可信插件，直接统计外部 HTTP 服务收到的请求和子进程 PID；一个插件崩溃时确认另一个继续投递；还验证错误握手/健康状态、禁用启用、当前 stateful 重放、queued-effect 不补发、正常退出清理、Core 强杀后旧 PID 退出和重启目录清理。数据库测试验证已有安装表自动迁移。最终 `pnpm verify` 四项门禁通过。

### Reviewer 曾发现的问题

发现 JSON-RPC 缺少结果与错误时曾被视作成功，已改为协议故障。发现 Windows 大小写别名可覆盖运行目录标记，已拒绝该保留名称。发现重启验收只核对新 PID，没有证明旧子进程退出，已补直接断言。发现重新启用不会恢复已交付的当前 stateful 投影，已只对该插件驱动补发最新投影。首次完整验收的 Vitest fork worker 多次出现 IPC 通道关闭，独立验收可通过；改用官方支持的线程 worker 后，完整四项门禁通过。最终 Critical 0、High 0。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS。

### Commit

`20ed2e4`。
