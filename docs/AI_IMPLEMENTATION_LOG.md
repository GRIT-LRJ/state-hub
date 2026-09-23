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

## 跨 Issue 集成审查 — #11、#3、#4（关联 #12）

检查了插件安装与信任、运行进程、驱动投递、配置与诊断的组合行为。真实 Core 的插件隔离、HTTP 目标授权、append-only 恢复、retention、支持包脱敏以及原有配置测试均在 `pnpm verify` 中通过。已知的完整配置契约校验仍归 #10，未当作本轮已完成。

审查发现 Core 停止投递定时器后，在途驱动调用仍可能结束并写回；原关闭顺序会先关闭 SQLite。现在停止时不再领取下一任务，等待当前投递完成后才关闭数据库。新增测试把驱动调用停在半途，确认等待没有提前结束，释放驱动后仅完成这一条，下一条保持待处理。四项门禁重新通过；Critical 0、High 0；修复 commit `c3680eb`。

## Issue #6 — 插件依赖安全卸载

### 这张 Issue 要解决什么

避免用户删除社区插件后，当前配置、来源注册或未完成投递仍指向已经不存在的插件。

### 原来有什么问题

Core 可以安装、启停插件，但没有卸载入口，也没有在删除前核对谁仍在使用插件。直接删除安装记录会留下无法执行的驱动实例、绑定或来源定义，还可能切断 append-only 投递的恢复路径。

### 我改了什么

新增卸载前依赖查询和管理卸载 API。检查所有活动驱动实例、绑定、生产者来源注册，以及旧配置留下的 pending/leased 投递；有依赖时返回 `PLUGIN_IN_USE` 和分类清单。清单中的身份用稳定 SHA-256 表示，不在错误正文回显用户填写的名称。依赖全部解除后先停止该插件进程，再在一个 SQLite 事务中重新检查依赖并删除该插件的所有包版本；其他插件和内置定义保留。安装、启用、禁用与卸载按顺序执行，避免管理请求交错。配置发布也会拒绝移除、禁用或换型一个仍有未完成 append-only 投递的驱动实例；已卸载驱动不能通过旧草稿重新发布。

### 为什么这样改

卸载之前必须知道哪些运行和持久状态还依赖该包。停进程到删除记录之间有崩溃或并发配置变更窗口，因此删除前的第二次检查必须与删除处于同一数据库事务。若 Core 在删除前退出，原安装记录仍在，重启可以照常恢复。允许同一逻辑 DriverInstance 更新配置，以便修复目标授权等问题后让已有 append-only 重试完成。

### 哪些文件发生变化

`apps/core/src/plugin-repository.ts`、`server.ts`、`service.ts`，新增卸载恢复单元测试，扩充真实 Core 插件与配置验收，以及架构和运维文档。

### 数据库是否变化

没有新增 schema 或迁移。成功卸载会原子删除该插件在 `plugin_packages` 中的所有版本；publisher 信任记录独立保留。拒绝卸载或删除前崩溃时，包记录保持完整。

### 外部行为是否变化

管理员可先查询 `GET /api/v1/admin/plugins/:id/dependencies`，再调用 `DELETE /api/v1/admin/plugins/:id`。有依赖时得到 409、稳定错误码和哈希化清单；解除依赖后包从进程状态和 Catalog 消失。生产者可重新注册到其他来源定义来解除来源引用。配置发布若切断在途 append-only 目标会得到 `CONFIG_PENDING_DELIVERIES`；同一实例的配置值更新仍允许。

### 风险

依赖清理可能要求先等待 append-only 投递完成或进入死信，再发布移除实例的配置。历史配置中若曾复用同一个实例 ID，旧待处理投递会保守地阻止卸载，直到该投递结清。管理界面需根据返回的身份哈希定位配置项；#18 的完整管理 UI 仍未完成。

### 测试

真实 Core 验收安装两个可信插件，验证未授权卸载被拒绝、实例/绑定/来源依赖的分类哈希、无原文邮箱泄露、依赖解除后只删除目标插件、另一个插件 PID 与内置 Catalog 不变，并在重启后保持删除。另一条验收在插件收到停止请求后强杀 Core，确认安装记录和进程在重启后恢复；又在停进程窗口发布新依赖，确认删除拒绝且进程恢复；并发启用不会对已删包错误返回成功。单元测试覆盖旧配置已移除实例但仍有 pending 投递的保护，以及配置发布在 append-only 结清前拒绝移除实例。正式模式测试确认开发模式的未签名驱动不能新建配置。最终 `pnpm verify` 四项门禁通过。

### Reviewer 曾发现的问题

发现初版只查当前实例，会漏掉旧配置遗留的在途投递，已追加历史版本引用与 pending/leased 检查。发现卸载后旧草稿仍可发布已删除驱动，已加最小的已安装类型校验。发现停进程期间并发配置或启用请求可能造成半卸载，已在事务中复核并串行化插件管理写操作。发现最初把同一实例的配置值变化也禁止，破坏修复 HTTP 授权后的 append-only 重试；已收窄为只禁止移除、禁用和换型。最终 Critical 0、High 0。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS。

### Commit

`f483cb0`。


## Issue #10 — 配置校验、原子 Revision 与驱动热激活

### 这张 Issue 要解决什么

让管理员在发布配置前知道它是否合法、会影响哪些当前状态；发布成功后，驱动立即采用新配置，回滚仍保留完整历史。

### 原来有什么问题

草稿只检查重复 ID、目标是否存在及少数资源冲突。错误的驱动参数、未声明的动作或不完整的硬件 profile 可以进入已发布配置。相同 ID 的驱动可能继续使用旧缓存；配置发布与正在执行的投递之间也缺少明确边界。直接删除仍有状态投影的实例，会留下重启后继续重试的无目标 idle 投递。

### 我改了什么

草稿和发布现在共用完整的配置校验：检查结构、内置与已安装插件的 JSON Schema、来源/信号/事件和实例引用、动作名称与类别、映射常量、JSON Pointer、物理资源及安全整数。动态映射出的动作在创建投递前再次按驱动动作 Schema 验证；若不符合，整条生产者写事务回滚。内置 Catalog 的标准 ID 现在能实际运行。HTTP 配置拒绝带凭据的 URL、不匹配的私网授权和自定义明文 header；VK87 的选择器与完整报告在发布前校验。

影响预览增加修改过的绑定和当前受影响 claim 数。回滚只接受曾发布的 revision。配置发布先等当前驱动调用结束，再在一个 SQLite 事务内替换 revision、清理旧 stateful 投递并为配置已改变的实例安排当前投影；驱动缓存按实际配置变化失效。移除或停用仍有活动状态的实例返回 `CONFIG_ACTIVE_OUTPUT`，管理员需先移除绑定并让 idle 投递结清；最终移除会清除其旧投影，不让重启重新生成无目标任务。

### 为什么这样改

校验必须发生在发布前，不能把驱动启动失败当作配置错误提示。动态数据只有运行时才知道具体值，因此在事务内补一道动作校验。旧驱动调用与新配置交错会让同一投影 revision 误以为已经送达；等待在途调用并原子安排新投递，消除了这个窗口。移除活动实例先要求进入 idle，可避免把无法再投递的任务留给恢复循环。

### 哪些文件发生变化

新增 `apps/core/src/config-validation.ts` 及其单元测试；修改 `service.ts`、`server.ts`、`drivers.ts`、`builtins.ts`。真实 Core 的配置生命周期、在途热切换验收新增；原有身份、保留、插件安装和批处理夹具改用 Catalog 声明的合法动作。Core 测试脚本改用单 worker，并让 acceptance 在隔离子进程中运行。

### 数据库是否变化

没有新增表、列或迁移。草稿的 `impact_json` 增加绑定更新和受影响 claim 计数；发布事务会抑制旧 stateful 投递、写入新配置当前投影投递，并在安全移除实例时清理其投影。

### 外部行为是否变化

无效配置返回稳定错误码，不回显用户填写的密钥或标识。配置变更后的下一次驱动调用使用新参数；发布在已有调用执行期间会等待该调用结束。标准内置 Catalog ID 可用于 DriverInstance。直接移除活动实例得到 409，需先让输出进入 idle。未发布草稿不能作为回滚来源。新配置不再接受任意 HTTP header 的明文值；旧的 `allowPrivateNetwork` 字段仍不授予访问权限。

### 风险

移除活动驱动需要两次配置操作，管理 UI 应清楚引导。发布可能等待当前驱动调用的有界超时。旧数据库若曾存入自定义 HTTP header，本次不会擅自删除其原值；运行时继续阻断敏感和传输 header，支持包仍进行防御性脱敏。单 worker acceptance 较慢，但保留了全部真实 Core 用例。

### 测试

单元测试逐类验证非法结构、Schema、动作类别、引用、资源冲突、指针、硬件 profile、URL/header 和溢出数值的拒绝；验证动态映射失败时 event、dedupe 和投递均不落库；验证预览能包含只被新 selector 匹配的 claim、失败发布不改变已发布 revision、回滚不能引用草稿，以及安全移除后恢复不再生成旧投递。真实 Core 验收直接统计两个 HTTP 服务收到的请求：同 ID 目标更新与回滚各走正确目标，历史事件不重发，Core 强杀重启后配置和投影仍正确；另一测试把旧 HTTP 调用停在半途，证明发布等它结束后新目标恰好收到一次当前投影。签名插件的合法动作继续验证批次身份不碰撞。最终 `pnpm verify` 四项门禁通过。

### Reviewer 曾发现的问题

Review 发现只在发布时检查映射会漏掉运行时的动态值，已在投递前按 Schema 复核并通过事务回滚。发现 VK87 profile 与 HTTP 明文 header 可通过旧的弱校验，已提前拒绝。发现旧 stateful lease 会挡住新配置当前投影，已增加发布静默边界和原子重新安排。发现直接移除实例会造成重启后的无目标投递，已加入 idle 前置条件及投影清理。发现回滚可引用草稿、预览漏算新 selector 匹配，均已修复。Vitest 线程 worker 的 Windows access violation 已复现；改用单个隔离 fork 后，完整 acceptance 与四项门禁通过。Critical 0、High 0。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS。

### Commit

`df008ce`。


## Issue #5 — 插件旁路升级与原子激活

### 这张 Issue 要解决什么

让管理员升级社区插件时，旧版本在验证期间继续工作；只有新版本和现有数据全部兼容，才一次性切到新版本。

### 原来有什么问题

仓库能安装并运行插件，但无法为已有包安装新版本。直接替换包或停掉旧进程会造成投递空窗；新版本的配置、来源定义或动作若不兼容，还可能留下无法执行的绑定和待处理投递。

### 我改了什么

新增插件升级管理 API。新包先经过原有签名与可信 publisher 校验，再在独立的旁路进程里完成定义 Schema、协议握手、健康检查及配置迁移。迁移只收到本插件的 DriverInstance 配置，返回时必须保持相同实例身份。Core 检查新定义能继续接受现有绑定、生产者来源、活动 claim 和未完成投递。验证期间旧进程照常服务；最终切换前先等在途驱动调用结束，随后在同一个 SQLite 事务中激活新包并发布迁移后的不可变配置 revision，然后把投递所有权交给新进程。失败保留旧版本和配置。管理 API 能在重启后查询最近一次升级的状态及安全原因码。

### 为什么这样改

插件版本和配置 revision 必须作为一个持久状态变更提交，否则崩溃可能出现“新包配旧配置”或相反的状态。外部投递不能放进 SQLite 事务，因此切换窗口先暂停领取、等待旧调用结束；数据库提交后在同一事件循环中交换进程，恢复时只认数据库中的活动版本。对迁移结果限制实例身份，是为了防止一个插件改动其他插件的配置。待处理动作和现有来源数据也属于升级必须保护的状态。

### 哪些文件发生变化

Core 的插件仓库、进程监督、升级兼容检查、管理 API、配置发布和验收夹具；SDK 与协议新增迁移 RPC。新增真实 Core 升级验收和迁移越权、待处理动作单元测试；更新 `docs/ARCHITECTURE.md` 与 `docs/OPERATIONS.md`。Windows 验收 worker 的分批脚本作为独立测试基础设施提交。

### 数据库是否变化

没有新增表、列或 backfill。已有 `plugin_packages` 的活动标志和 `config_revisions` 在一个事务中更新；旧包版本保留为非活动记录。升级成功或失败的安全摘要记入现有 history 表。事务失败时活动包、配置 revision、绑定和实例一同回滚。

### 外部行为是否变化

管理员可用 `POST /api/v1/admin/plugins/:id/upgrade` 上传新版本，用 `GET /api/v1/admin/plugins/:id/upgrade-status` 查看最近结果。插件 SDK 可实现 `migrateDriverConfigs`；未实现时默认原样返回本包配置，再由新 Schema 检查。升级成功后新进程使用迁移配置，当前 stateful 投影可重新投递；历史 queued-effect 不补发。停用插件须先启用再升级。失败响应只提供稳定错误类别，不回显插件返回的任意文本或配置值。

### 风险

切换会等待旧版在途驱动调用完成；旧版停止若超时，新版仍保持所有权和正确状态。新版本若删掉仍被引用的来源、收紧活动 claim 的 Schema 或使待处理动作失效，升级将保守拒绝，管理员需先处理依赖。插件迁移代码来自已准许的 publisher；它获得本插件实例配置，故 publisher 信任仍是安全边界。

### 测试

真实 Core 验收逐一触发非法包、配置 Schema 不兼容、来源 claim 不兼容、迁移异常、迁移越权结果、握手不兼容和健康失败，确认旧包、绑定与配置不变且失败原因可查询。候选迁移被人为阻塞时发送事件，直接统计旧进程发出的 HTTP 请求；成功切换后再统计新版请求、迁移后的配置和重启后的行为。旧进程停止超时不会把新进程误报为失败。另一条验收在 SQLite 提交后的切换点强制 Core 退出，重启检查新包与新配置一致，事件仅产生一次外部请求。单元测试证明新动作契约不能损坏待处理投递，迁移不能修改其他插件实例；跨 Issue 集成测试还验证旧配置中已移除实例的未完成投递仍会阻止升级。最终 `pnpm verify` 的四项门禁全部通过；真实 Core 验收共 15 个文件、32 个测试。

### Reviewer 曾发现的问题

发现活动 claim 可以通过生产者注册绑定来源而不填写 `sourceType`，初版兼容检查漏掉了这类 claim；现按注册来源重新校验。发现旧进程停止超时后的迟到回调可能覆盖新版运行状态；现按进程所有权代次拦截，并以真实超时验收证明。发现损坏包的失败最初只在单次 HTTP 响应里可见；现连验包失败也写入可在重启后查询的安全摘要。跨 #5/#6/#10 集成审查又发现初版只检查当前实例，旧配置遗留的 pending 投递可失去驱动定义；现从已发布和被替代的配置追踪历史实例并保守拒绝此类升级。完整验收在 Windows 长时间复用同一 Vitest fork 时两次固定位置断线；后续文件单独全部通过，改成自动发现并每五个文件启用新 fork 后，完整正式门禁通过。最终 Critical 0、High 0；Medium 0、Low 0。

### 最终状态

PASS；Spec PASS；Correctness architecture PASS；Security PASS；Crash/Recovery PASS。

### Commit

产品实现 `348f1a9`；集成修复 `df8f9f2`；验收基础设施 `ce22ccf`。


## Issue #16 — 桌面 Sidecar 监督和可靠 SSE 重连

### 这张 Issue 要解决什么

让桌面应用在 Core 意外退出或事件流中断后自己恢复，并确保每次连接都先读取完整的当前状态，再开始监听变化。

### 原来有什么问题

Tauri 只启动一次 Core；Core 崩溃后桌面不会重启它。界面同时启动快照请求和 SSE，可能先处理事件再拿到基线；SSE 结束后也没有完整的重连循环。Tauri 的 ready 事件还把管理令牌一起广播给窗口监听器。

### 我改了什么

Tauri 现在监督 sidecar：每次启动分配新的私有管理令牌和代次，核对 ready 消息属于当前子进程；异常退出或启动失败后按 250、500、1000、2000 毫秒退避，连续第五次失败停止自动重启，稳定运行 30 秒后重新计算失败预算。应用退出会结束子进程；若宿主意外消失，受监督 Core 会在 stdin 断开时自行退出。事件只广播代次和安全原因码，管理令牌仍由私有命令提供。

桌面连接循环对每次初连和重连先取权威快照、核对 Core 代次，再订阅 SSE。SSE 的初始 snapshot 和后续事件只触发重新取快照；断流、启动失败或快照失败会清除旧画面并持续有界退避重试。迟到的旧代次快照不会覆盖新状态。Core 若随机监听到浏览器禁用的端口，会关闭该监听并重新申请，避免服务已 ready 但 WebView 无法访问。

### 为什么这样改

SQLite 和 Core HTTP 快照是状态事实源，事件流只通知“需要再读一次”。明确的连接周期和代次检查让重连不会沿用旧令牌或旧状态。sidecar 的有限重启预算防止持续失败时无限生成进程；父管道断开则覆盖宿主异常退出的清理窗口。随机端口必须能被 Fetch 使用；[WHATWG Fetch 的端口阻断规则](https://fetch.spec.whatwg.org/#port-blocking)包含 Windows 可能分配的 6666 等端口。

### 哪些文件发生变化

Tauri 的 `supervisor.rs` 与 `lib.rs`，桌面 `connection-loop.ts`、`api.ts`、`App.tsx`，Core 的 `main.ts` 与 `fetch-safe-listener.ts`；真实 Core 验收夹具、桌面单测和验收测试。仓库测试脚本现在运行桌面验收。Windows acceptance runner 的每文件新 fork 调整作为独立基础设施提交。

### 数据库是否变化

没有 schema、migration 或 backfill。Core 重启继续使用已有 SQLite 和 discovery 机制；本 Issue 只改变进程、HTTP 监听及界面连接生命周期。

### 外部行为是否变化

桌面在 Core 暂不可用时显示断连并自行重试；Core 恢复后重新读取快照。SSE 断开不再使界面长期停在旧值。Core 的 ready 事件不再携带令牌；私有 `core_connection` 命令新增代次。随机端口如果落入 Fetch 禁用列表，会在写 discovery 前重新选择。连续五次快速 sidecar 失败后停止自动重启，需要重新启动桌面应用。

### 风险

更频繁的快照请求会增加少量本地 HTTP 负载，事件刷新已合并串行执行。重启上限可能在持续的外部启动故障期间要求用户重启桌面；这符合本 Issue 的有界策略。真实 Core 进程与桌面连接循环已联合验收，原生 GUI 安装包与三平台 smoke 属 #23 的后续验收。

### 测试

桌面单测验证快照先于订阅、SSE 初始通知和断流后的多次重连、启动失败后恢复、旧代次迟到结果被丢弃，且不显示不可信错误文本。真实 Core 验收在快照与 SSE 之间写入 claim，确认初始 SSE 通知补上竞态；强杀 Core 后重新取得新快照。另用父管道关闭验证 Core 退出且可再次启动。Rust 单测验证 ready 消息的 PID/端口校验和连续失败的退避及上限，`cargo test --lib` 2/2、`cargo fmt --check` 通过。禁用端口单测强制分配 6666 和 10080，验证关闭、重选和耗尽上限。最终 `pnpm verify` 四项门禁通过；Core 单测 73/73、Core acceptance 15 文件 32/32、桌面单测 5/5、桌面 acceptance 2/2。

### Reviewer 曾发现的问题

Review 发现快照到订阅的空窗必须借助 SSE 初始 snapshot 事件重新取快照，已加入解析与真实 Core 竞态验收；还补了启动失败后恢复用例。最终门禁一次碰巧由 Windows 分配端口 6666，Core ready 但 Fetch 报 `bad port`；直接用本地 HTTP 服务复现并对照 Fetch 标准后，加入禁用端口重选和有界测试。Windows Vitest 复用 fork 仍偶发 `ERR_IPC_CHANNEL_CLOSED`；各文件单跑通过，改成每文件新 fork 并重新完成全部正式门禁。原生编译发现一个 Rust 锁守卫生命周期错误，已修复并重跑 Rust 测试。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS。

### 最终状态

PASS。

### Commit

产品实现 `49e9745`；验收基础设施 `2665147`。


## Issue #17 — 来源、凭据引用与 PushPlus 管理

### 这张 Issue 要解决什么

让用户在桌面里给一个来源创建或撤销独立的生产者 Token，把 PushPlus 密钥放进操作系统凭据库，并通过引用配置通知输出；使用者无需编辑数据库，也不需要把密钥写入配置文件。

### 原来有什么问题

Core 已能创建 Token 和投递 PushPlus，但桌面没有通用来源、凭据和 PushPlus 管理入口。桌面的 Rust keyring 依赖没有启用平台后端，保存操作实际落在进程内 mock store，Core 无法读取。凭据读取异常可能使投递失败细节包含不受信任文本；PushPlus 只检查 HTTP 状态，会把 HTTP 200 内的业务错误误记为成功。

### 我改了什么

新增桌面来源管理面板：列出来源定义和已有生产者，为选定来源创建或轮换最小权限 Token，只在本次操作显示明文，并可撤销。凭据面板保存、替换、查询存在性和删除引用，不提供读取密钥的界面命令。PushPlus 面板通过已有配置导出、草案预览和发布流程绑定生产者事件与凭据引用，同时保留其他输出。Core 新增仅管理员可用的生产者列表、撤销 API，列表不返回 Token 或 hash。

Tauri 的 keyring 明确启用 Windows、macOS、Linux 系统后端，操作失败只返回固定错误码。PushPlus 在凭据缺失或读取失败时不发起 HTTP 请求；传输异常也只记录安全类别。按 [PushPlus 官方返回码](https://www.pushplus.plus/doc/guide/code.html)检查成功响应中的业务码：200 才算被服务端接受，500 可重试，令牌无效、账号受限等明确拒绝进入死信；异常响应按有限重试处理，不保存远端任意正文。配置校验允许带精确 origin 授权的本地测试端点，默认仍使用官方地址。

### 为什么这样改

Token 限定到单一生产者和来源，泄露后可以独立轮换或撤销。SQLite 只需持久化凭据引用，密钥从系统存储直接提供给驱动。缺失和故障路径在外部调用之前关闭，避免明文降级或误发送。PushPlus 的 HTTP 成功仅代表传输成功，官方业务码才表明请求被接受；固定错误类别既可观察也避免远端正文进入诊断数据。

### 哪些文件发生变化

Core 的 `server.ts`、`drivers.ts`、`builtins.ts`、`config-validation.ts` 及其凭据/真实进程验收测试；桌面的 `SourceManager.tsx`、`management.ts`、样式/文案/API 与 UI 测试；Tauri 的 `credentials.rs`、`lib.rs`、`Cargo.toml` 和 lockfile。测试依赖新增 React Testing Library 与 jsdom。

### 数据库是否变化

没有 schema、migration 或 backfill。生产者 Token 继续只以 hash 保存于已有 `producer_tokens` 表，新增撤销 API 写已有 `revoked_at`；配置草案和发布继续使用已有 revision 事务。凭据明文不进入 SQLite。

### 外部行为是否变化

管理员现在可以列出和撤销生产者，桌面可以管理来源、凭据引用与 PushPlus 输出。凭据操作若系统存储不可用会失败并显示通用提示；PushPlus 不会尝试明文文件。PushPlus 的 HTTP 200 若包含拒绝码不会再显示为成功投递。测试用的私网端点需要与配置一致的精确 origin 授权。

### 风险

轮换 Token 会立即使旧生产者令牌失效；撤销后要重新创建才能恢复输入。系统凭据库可用性依赖宿主账户与平台服务。真实 Windows 互通已验证；macOS/Linux 的实际系统凭据服务和安装包端到端验证留在 #23。Windows 上 Vitest 的独立 fork 曾一次在 `plugin-runtime` 文件启动时出现 `ERR_IPC_CHANNEL_CLOSED`；该文件单独通过，随后整套 acceptance 也通过，未出现产品断言失败，仍作为测试基础设施波动观察。

### 测试

桌面测试验证来源绑定 Token 的创建、一次性展示和撤销，密钥保存/删除不回显，读取或保存失败只显示安全提示，以及 PushPlus 预览和发布交互。Rust fake store 测试覆盖保存、替换、删除、缺失、读写失败；真实 Windows 测试创建一次性系统凭据，直接由 Core 使用的 Node keyring 客户端读取并清理。驱动测试用本地 HTTP 服务直接统计调用次数，覆盖凭据成功、缺失、读取异常、PushPlus 业务拒绝、可重试码和异常响应。真实 Core 验收用 OS 凭据成功发送恰好一次，并检查 SQLite、导出、支持包无明文；凭据缺失时 HTTP 请求数为零。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 全部通过；Core 单测 81/81、Core acceptance 16 文件 35/35、桌面单测 10/10、桌面 acceptance 2/2；`cargo test --lib` 5/5、`cargo fmt --check` 通过。

### Reviewer 曾发现的问题

真实跨语言凭据测试先发现桌面保存后 Core 读不到；追溯到 Rust keyring 未启用平台后端、默认为进程内 mock，现显式启用真实 OS 后端并把互通测试纳入默认 Rust 单测。再次审查对照官方 PushPlus 文档发现 HTTP 200 的业务失败会被误记成功，现解析有限的三位业务码并新增实际请求测试。验收门禁一次在独立 Vitest fork 的 IPC 阶段失败；单独复现该文件以及完整重跑都通过，记录为未确认根因的 Windows 测试进程波动，不将首次失败隐去。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS。

### 最终状态

PASS。

### Commit

产品实现 `735c148`。


## Issue #18 — 驱动、绑定与配置版本管理

### 这张 Issue 要解决什么

让用户在桌面应用里创建、编辑、启停驱动和绑定，通过结构化表单设置条件和动作映射，并在看过 Core 的校验与影响预览后发布。用户还可以查看版本并通过新版本回滚。

### 原来有什么问题

桌面只有 Codex 到虚拟输出的快速配置。其他驱动和绑定必须借助 API 操作；快速配置会用自己的单项配置覆盖已经存在的其他输出。Core 虽能保存草案和回滚，却缺少版本列表 API；并发管理员可能发布一个依据旧配置预览的草案，覆盖更新版本。

### 我改了什么

新增宿主渲染的配置面板。驱动表单读取 Catalog 中的配置 schema；绑定表单提供来源选择、条件、常量、JSON Pointer 和模板映射、目标动作、优先级及投递选项。编辑先保留在当前页面，Core 校验成功并返回影响预览后才出现发布操作。新增版本列表 API、历史版本查看及“回滚为新草案”流程。快速配置现在合并到当前配置，保留已有驱动与绑定。

Core 在草案中记下预览时的已发布版本，并在发布事务内核对。其他管理员先发布了新版本时，旧草案会被拒绝，要求重新预览。

### 为什么这样改

Catalog schema 由宿主表单渲染，插件不能插入 React 或执行用户 JavaScript。让 Core 执行最终配置校验与原子发布，桌面只负责编辑和展示。草案的基线检查放在 SQLite 发布事务中，才能关闭桌面读取配置与实际提交之间的并发空窗。

### 哪些文件发生变化

Core 的 `service.ts`、`server.ts` 及配置/投递测试；桌面的 `ConfigManager.tsx`、`ConditionsField.tsx`、`MappingField.tsx`、`config-forms.ts`、`config-management.ts`、`api.ts`、`App.tsx`、样式/文案和 UI/真实 Core 验收测试；桌面依赖与 lockfile。

### 数据库是否变化

没有 schema migration 或 backfill。已有 `config_revisions.impact_json` 新增 `basePublishedRevision` 元数据。旧版本创建、没有基线信息的未发布草案不能直接发布，需要重新预览；已发布版本不受影响。

### 外部行为是否变化

桌面新增完整配置管理入口；管理 API 新增需要管理员授权的分页版本列表。陈旧草案发布返回 `CONFIG_STALE_DRAFT`，不会覆盖新配置。快速配置保留其他输出，遇到约定 ID 冲突时拒绝覆盖。回滚仍创建新 revision；历史事件不重放。

### 风险

修改驱动或禁用绑定可能改变当前输出，因此发布前展示 Core 计算的影响，Core 仍拒绝移除有未完成投递或活动输出的驱动。旧草案要重新预览。配置管理面板按需加载，首次打开会多下载一个表单依赖模块；构建通过，尚未做真实三平台 GUI 安装包 smoke。

### 测试

桌面 UI 测试在无硬件环境创建 Virtual、编辑 Core 默认旧类型别名的 Virtual，编辑条件及三种映射，阻止无效 JSON 保存，验证插件 schema 文本不会执行 HTML，以及陈旧配置不能发布。真实 Core/桌面验收以实际 HTTP 接收次数验证无效配置被拒绝、预览、发布、回滚形成新 revision、历史事件不重放、新事件仍投递。Core 单测覆盖并发草案顺序、旧草案拒绝和安全移除驱动。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 全部通过。

### Reviewer 曾发现的问题

审查发现快速配置会覆盖其他输出，已改为合并；桌面仅比较本地配置仍存在发布竞态，已增加事务内草案基线检查。首次表单无法编辑常量和条件比较值，已加入宿主 JSON 控件并阻止无效内容保存。Core 默认 Virtual 的旧类型名无法通过新版枚举，现允许 Catalog 已知的合法别名。新并发规则使一项旧测试尝试发布过期草案而失败，测试已改为要求重新预览，同时继续验证投递保护。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS。

### 最终状态

PASS。

### Commit

产品实现 `7d6734c`。


## Issue #19 — 暂停、确认和诊断管理

### 这张 Issue 要解决什么

让用户在桌面查看当前声明与输出、确认某条声明的特定版本，并在导出支持包前了解其中有哪些文件、哪些内容会被隐藏。暂停和恢复继续由已有桌面按钮控制。

### 原来有什么问题

桌面只有暂停按钮和只读的声明表，没有确认入口，也没有支持包预览或导出入口。声明表没有显示 revision，旧的拼接式行键遇到特殊字符可能冲突。暂停请求失败时界面没有明确反馈。

### 我改了什么

声明表展示每条 claim 的 revision，展开后可查看当前值；确认前展示 producer、scope、signal 三元身份与 revision，再把这四项原样交给 Core。诊断面板先读取文件清单与脱敏范围，预览明确标记含敏感内容时不允许导出。用户确认导出后才从 Core 获取已脱敏支持包，通过系统保存对话框写入选定位置。暂停失败显示固定的安全提示。

### 为什么这样改

确认必须由 Core 在数据库事务中验证当前 revision，桌面只提交用户看到的具体版本；这样旧页面不能确认更新后的事实。支持包的脱敏由 Core 完成，桌面不把任意错误正文回显；原生写入只接受有界的版本化 JSON，并且文件路径只来自系统保存对话框。

### 哪些文件发生变化

桌面的 `RuntimeManager.tsx`、`runtime-management.ts`、`App.tsx`、`api.ts`、样式/文案与 UI/真实 Core 验收测试；Tauri 的 `support_bundle.rs`、`lib.rs`、`Cargo.toml` 与 lockfile。新增 Rust 原生 dialog 插件，用于系统保存对话框。

### 数据库是否变化

没有 schema、migration 或 backfill。确认继续写入已有 acknowledgements 表，并由 Core 事务核对 claim revision；暂停继续使用已有持久设置。支持包导出是只读操作。

### 外部行为是否变化

用户可在 UI 精确确认声明版本，过期版本会收到固定的 `CLAIM_REVISION_MISMATCH`，不会误确认新事实。支持包保存前显示一个文件的清单和脱敏范围；取消系统对话框不会写文件。暂停失败会显示可见提示，声明表的行身份改为无歧义元组。

### 风险

展开声明会在本机界面显示其原始业务值，默认折叠；支持包仍由 Core 脱敏，桌面和原生写入都不向日志输出原始正文。原生保存对话框已编译和单测，真实 Windows/macOS/Linux 安装包中的手工 GUI 操作待 #23 smoke 验证。首次补装 Rust 工具链并编译依赖耗时较长，不影响产品运行时路径。

### 测试

桌面 UI 测试验证确认发送准确身份与 revision、陈旧版本显示安全错误、清单和脱敏范围先于导出显示、标记不安全的文件无法导出。真实 Core/桌面验收覆盖两个 claim、多绑定 honor 开关、旧 revision 拒绝、新 revision 独立生效、暂停期间输入更新、恢复只呈现当前状态；本地 HTTP 服务直接统计暂停时事件请求为零、恢复后的新事件请求为一。诊断验收检查支持包不含测试邮箱、事件正文或生产者 Token。Rust 单测验证原生写入只接受有界的 v1 JSON，且可正确落盘。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 全部通过；Core 单测 82/82、桌面单测 21/21、Core acceptance 16 文件、桌面 acceptance 3 文件 4/4；`cargo check --lib`、`cargo fmt --check` 与 `cargo test --lib` 6/6 通过。

### Reviewer 曾发现的问题

Review 发现暂停请求失败没有 UI 反馈，现显示固定提示；确认失败原先只会显示在下方诊断区，现移到面板顶部。声明列表原拼接行键可能把不同身份映射成同一字符串，现改成无歧义元组。为保证导出真的落盘，补了 Tauri 系统保存对话框和有界版本检查。Rust 依赖首次下载曾因 Cargo HTTP 多路复用发生 TLS 失败，关闭多路复用后成功；与原生编译并发运行的接受测试异常缓慢，主动停止后在无争用状态完整重跑并通过。跨 #16–#19 集成审查复核了 SSE 快照、配置并发发布、暂停状态、来源管理和诊断边界，未发现组合 blocker。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS。

### 最终状态

PASS。

### Commit

产品实现 `fe70d5e`。


## Issue #20 — Codex spool-first 黑盒验收

### 这张 Issue 要解决什么

让 Codex hook 在 Core、网络或凭据库出故障时仍能快速返回，并把尚未送达的命令留在磁盘上；恢复后重复投递不能造成重复业务结果。多个 Codex 会话须保留各自状态，并按通用优先级竞争同一输出。

### 原来有什么问题

CLI 已先写临时文件再 rename，也有 800 毫秒请求超时，但几乎只测试命令解析。事件 ID 被拼进文件名，可影响磁盘路径；落盘未明确同步。异常正文可能把用户输入或凭据错误写入 hook 标准错误。无请求体的 SessionEnd clear 错带 JSON Content-Type，真实 Core 会拒绝，导致高优先级会话无法释放输出。Core 故障、并发 drain 和多会话行为没有进程级验收。

### 我改了什么

spool 文件名改为内部时间和随机 ID，与 event ID 等命令字段分离；写入后先同步文件，再原子 rename，支持的平台同步目录。CLI 只连接 discovery 声明的 127.0.0.1 有效端口，发送前先落盘；成功收到 Core 的 202 后删除 spool，失败则保留。没有请求体的 clear 不发送 JSON Content-Type。hook 的 stdin 读取有时间及大小上限，CLI 和 hook 的错误输出改为固定安全类别，始终以成功退出让 Codex 继续运行。

### 为什么这样改

spool 是故障恢复的原始命令凭据，必须先完整落盘；磁盘路径不能由生产者数据决定。Core 的幂等命令 ID 留在文件内容中，使并发和崩溃后的重复发送指向同一个业务命令。只接受 loopback discovery 可防止错误连接信息把 producer token 发往远端。无请求体命令应遵守 Core 的 HTTP 解析规则，才能真正清除会话。

### 哪些文件发生变化

事件 CLI 的 `main.ts`、`codex-hook.ts`、包测试脚本及黑盒测试和崩溃/凭据故障预加载器；真实 Core 的 `codex-spool.acceptance.test.ts`；根目录验收脚本会先构建 CLI。

### 数据库是否变化

没有 schema、migration 或 backfill。重复 drain 使用现有的持久命令和 event 防重记录；没有新增数据库状态。

### 外部行为是否变化

Codex hook 对无效输入、Core 离线、凭据库失败和请求超时仍成功退出。未送达命令保留在 spool；SessionEnd 现在可正常清除 claim，输出自动回落到仍有效的会话。原子 spool 文件名不再暴露事件 ID。安装说明继续要求把示例 hook 合并到用户配置，没有覆盖用户 hook 的安装步骤。

### 风险

spool 中仍保存未送达的原始业务命令，应由当前用户的应用数据目录和文件权限保护；长期无法连接时需要运行 drain，待送达文件会持续存在。Windows 上使用原子 rename 和文件同步；目录同步只在支持的平台执行。构建仍提示桌面前端产物较大，留给容量/性能验收评估。

### 测试

进程级 CLI 测试直接模拟 rename 前后崩溃和部分文件、凭据库异常、错误 discovery、未结束的 stdin、非法输入，以及无响应 loopback 服务的 800 毫秒超时。真实 Core 验收先杀死 Core，再由 hook 写入第二个会话并重启 drain；管理快照验证两个 session 独立、优先级获胜以及 SessionEnd 后回退。另以真实 HTTP 服务统计并发 drain、同一文件重复投递和 Core 重启后重复投递的外部请求次数，始终为一次。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 四项门禁全部通过。

### Reviewer 曾发现的问题

第一次真实 Core 验收发现 SessionEnd 留在 spool：CLI 给空请求加了 JSON Content-Type，现只在有请求体时加。安全审查发现 event ID 和命令时间可影响文件名，现完全改由内部生成；发现原始异常可能含用户文本或凭据，现只打印固定错误码；发现 discovery 地址未限定 loopback，现先检查地址再读取 token。崩溃窗口检查确认部分临时文件不会被 drain，Core 接受但本地尚未删文件时的重试沿用稳定幂等身份。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS；Can commit YES。

### 最终状态

PASS。

### Commit

产品实现 `0e4b0cc`。
