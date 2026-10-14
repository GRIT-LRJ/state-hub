# AI 施工日志

## 2026-10-14 — 开发连接修复验证轮次

候选 41af94d819a9495e05320373285738a277d092bf 的 L3FLyn/evidence.json：冻结安装和全部单元通过，首次真实验收在 codex-spool 启动时遇到历史运行器 ERR_IPC_CHANNEL_CLOSED，保留失败。该候选原样重跑的 retry-evidence.json 中 19 组真实 Core 全通过，但桌面 connection 验收仍期待旧英文错误字符串，漏同步为新固定错误码 UNAVAILABLE，因此整体仍记失败。更新这一条契约断言后，桌面真实 Core 崩溃重连和监督 stdin 关闭两项定向验收通过，再导出最终候选；不掩盖此前失败，不宣称运行器偶发问题已根治。

候选 474f9925c53f342ebdf022b6993f0c23b50e5e66 的 `%TEMP%/state-hub-candidate-dNhmdU/evidence.json` 保留 FAIL：冻结安装成功，pnpm test 中 ConfigManager 两条既有复杂表单用例超过默认 5 秒，未进入后续门禁。原生编译结束后在同一未修改候选 checkout 单独重跑仍超时（state-hub-dev-fix-existing-ui-isolated.log），故仅将这两条用例上限改为 15 秒，全部操作和断言保留，再验证新候选。

上述候选对应的生产代码已完成 Windows 真实原生验证：开发资源模式 `%TEMP%/state-hub-desktop-lifecycle-xIGdox/results.json` 与打包资源模式 `%TEMP%/state-hub-desktop-lifecycle-MGGFWW/results.json`，各三场景通过；记录 development=true/false、实际页面来源、连接代次 1/2、前端已识别耗尽以及每个 Core PID 的退出。开发使用默认 localhost:1420。打包运行时故意继承开发来源环境变量，仍由 supervisor 清空。原生单元 9/9、release policy 12/12。测试时限后续修改不改变上述生产代码；完整候选新结果单独记录。

## 2026-10-14 — 开发窗口 Core 连接与安全错误提示（实施）

根因：Tauri 开发窗口来自 devUrl，但 Core 固定白名单仅含打包来源；OPTIONS 返回 PREFLIGHT_FORBIDDEN。真实 Core 回归开发模式先失败（403 != 204），实现显式开发来源传递后通过；默认及打包来源授权边界保留。原生使用 tauri::is_dev() 区分资源模式，不能用 debug profile 判断。

同时修复恢复耗尽仍永久显示重连：CoreState 持久保存终态，IPC 返回固定错误码；快照、刷新、订阅统一安全分类，终态停止定时重试，事件触发重新读取。通用 fetch 错误不猜测 CORS，错误正文和凭据不展示。新增回归先复现耗尽后仍重试及刷新原因丢失，再修复转绿。

真实桌面验收增补开发资源模式、实际页面 origin、界面观察耗尽的证据；启动失败验收必须等前端回执，避免只证明 Rust 发出事件。现有用户开发实例最初占用端口和 debug sidecar，原生 debug 测试因文件占用失败；用户关闭窗口并授权直接测试后，确认仍在托盘，结束已核对的旧开发进程树，使用临时数据验收。既有 App 多步骤测试遇到默认 5 秒/等待 1 秒超时，保留全部断言并改为 15 秒用例/5 秒按钮等待上限后四项界面回归通过，不将超时当作产品性能目标。完整候选和原生结果随后补记。

本轮从已有工作树继续实施。PASS 指所注明范围内的本地规格、正确性、架构、安全审查和四项基础门禁通过。历史阶段仅保留本地提交；2026-10-12 用户已授权经测试后推送，远端结果与本地验收分别核对。

2026-10-12 补充：末尾“已提交版本结案核验”记录了在干净 checkout 上发现的新阻断。历史 PASS 表示当时的实际测试和审查结论；当前结案状态以 `ISSUE_PROGRESS.md` 的最新复核为准。

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


## Issue #21 — VK87 Driver 契约验收

### 这张 Issue 要解决什么

在不碰真实键盘的自动测试里证明：平台只向唯一匹配的 VK87 HID 接口发送完整的 65 字节报告；设备或 profile 有偏差时不得写入。真实键盘验收须由人在场明确开启。

### 原来有什么问题

驱动虽有固定 VID/PID/usage 选择器和报告长度检查，测试只构造了一份合法 profile 和一个错误 usage。设备枚举的各种偏差、多接口歧义、真正传给 HID 的字节以及 Core 配置到设备调用的完整路径都没有验证。原生库打开接口发生异常时可能越过驱动的安全结果；写入异常原文可能进入诊断，关闭异常也可能把已成功的写入错误地变成重试。

### 我改了什么

驱动现在先拒绝未声明动作，再检查唯一匹配接口，并把枚举、打开和写入故障转换成固定的安全错误类别。构造器对空 profile 也明确拒绝。关闭设备的异常不会推翻已成功的写入，避免因此重复发送。新增 fake HID 单元矩阵及 Node 测试预加载器；真实 Core 子进程通过预加载器导入 fake HID，不会加载或访问本机 HID。新增默认关闭的人工真机脚本，只有明确参数、环境变量和交互式终端三者齐备才写设备，写完发送 idle 恢复报告。

### 为什么这样改

VK87 选择器和报告字节是硬件安全边界；只看最终数据库状态无法证明没有写错接口，测试必须在 HID 调用边界计数并比较完整字节。人工入口使用多重显式条件，使自动门禁不会意外触碰真实硬件。node-hid 对返回字节数的说明涉及 report ID 的计数差异，因此验收严格检查传入的 65 字节和原生异常，不把返回值必须等于 65 当作跨平台条件。

### 哪些文件发生变化

Core 的 `drivers.ts`、fake HID 单元测试、真实 Core 验收测试、测试预加载器与模拟模块；验收 Harness 增加只用于子进程的环境注入；新增 `vk87-manual-smoke.mjs` 和默认关闭测试；`docs/OPERATIONS.md` 补充人工步骤。

### 数据库是否变化

没有 schema、migration 或 backfill。Core 验收沿用已有配置 revision、claim、投影和 outbox。

### 外部行为是否变化

不支持的 VK87 动作不会访问 HID。枚举、打开和写入失败输出固定错误类别，不含原生异常正文。合法 decision 及 idle 仍使用配置中已验证的完整 profile。人工脚本在没有三项明确 opt-in 时只显示说明，不加载 HID；真实硬件尚未由自动流程写入。

### 风险

真实 VK87 的端口权限、固件响应和各平台 node-hid 后端仍需人工真机 smoke，自动 fake HID 只能证明平台传给库的接口路径和字节。设备 close 失败时无法由驱动保证原生句柄状态；已完成写入不会因此重新发送。首次完整验收曾在一个既有事务测试处出现 Vitest worker IPC 中断：单独复验通过，检查时没有遗留 Node 进程或 Windows 应用崩溃事件，第二次从头运行四项门禁全部通过；底层触发条件尚未定位，作为测试基础设施风险保留记录。

### 测试

fake HID 矩阵覆盖所有四个选择器字段、缺失路径、多接口、profile 的选择器和三份报告长度偏差，以及完成、待决策和 idle 对应的 65 字节数据。模拟原生枚举、打开、写入和关闭异常，确认不会泄露错误正文或错误重试。真实 Core 进程发布 VK87 配置后，fake HID 恰好收到一次 decision 报告；清除 claim 后恰好收到一次安全 idle 报告，并等待 outbox 清空。人工入口测试确认缺少参数、环境变量或交互式终端时不加载 HID。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 全部通过；Core 单测 88/88，Core acceptance 18 文件，桌面 acceptance 4/4。

### Reviewer 曾发现的问题

Review 发现打开设备的异常没有被驱动捕获、写入异常可能暴露原文、关闭异常会覆盖已完成写入，现均改为安全结果。首次实现把 node-hid 返回值强制等于 65；核对官方说明发现不同后端可能把 report ID 计数不同，已撤销该跨平台假设，改以输入字节完整性和原生异常验收。第一次完整门禁的 IPC 中断按上述方式调查并如实记录。最终 Critical 0、High 0、Medium 1（未复现的测试运行器中断）；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS；Can commit YES。

### 最终状态

PASS。

### Commit

产品实现 `470b30e`。


## Issue #22 — 真实 Core 容量与延迟验收

### 这张 Issue 要解决什么

证明平台在桌面规模下仍能及时接收事件：50 个来源、50 个输出和 500 条绑定同时存在时，持续 100 events/s、1000 条突发及 Core 重启后的输入都能完成，HTTP 接受延迟的 P95 不超过 100 毫秒。

### 原来有什么问题

原有性能测试只在同一进程内调用 Service，使用内存 SQLite，没有经过真实 loopback HTTP、磁盘数据库、配置发布或异步 dispatcher。它无法说明桌面实际使用时的输入延迟，也无法发现高绑定基数下每次事件重复读取和解析全部绑定的成本。

### 我改了什么

新增独立的 `pnpm test:performance` 负载门禁。它启动真实 Core 和临时 SQLite，注册 50 个来源，发布 50 个虚拟驱动实例与 500 条绑定；先暖机，再按每 10 毫秒一条的节奏提交 500 条事件，接着以最多 64 个在途 HTTP 请求提交准确的 1000 条突发事件，强杀并重启 Core 后再提交 100 条。脚本检查所有 1650 次虚拟投递完成、无死信，输出机器环境、P50/P95/P99、速率、配置发布时间、待处理数和 dispatcher 排空时间。Core 对已发布绑定按配置 revision 缓存解析结果，配置变化时重新读取。

### 为什么这样改

HTTP 202 是命令事务已提交的可观察边界，直接从客户端计时才能覆盖网络、Fastify 和 SQLite；等待全部 delivery 结束又能证明 dispatcher 在负载后恢复到空队列。绑定内容只随配置 revision 改变，按 revision 缓存避免每次事件重新解析 500 条 JSON，而不改变数据库事实源。突发使用固定 64 个在途连接，避免把本机 TCP backlog 当成平台吞吐，并在报告中公开这个负载参数。

### 哪些文件发生变化

Core 的 `service.ts`、`scripts/performance-benchmark.mjs` 和包脚本；根目录新增 `test:performance` 命令；`docs/OPERATIONS.md` 写明负载形状、阈值和发布环境要求。

### 数据库是否变化

没有 schema、migration 或 backfill。基准使用真实 WAL 数据库；绑定缓存只在 Core 进程内，重启后从 SQLite 重建。投递、命令和防重身份沿用原有表。

### 外部行为是否变化

HTTP/API 形状不变。大量绑定下事件接受更快；新配置发布、回滚和插件升级仍以新 revision 为准。开发和发布人员可运行独立性能命令并保存结构化结果。

### 风险

绝对延迟受主机 CPU、内存、Node 版本和后台负载影响。当前 Windows x64、Node 24.15.0、i7-13700H、约 16 GB 内存的连续有效结果均通过；正式 CI/发布须在固定、空闲机器上重复运行。突发 P95 针对开始发送 HTTP 请求到收到 202 的时间，64 个连接之外的客户端排队时间不计入单请求延迟；批次总耗时另行报告。缓存依赖配置 revision，已由配置发布、回滚、插件升级及崩溃恢复验收复核。

### 测试

最后一轮：50 来源、50 输出、500 绑定；持续 500 条用 4.999 秒完成，接受速率 100.02 events/s、P95 4.41 毫秒；1000 条突发 P95 83.57 毫秒、总耗时 1.292 秒；强杀重启后 100 条 P95 30.22 毫秒。总计 1650 条 delivery 全部完成、死信零。每阶段都检查 HTTP 状态，持续、突发和恢复的 P95 都以 100 毫秒为硬阈值。最终 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 和 `pnpm test:performance` 均通过。

### Reviewer 曾发现的问题

最初同时建立 1000 个 TCP 连接时 Windows 拒绝部分连接，但 Core 仍运行；负载器改为公开的 64 在途连接突发模型。另一轮超时来自测试器最后一批多发 24 条，Core 实际全部投递；现末批按剩余数量发送，并在失败时报告 delivery 状态。Review 还发现按 producer 再建一层绑定索引没有改善本机结果，已撤回，只保留直接解决重复 JSON 解析的 revision 缓存。缓存失效路径及 #20–#22 的配置、投递、恢复、安全组合审查均通过。最终 Critical 0、High 0；Spec PASS、Correctness architecture PASS、Security PASS、Crash/Recovery PASS；Can commit YES。

### 最终状态

PASS。

### Commit

产品实现 `c934ba5`。


## Issue #23 — 三平台安装包与更新（技术阻断，未通过）

### 这张 Issue 要解决什么

让用户可以通过 Windows、macOS 和 Linux 的原生安装包安装、升级和卸载 State Hub，并用真实安装后的启动时间检验桌面体验。

### 原来有什么问题

Tauri 只声明了通用打包目标；Updater 关闭，没有安装或升级的真实 smoke，也没有驱动激活和首屏性能数据。第一次 Windows 构建还暴露两个真实安装故障：Updater 在没有公钥时初始化会让应用启动失败；打包的 Core 缺少插件依赖，启动后立即退出。

### 我改了什么

加入三平台安装包与更新 CI 矩阵、安装/启动/卸载脚本、使用临时签名密钥的更新脚本和明确的版本通道。桌面端只在更新配置有效时启用 Updater，并提供检查、安装更新入口；错误只返回固定类别。补齐打包 Core 的缺失依赖。Windows 本地真实安装已走过畸形 manifest、错误签名、签名正确但内容损坏、成功升级和重启后数据保留。

### 为什么这样改

打包成功无法证明安装后的程序能启动。临时密钥只用于本地/CI 更新验收，且 beta 测试包明确显示未经过操作系统代码签名；真实 stable 密钥另由发布凭据提供。驱动基准从配置发布前计时，包含激活和第一次投递，避免把启动成本漏出测量区间。

### 哪些文件发生变化

桌面 `updates.rs`、`startup_metrics.rs`、`lib.rs`、`App.tsx` 和文案；Core 打包依赖与 `driver-startup-benchmark.mjs`；`tools/release/` 内安装、更新、manifest 和性能脚本；`.github/workflows/package-smoke.yml`、`updater-smoke.yml`；桌面图标与根脚本。

### 数据库是否变化

没有 schema、migration 或 backfill。升级 smoke 使用升级前后的同一 Core 数据目录，并检查数据库仍可由新版本启动。

### 外部行为是否变化

按通道配置的桌面包可检查和安装经过签名验证的更新；未配置更新的包不显示更新入口。新增 Windows NSIS、macOS DMG、Linux AppImage/deb 的构建和真实安装 smoke 工作流；目前只有 Windows 在本机实际执行。

### 风险

macOS 和 Linux 的真实 CI 工作流尚未运行，不能据静态审查推断它们通过。启动耗时受宿主环境影响；本机真实安装的 UI 首屏 P95 约 4.49 秒、Core 就绪 P95 约 7.86 秒，均超过当前严格的 1 秒安装启动门禁。Issue #1/#23 明文要求的是驱动启动和 UI 首屏各不超过 1 秒，没有给 Core 就绪单独设定 1 秒阈值；当前安装 smoke 对 Core 就绪使用了额外的严格检查。把内部计时起点提前到 Rust `main` 后，实际安装的 Alpha 包从 Rust 入口到首屏约 0.8–0.9 秒，启动安装后的 EXE 到首屏却需 4 秒以上；差额发生在 `main` 之前。打包 Core 的约 3.6 秒健康响应也主要包含约 3.1 秒的 EXE 启动调用，而非全部是 Core 初始化。

### 测试

`pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build`、Rust 6 项测试、release 11 项单测、打包 Core 的真实启动均通过。20 次真实 Core 冷启动从发布驱动配置到首次虚拟投递 P95 为 100.84 毫秒。Windows 本地安装的签名更新四条路径通过，旧版在三类失败后仍健康；成功升级到 0.1.0 后 Core 数据保留。20 次安装版启动测得首屏 P95 4485.19 毫秒，因此发布性能门禁失败。另构建并真实安装 `Alpha (Unsigned)` 包，应用和 Core 都能启动，但外部首屏仍需 4 秒以上；失败门禁后安装器已清理。随后单独测量 `spawn()` 同步返回：桌面 EXE 约 3.38 秒，Core EXE 两次为 3.19/3.09 秒；Core 进程创建返回后至健康响应约 0.52 秒。一个仅写入标记的 135 KB 未签名 Rust EXE，在同目录启动五次均约 3.27–3.31 秒；同目录 Microsoft 有效签名的 98 KB EXE 后四次约 18–21 毫秒。PowerShell 启动桌面 EXE 同样测得约 3.4–6.1 秒的进程创建耗时，因此不是 Node 测试器独有。三平台矩阵仍需远端真实执行。

### Reviewer 曾发现的问题

审查发现旧的驱动计时漏掉配置发布和激活，现已纳入。第一次打包的应用因无公钥启动失败、Core 因缺少 `fflate` 退出，均已修复并通过真实安装复测。损坏安装器也必须先正确签名才能检验安装失败后的恢复；测试已执行。签名 CLI 未明确传空密码时曾等待交互，工作流现显式传入空密码。Windows smoke 一次在桌面进程结束后立即清理目录触发 `EPERM`；现先等待 Core 侧车真正退出，再清理，复测没有再因文件句柄报错。启动诊断排除了 Rust/React/sidecar 初始化作为首个 3 秒延迟的原因：它发生在同步创建未签名进程时。两个未签名样本都没有网络来源标记；Windows Defender 实时防护关闭、Code Integrity/Defender 日志无匹配事件，但另有企业安全防护服务在运行。签名/信任状态与耗时高度相关，尚无证据精确归因到某一产品或策略；WPR 系统跟踪和文件过滤器列表因本机权限策略拒绝访问。自动审批拒绝移除安装后 Core 就绪的 1 秒门禁，理由是这会降低 Issue #1 的发布标准；门禁保持原样。当前 Critical 0；High 2（Windows 启动性能、macOS/Linux 实测缺失）；Spec FAIL；Can commit NO。

### 最终状态

BLOCKED（技术与平台证据），尚未满足 PASS，不关闭 Issue。Windows 首屏性能仍需达到 1 秒；macOS/Linux 必须在对应平台真实运行。该状态不是 DOMAIN BLOCKED。

### Commit

尚无；当前修改保留在工作树，待全部验收通过后独立提交。


## Issue #24 — Stable 签名、公证与发布门禁（依赖与外部证据阻断，未通过）

### 这张 Issue 要解决什么

确保 stable 候选只有在产品验收、三平台真实安装验证、操作系统签名或公证和来源证明全部成立时才可进入发布流程。

### 原来有什么问题

仓库没有 stable 候选流水线，也不检查证书、Apple 公证、发布版本、更新签名或候选产物的来源。

### 我改了什么

建立手动触发的 fail-closed 候选流水线：要求现有版本 tag、#1–#23 在该提交上记录为 PASS、四项基础门禁和性能门禁；按平台导入签名凭据，构建并实际核验 Windows Authenticode、Apple Developer ID 与公证、Linux 包和更新签名；对候选文件生成来源证明。四平台产物汇总时检查更新签名、为两个同名的 macOS 架构产物生成唯一发布文件名，生成 stable 更新 manifest 与五个安装包的 SHA-256 清单，并核验构建证明的来源提交。未签名 alpha/beta 采用醒目名称和独立安装身份。

### 为什么这样改

仅存在证书字符串或构建配置，不能证明最终安装器真的签名或公证；必须验收候选文件本身。Windows、macOS、Linux 汇总后再生成同一份四目标 manifest，可以防止缺少某个平台或两个 macOS 文件同名覆盖。保留候选工作流为人工触发，直到上游 #23 和实际凭据均满足条件。

### 哪些文件发生变化

`.github/workflows/stable-candidate.yml`；`tools/release/stable-policy.mjs`、`stable-config.mjs`、`stable-artifacts.mjs`、`manifest.mjs`、签名验证脚本及对应单测；未签名测试包的配置脚本。

### 数据库是否变化

没有 schema、migration 或 backfill。

### 外部行为是否变化

增加候选产物和更新元数据的本地/CI 生成路径；目前没有执行 stable 发布，也没有推送或上传任何正式产物。未签名测试包在窗口标题和安装身份中标明 Alpha/Beta (Unsigned)。

### 风险

本机没有 Windows 正式代码签名证书、Apple Developer ID/公证凭据，也没有 macOS/Linux 运行器的真实候选记录；无法宣称正式候选通过。候选流水线目前生成可审核的产物，不执行 stable 发布。签名、公证和来源校验仍需在真实候选上运行。

### 测试

发布策略、缺少凭据、错误通道、无签名文件、四平台 manifest、重名 macOS 文件处理等 11 项 release 单测通过；三个工作流 YAML 可解析。Windows 临时密钥的真实更新 smoke 已通过，但它不代表 stable 操作系统签名或 Apple 公证。

### Reviewer 曾发现的问题

最初的四平台汇总工具没有接入候选流水线，且 macOS 两种架构的更新压缩包可能同名；现在统一汇总并赋予唯一发布文件名。单测发现 JavaScript `map(basename)` 会把数组索引误当作扩展名参数，已修正。安全复核又发现正式签名和 Apple 公证凭据原本在整个构建 job 中可见，依赖安装也能读取；现在仅在导入、策略检查和签名构建步骤注入。当前 Critical 0；High 2（#23 未通过、真实签名/公证/证明未执行）；Spec FAIL；Can commit NO。

### 最终状态

BLOCKED（依赖与外部验收），尚未满足 PASS，不关闭 Issue。需先解决 #23，并取得正式签名/公证凭据和三平台真实候选证据。该状态不是 DOMAIN BLOCKED。

### Commit

尚无；当前修改保留在工作树，待 #23 和正式候选全部通过后独立提交。


## 2026-10-12 — 已提交版本结案核验（#2–#22）

### 这次核验要解决什么

确认他人只取得已提交代码后，是否能够复现测试并运行桌面功能，从而判断是否可以推送并关闭对应 Issue。先前的本地开发目录已有构建产物，也包含 #23/#24 的未提交修改；它的通过结果不能自动证明提交快照本身完整。

### 核验范围与结果

固定 HEAD 为 `f9abefe692173e150abe5af715dbbf5eaffb34f5`，远端 main 实时读取为 `c9786f051fd5a1de9166030462af2642144083ad`，相差 42 个提交。创建独立 detached worktree，并重新读取 GitHub Issue #1–#24 的完整正文和评论；原开发目录、已有 commits 和 #23/#24 修改均保留。GitHub 已关闭 #2、#8、#9、#12，#2–#22 中其余 17 张仍开放。

### 测试实际验证了什么

环境为 Windows、Node 24.15.0、pnpm 10.17.1。离线依赖安装因本机缓存缺少指定 pnpm 包失败；改为从 npm 官方 registry 按同一锁文件正常安装，安装成功且锁文件未变化。随后执行项目正式命令 `pnpm verify`。

`pnpm test` 中 CLI 8 项、domain 9 项、SDK 4 项、desktop 21 项、plugin-kit 5 项通过；Core 的 17 个测试文件、82 项测试通过，但 `plugin-host.test.ts` 在加载阶段失败，错误为 `Failed to resolve entry for package "@state-hub/sdk"`。SDK 的包入口指向 `dist/index.js`，干净目录中该文件不存在，而根测试脚本只先构建 protocol 和 domain，没有先构建 SDK。SDK 自身单测通过不代表已生成其对外入口。这是可从脚本和文件落点确定的构建前提遗漏，不是通过反复运行碰巧变绿的 flaky 结果。

`pnpm verify` 因该失败退出 1，后续 `test:acceptance`、`check`、`build` 没有执行，不能标注为本轮通过。完整输出暂存在 `%TEMP%/state-hub-closure-f9abefe-20261012/verify.log`；干净 checkout 保留在同目录的 `checkout`，便于继续修复和复核。

### Reviewer 又发现了什么

Standards 审查发现两个已提交桌面版本的启动阻断：`lib.rs` 无条件初始化 updater，但配置没有它要求的公钥；打包 Core 没有包含新增 plugin-kit 运行所需的 `fflate` 资产。这两项都曾在 #23 的真实安装中暴露并修复，但修复尚未进入提交。因此工作树能启动，不等于只取得已提交代码也能启动。本次依据固定源码、实际依赖源码和之前保留的安装证据核实，没有冒充重新执行了原生安装 smoke。干净 checkout 缺少图标生成前提还需后续原生构建核查，暂不作为已证实的新缺陷。

Spec 审查确认 #16 要求实际桌面与 Core 的集成验收，#17–#19 又以 #16 为验收依赖。现有 connection acceptance 由测试夹具手动终止和重启 Core，没有直接证明真实 Tauri 监督者自动恢复。因此在可发布提交上仍需验证真实桌面启动、Core 崩溃自动恢复和退出清理；不要求为此等待 #23 的全部跨平台发布工作。

Spec 审查另发现 #22 明文要求性能场景包含真实“投影”，但当前 500 条绑定全为 append-only，负载只提交 OccurrenceEvent；该事件路径不执行 stateful 重算。已有事件吞吐和延迟数据仍有效，但缺少 claim 仲裁、投影写入的同规模性能证据。需要补充该场景，不能仅保留原 Spec PASS。

审查曾怀疑打包程序用 `process.execPath` 启动 JS 插件会误启动 Core；核对固定版本 pkg 的 subprocess 补丁后已排除，未把未成立的疑点作为 blocker。对 #2–#15、#20–#21 的相关代码与验收抽查没有发现新的逐项阻断；这不替代最终全仓库审查。

### 当前处理与最终状态

本次是结案就绪核验；没有修改产品代码或把失败测试绕过。修正进度表：#16–#19 为 BLOCKED，#22 为 IN PROGRESS；保留历史实现、测试和提交记录。当前整体 Spec/独立提交门禁 FAIL，不能把 #2–#22 整批作为已完成推送并关闭。下一步修复应补齐测试构建前提、从已有工作树提取必要启动修复、补实际桌面监督验收以及 #22 的投影负载，再在独立快照重跑门禁。上述事项均是技术问题，没有新增领域决策。

### Commit

本次没有创建 commit，没有 push，也没有修改 GitHub Issue 状态。现有提交保持原样；本记录和进度表更正保留在工作树。

## 2026-10-12 — 干净提交验证与证据边界修复

### 原来的问题
开发目录已有 SDK 编译产物，所以本地测试通过；独立 checkout 中 SDK 尚未构建，Core 测试加载失败。过去把整个工作树的通过结果用于部分提交，扩大了证据范围。

### 我改了什么、为什么这样改
测试入口先按依赖顺序构建共享包。新增暂存快照验证工具，从 Git index 导出完整 tree，在新目录安装并运行四项门禁；证据绑定 tree、锁文件、环境和逐命令退出码。新增 push/PR CI，并明确真实桌面、状态投影与发行验收不能互相替代。

### 关键文件与行为影响
package.json、tools/verify-candidate.mjs、.github/workflows/verify.yml、docs/VALIDATION.md。无数据库变化，无业务/API变化；首次验证会重新安装依赖，耗时较长。

### 测试
独立目录 state-hub-candidate-dZ7Ik7 中安装、pnpm test、pnpm test:acceptance、pnpm check、pnpm build 均 exit 0。之前失败的 plugin-host 6 项通过。证据 tree 为 16c7150360d7848b362ac3828e26def2f9394b14，与提交 tree 相同。完整日志保存在操作系统临时目录的 evidence.json 旁。

### Reviewer 曾发现的问题
两个独立 reviewer 分别给出 Spec/Correctness PASS、Standards PASS，Critical/High/Medium 均 0。Low：证据尚未记录实际 pnpm 版本；本次实际为 10.17.1，后续完善记录，不阻断此修复。四项门禁结果只恢复基础提交验证，不恢复桌面和投影容量的结案状态。

### 最终状态与 Commit
PASS（验证基础设施范围）。47a9311b022b3d7a4dd2b44310d41872a671bb46。用户随后明确授权修复经测试后推送；目前尚未执行推送。

## Issue #22 — 补齐真实状态投影容量验收并修复性能

### 这张 Issue 要解决什么、原来有什么问题
要证明多个来源同时更新状态时，系统仍能及时响应并把正确状态送到目标。原来的容量测试只发送瞬时事件，没有经过状态仲裁和投影，不能代表这条主要业务路径。新增真实场景后，旧实现连预热都超过 60 秒。

### 我改了什么、为什么这样改
新增 50 个来源、50 个 HTTP 输出、500 条绑定和 500 个活动状态的测试。持续更新、集中突发和重启恢复都检查数据库赢家与真实 HTTP 目标收到的最终状态。重启后必须每个输出实际收到新请求，不能用重启前累计数据冒充恢复。

性能分析发现大量重复读取和全量重算。普通状态更新现在只重算该来源会影响的资源，同时保留这些资源上其他来源的竞争；配置、TTL、暂停、确认等仍使用完整重算。复用有界的 SQL 与匹配缓存；没有 SSE 订阅者时不生成昂贵的管理快照，但到期调度仍收到变更通知。投递循环每处理八项向事件循环让出一次执行机会，让已提交请求及时返回。这些修改没有放松事务、持久化、lease fencing 或重试上限。

### 哪些文件发生变化
Core 的 service、dispatcher、events、ttl-scheduler；domain 匹配缓存；stateful-benchmark、performance-benchmark、acceptance harness 及相关回归测试。

### 数据库是否变化、外部行为是否变化、风险
没有 schema/migration/backfill。API 和输出语义不变。风险是按资源缩小计算范围可能漏掉其他来源，因此专门覆盖共享资源竞争和不限来源的绑定；SSE 有订阅者时仍保留原有完整快照行为。

### 测试
隔离候选 state-hub-candidate-zNnrfX 的四项门禁和 test:performance 全部 exit 0。tree 8aa155013c23ca97a3b4fcaeda1df08f70e6f6fb 与提交一致。状态负载持续约 100.05 次/秒，P95 4.40ms；1000 次突发、并发 64，P95 94.44ms；恢复后 P95 7.19ms。共观察 753 次实际 HTTP 投递，逐资源验证重启重放且无死信。性能场景 SSE 订阅数为 0，不能由此宣称打开管理界面时也达到同样延迟。

### Reviewer 曾发现的问题
审查要求恢复断言只看重启后的请求，避免旧数据假通过，并明确突发并发与 SSE 条件。全部修复。性能优化过程中各次超时和超过 100ms 的结果均保留，没有降低阈值。早期 tsx CLI 包装启动出现两次原生进程异常，未认定根因；正式脚本使用既有 node --import tsx 入口，最终候选门禁通过。两个独立 reviewer 最终 Critical/High/Medium/Low 均为 0；Spec、Correctness、Standards、安全和静态恢复审查 PASS。

### 最终状态与 Commit
PASS（记录的规定负载和环境范围）。3325dfbeafeb1c981d4737a5bdcb69ca1f466608。

## Issue #16 — 补齐真实桌面启动、连接与生命周期验收

### 这张 Issue 要解决什么
桌面打开后应连接到它自己监督的 Core；Core 意外退出后可以自动恢复；桌面退出后不会留下 Core。界面每次都先取得完整快照，再订阅变更通知。

### 原来有什么问题
已提交版本无条件初始化尚未配置的 updater，且打包遗漏 fflate 运行资产和图标。修复曾存在于未提交发行工作中，不能算作已提交版本的能力。原有测试由夹具重启 Core，没有直接验证真正的 Tauri 监督者。

### 我改了什么、为什么这样改
从已有发行修改中单独提取必要的启动修复，没有重做发行功能。仅在 updater 已启用且配置完整时加载插件；打包包含必要依赖，图标纳入版本管理。添加独立 identifier、临时数据和隐藏窗口的真实桌面验收构建。故障注入只在专用 Cargo feature 中编译，正常构建不能靠环境变量开启它。

真实验收又发现一个此前漏测的产品阻断：Core 已就绪，但浏览器因 OPTIONS 预检返回 404 而无法连接。Node HTTP 测试没有浏览器跨域检查。修复只对既定的三个 Tauri origin 和管理路径响应预检，实际请求仍要求私有管理 token；SSE 的原生响应也携带相同的批准头。生产者 API 仍拒绝浏览器来源。

### 哪些文件发生变化
Core server 与 desktop-origin 验收测试；Tauri lib、supervisor、updater_config、lifecycle_smoke、图标和专用测试配置；桌面 api；prepare-sidecar、desktop-lifecycle-smoke、Windows CI 与 NATIVE_TESTING 文档。

### 数据库是否变化
没有 schema、migration 或 backfill。

### 外部行为是否变化
打包桌面现在能真正取得管理快照并订阅 SSE。未配置的 updater 不再阻止程序启动。没有扩大管理 token 权限，也没有允许任意网页访问管理接口。

### 风险
跨域响应属于安全边界，必须同时保留精确 origin 和 token 两道检查。测试专用构建不能当作发行包。Windows 结果不代表其他平台安装、升级或启动性能。

### 测试
真实 Core 的浏览器预检测试先得到 404 而失败，修复后验证批准 origin、缺 token、恶意相似域、非法方法/头、生产者隔离和实际 SSE 首帧。Rust 7 项通过，包括真实 Windows 凭据库与 Core 互通。

最新真实桌面证据为 %TEMP%/state-hub-desktop-lifecycle-HcvSHw/results.json：自动恢复后真实 spawn/连接代次均为 1、2；启动失败恰好五次后停止；外部终止桌面后 Core 退出；三个场景均无受测 Core 遗留。另用独立 Core 进程实际验证清理助手识别正确 image、拒绝其他 image，并通过持有的进程句柄终止。

桌面可执行文件来自隔离 tree 3f41d6e 的原生 Release 构建，后续 tree 仅修改 Core server、其回归测试和外部 smoke runner；Rust/前端输入没有变化。Core 已从包含 CORS 修复的隔离 tree 35a0905 重新打包，最终 smoke 使用最新 runner。保留这些构建来源，不冒称重新编译了未变化的桌面二进制。

### Reviewer 曾发现的问题
失败 smoke 最初只清理桌面，且证据可能只列此前 PASS。现在失败明确记录为 FAIL，收尾不改变原判定。实际看到 Windows 在五次启动内重用 PID，不能以 PID 不同证明重启；改为真实 spawn/连接代次，存活核对同时检查 executable。review 又指出“检查路径后按裸 PID 终止”的竞态，已改为持有同一个 Windows Process Handle 完成核对和终止。

完整门禁曾在 plugin-install 的 Vitest fork 启动时遇到 IPC 通道关闭。该文件单独及六次退出观测运行均通过，带子进程退出记录的整套 acceptance 也通过；没有找到对应 Windows 应用崩溃事件。触发原因尚未确定，保留 Medium 测试基础设施风险，不宣称已修复或把失败抹去。新候选仍必须完整通过四项门禁。

### 最终状态与 Commit
PASS。03f71e6a54584936a2fd7ecbf8940ca84314a9cc；提交 tree f13aa05d600f51b075694e1d0c7cf7399153ce8f 与隔离候选 K1igHX 的 evidence.json 一致，安装和四项门禁全部 exit 0。随后同一候选 test:performance 通过：状态投影持续 P95 4.74ms、突发 P95 95.03ms、恢复 P95 6.13ms。性能条件仍为无 SSE 订阅、突发并发 64。

## 2026-10-12 — 三项修复后的跨 Issue 集成复核与推送范围

### 审查结论
重新读取 Issue #1、架构规范和相关 Issue，复核基础验证、容量优化、桌面修复的组合。两位独立 reviewer 分别检查规格/正确性和架构/安全：事务提交边界、投影 revision、旧 lease 写回隔离、调用前重试预算、TTL 通知、配置发布/回滚、暂停/确认、持久去重与支持包脱敏没有因本轮修改退化。Critical 0、High 0；Medium 1 为上述未定位的 Windows 测试 worker IPC 波动，产品修复范围无待修 blocker。

### #17–#19 的验收依赖
原有 UI 组件交互、真实 Core 管理客户端、Windows OS 凭据与 Core 互通证据仍有效。本次补齐了已提交程序的实际启动、浏览器传输和 Tauri 生命周期，并重新通过全部门禁，因此 #16–#19 恢复本地 PASS。没有声称重新在原生窗口逐按钮点击；也没有把这些结果当作跨平台发行验收。

### 仍未完成什么
#23 的 Windows 安装首屏 P95 约 4485ms，仍高于 1 秒，入口前延迟具体原因未确定；macOS/Linux 安装与升级 smoke 仍缺实际执行证据。#24 缺正式签名、公证与完整候选证明。它们是技术/环境/发行证据阻断，领域决策数仍为 0，整体 Issue #1 和发行 Spec 仍不能标 PASS。

### Git 与证据
本轮新增修复提交为 47a9311、3325dfb、03f71e6，既有提交未改写或 squash。只把通过验证的提交及对应文档纳入推送范围；保留尚未提交的 #23/#24 工作树。GitHub Issue 没有自动关闭。原始成功和失败日志都保留在文中列出的临时目录；安装/源码树/门禁退出码与原生构建输入分开记录。文档后续提交仅更新记录，不冒称自身 tree 等于此前代码候选 tree。

收尾文档候选 554dfa682f59a9c5d0a60c30611b2123d92db35c 在独立目录 G8Y91J 再次完整通过安装与四项门禁。随后仅修正文档中的职责措辞、PID 重用说明和纯文档验证范围；已检查这些说明不属于构建输入，最终文档提交复用代码提交 03f71e6 的运行证据，保留与旧完整 tree 不同的事实。

## 2026-10-12 — 推送结果与用户收束范围

文档提交为 68286bed2901036a6dd312ae043c28a8463a679b，已连同修复提交成功推送 main，并核对远端 HEAD 一致。CI 38221240657 的 Linux 完整门禁和性能通过；Windows 四项基础门禁及真实 Tauri 生命周期通过，但 Windows 事件性能持续约 98.28/s、突发 P95 525.02ms 未达标。

随后曾扩大到新的性能专项排查，新增本地存储 probe、手动诊断 workflow 及可选 profiling 入口；这些改动均未提交、未推送，远端诊断 workflow 未运行。用户明确要求收回到 retro 修复，并说明当前只需正常启动运行，性能可以延后。因此停止性能专项，保留原始指标与本地诊断草稿，不修改阈值、不声称性能问题已经修好，也不继续占用本次修复范围。没有新建或关闭 GitHub Issue。

## 2026-10-12 — 桌面六栏重构中途暂停

按用户确认的 grill-with-docs 访谈结果实现：Clash Verge 风格紧凑侧栏，概览/来源/输出/规则/诊断/设置；输出与规则按次独立应用，保留跨栏未保存编辑而不捆绑提交。已补上下文索引、桌面词汇、界面设计与独立操作 ADR，并写入界面第一版及诊断解析、凭据组件。

实际证据：桌面 check 在后续表单/文案改动前退出 0；桌面 test 退出 1，3 文件失败/3 文件通过，11 项失败/10 项通过。失败包含旧按钮/文案和旧统一草稿流程断言，尚未逐一迁移及审查真实缺陷。没有完整候选树、真实 Core 或本轮原生视觉验收证据，不作 PASS 声明。

用户此时要求停止、明天再继续。已停止实现，正在运行的测试已自然结束；未安排自动续跑。代码和文档未提交、未推送，原有工作树修改与真实 index 保留。后续从 [UI_REDESIGN_HANDOFF.md](UI_REDESIGN_HANDOFF.md) 恢复，优先完成新流程测试、并发/异步审查及验收。自动化原生 UI 通道当时不可用，视觉验证保持未覆盖。

## 2026-10-13 — 六栏 UI 重构实现与证据

### 问题与最终行为

原界面把接入、凭据、输出、规则、运行状态和诊断罗列在长页面。按已确认访谈结果改为固定六栏侧栏及右侧工作区，默认概览；每栏解释用途与关键字段。输出与规则各自保留未保存编辑，每次只合入、审阅、应用一个操作。输出允许独立存在，规则只引用已生效输出；配置版本回滚仍恢复整套输出与规则。

来源与凭据操作立即生效，Token 只展示一次；凭据不读回、不持久化到浏览器，离开凭据编辑会清除输入。Codex/PushPlus 引导分步完成，可结束在任一步。诊断按需显示最多 500 条脱敏投递并筛选状态，保留支持包预览后导出。设置分为凭据/配置版本/关于。已有 updater 和首屏计时逻辑保留。

### 文件与文档

主要实现：App、ConfigManager、SourceManager、RuntimeManager、CredentialManager、Diagnostics、config-operations、config-forms、ConditionsField、runtime-management、management、app.css 和对应测试。新增 CONTEXT-MAP、桌面 CONTEXT/GLOSSARY、UI-DESIGN 与独立操作 ADR；UI-DESIGN 含六栏使用讲解。UI_REDESIGN_HANDOFF 已更新为交付状态。

Core 的既有创建来源接口增加兼容的可选 `createOnly` 参数：事务内发现同名接入方即返回 409，不轮换获胜者的 Token。只有客户端先查询列表无法防止竞态，因此用这项小幅接口扩展兑现新增操作的语义；省略参数仍保留既有轮换行为。没有数据库 schema、迁移或 backfill。

### 发现并修复的实际缺陷

- React 19 下静态确认弹窗不可用：改用有上下文的 Modal hooks，并在断线或离开相关页时清理敏感确认流程。
- 条件删除后复用索引导致本地文字错位：稳定行标识；切换编辑对象采用新表单会话，输出/规则有独立字段 ID 前缀。
- 旧异步预览/发布越过导航或断线边界：加入代次检查；最后读取基线后、实际发布前再次检查，过时预览不能恢复。
- 规则目标输出变化后无法继续：提供保留规则输入并刷新目标信息的恢复动作。
- 检查凭据存在与失败保存会丢输入：检查保留输入，成功保存/删除才清除；错误使用安全文案。
- 新增接入方与其他客户端并发时可能暗中轮换：服务端 createOnly 事务保护及真实 HTTP 并发测试。

昨日及早期失败日志保留；最终通过不抹去失败历史。相关临时日志为 state-hub-ui-config-20261013.log、state-hub-ui-suite-20261013.log、state-hub-ui-suite-20261013-2.log；后续单独桌面测试 state-hub-ui-suite-20261013-3.log 已通过，最终以下隔离候选包含最后代码改动。

### 验收覆盖与审查范围

- Spec：六栏默认页/单一连接、独立保存无规则输出、跨栏编辑保留、应用规则不夹带输出编辑、分步输出结束、引用删除保护、支持包预览和诊断范围，分别由 App/ConfigManager/SourceManager/RuntimeManager/Diagnostics 测试断言。原生视觉仍未覆盖，故不宣称全部 UI 规格验收完成。
- Correctness/architecture：静态复核一次操作合入最新配置、当前编辑基线与目标依赖冲突、发布 revision fence、独立表单状态和真实 Core 原子发布/回滚。config-operations、ConfigManager 和真实 Core config-management 验收覆盖并发/失效路径。
- Security：复核凭据只经原生凭据 API、敏感错误脱敏、插件说明按纯文本渲染、来源 createOnly 并发保护、显式轮换/撤销确认。组件测试与真实系统凭据验收验证密钥不进入 HTTP/SQLite/支持包；本轮没有扩大网络授权或改变管理 token 边界。
- Crash/recovery：断线保留编辑、阻断晚到的预览/发布、真实 Core 重连及进程回收；原生 smoke 验证实际 Tauri 监督重启并重新连接、启动失败五次上限和父进程异常退出后 Core 清理。未保存编辑只保留于当前进程，真正退出后不恢复是已确认行为。

### 隔离候选证据

使用临时 GIT_INDEX_FILE 导出完整当前工作树，未更改用户真实暂存区。tree `8edc383ec8e1dd7a81226f8b5369f4ee478ad083`，parent `68286bed2901036a6dd312ae043c28a8463a679b`；Windows x64 / Node v24.15.0。证据 `%TEMP%/state-hub-candidate-gvxmTC/evidence.json`：冻结锁文件安装、`pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build` 全部 exit 0；桌面 37 项、Core 90 项单元测试通过。候选包括原有发行/性能工作树，不能将结果误归于仅 UI 的独立提交。

真实 Core 全套 acceptance 通过，包含桌面配置/运行管理/连接与来源/凭据测试；另有定向结果 `%TEMP%/state-hub-ui-acceptance-20261013.log`。Windows 原生 evidence：`%TEMP%/state-hub-desktop-lifecycle-rJeLiz/results.json`，三场景 PASS，恢复 spawn 与 connected 代次均为 1、2；启动失败五次后 exhausted=true。原生构建和执行日志 `%TEMP%/state-hub-ui-native-20261013.log`。原生构建取自同一工作树代码，不冒称取自候选导出目录。

随后成功构建普通非 lifecycle-smoke EXE：`apps/desktop/src-tauri/target/release/state-hub-desktop.exe`，SHA256 `87FBAC10F1463C0FD8DEAD1432C1470FAF9B752257FAD5481FCB6A9E3A002760`；日志 `%TEMP%/state-hub-ui-normal-build-20261013.log`。这是本地产物，没有创建新安装包、签名或替换已安装版本。

真实 index SHA256 前后一致：`BCCF6F0EFAC48955314432F2FE1269C3DB9A4EA2B5D294FF981F934C44F7687A`。验证后只修改 UI-DESIGN、UI_REDESIGN_HANDOFF、ISSUE_PROGRESS、AI_IMPLEMENTATION_LOG 四份说明文档；依据 VALIDATION 的文档收尾规则复用代码结果，最终文档 tree 不等同于已验证 tree。

### 剩余边界与最终状态

实现及自动化验证完成；原生视觉未验收。computer-use 原生管道不可用，cua enabled surfaces 为空，不能声称已逐按钮点击或验证默认/最小窗口、缩放和长名称。构建保留 chunk 大小警告，本次没有测试启动性能或宣称解决 #22/#23/#24 的既有问题。未提交、未推送、未新建或关闭 GitHub Issue。

## 2026-10-13 — 根目录 npm run dev 一键启动

用户希望每次改代码后只运行一条命令。根 package.json 增加 dev 脚本，串行执行 `pnpm install --frozen-lockfile && pnpm build:sidecar && pnpm --filter @state-hub/desktop tauri dev`。复用已有打包和 Tauri 监督机制，自动构建共享包/Core，再启动 Vite、桌面和 Core；任何准备步骤失败就停止，不另起无管理授权的 Core，也不手工创建长期管理 token。底层仍用 pnpm workspace，不引入 package-lock、额外依赖或第二套进程监督。README 和 OPERATIONS 已说明依赖工具链、首次编译、界面热更新、Rust 自动重编译、Core/共享包修改后 Ctrl+C 再运行同一命令。没有数据库或配置结构变化。

实际 Windows 验证使用临时 STATE_HUB_DATA_DIR / STATE_HUB_RUNTIME_DIR，不操作用户配置和密钥。两次从根目录真实执行 npm run dev，均完成 sidecar 构建并启动 target/debug/state-hub-desktop.exe 与受监督 Core；Core /health/live 返回 ok。第二次绕过本机 HTTP 代理后 Vite 返回 200，startup metrics 收到 uiFirstPaintMs 与 coreReadyMs。第一次 PowerShell HTTP 检查经本机代理返回 502，原始记录保留；第二次 -NoProxy 检查成功，不把代理响应当产品失败。证据目录 `%TEMP%/state-hub-dev-5caad71192704a5c8be55848ce63d09b/`：startup-evidence.json、shutdown-evidence.json、restart-evidence.json、restart-shutdown-evidence.json、startup-metrics.json。两次 Ctrl+C 均验证桌面和 Core 不再存活、1420 无监听；Windows 控制台显示 STATUS_CONTROL_C_EXIT 是主动中断结果。测试已停止，没有遗留开发实例。

隔离候选 tree `26b333184b0e75626f645e7d168afaf294320938`，parent `68286bed2901036a6dd312ae043c28a8463a679b`；`%TEMP%/state-hub-candidate-VmtleP/evidence.json` 记录冻结安装与 pnpm test exit 0，首次 test:acceptance 在首个 append-only-delivery worker 报 ERR_IPC_CHANNEL_CLOSED、exit 1，后续检查未运行。保留该 FAIL 与日志，不推断这次脚本改动导致或修复了此前已经记录的 Windows IPC 偶发问题。

未修改导出 checkout，在同一候选重跑完整 test:acceptance，并继续 check/build，三项全部 exit 0；`retry-evidence.json` 记录每项命令、时间、退出码和日志，并引用原安装/unit 成功证据。不重复已通过的 unit，也不改写原 evidence 为 PASS。最终四项基础门禁都有该代码 tree 的成功结果，但不是第一次整套运行通过。验证后仅收尾 ISSUE_PROGRESS 与 AI_IMPLEMENTATION_LOG 两份说明文档，代码/依赖/测试/构建输入未变化，真实 index 未改动。

检查范围：Spec 为根目录单命令启动和修改后重启路径；Correctness 为准备顺序、失败短路和继续复用已有 pnpm/Tauri 机制；Security 为无新 token 保存或权限边界变化、测试数据隔离；Recovery 为实际 Ctrl+C 清理与再次启动。热更新机制沿用现有 Vite/Tauri 配置；未逐像素检查窗口，不外推跨平台安装、升级或启动性能。本次改动仅一条可逆脚本与运行说明，采用真实命令验证，没有新增只复述脚本字符串的测试。未提交、未推送、未关闭 Issue；既有 UI、发行和性能修改保留。


## 2026-10-14 — 分批提交：性能诊断工具

仅提交手动诊断 workflow、临时 SQLite 持久化对照工具和可选 CPU profile 接线。node --check 与 YAML 解析通过；未运行额外性能专项，不更改阈值或 SQLite 生产配置。Spec/Correctness/Security/Recovery 检查限于手动触发、诊断隔离、临时目录清理及默认路径行为保持不变。

候选 tree `74e0810365c5e748983af330c1389b7d4b6c90b2`，parent `68286bed2901036a6dd312ae043c28a8463a679b`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-4MoXxR\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


## 2026-10-14 — 分批提交：打包、更新和发行门禁基础设施

提交独立的原生打包/更新/签名候选工具、手动 workflow、首屏计时和更新入口。隔离 release tests 11/11；相同 Rust 源码工作树测试 7/7；JS/PowerShell/bash 与 YAML 语法检查通过。Spec 仅完成基础设施，三平台真实发行、正式签名和启动性能验收仍不完整；Correctness/Security 审查配置缺失拒绝、HTTPS/签名/版本检查、测试 feature 隔离；Recovery 复用此前本地原生证据，不声称重新验收所有安装平台。

候选 tree `3724b4401cf41cbffa50e07f11d36cc589c09eb8`，parent `54dadbdca141c3ba3986faf70e318eb4bbfc265c`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-oDdtat\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。

## 2026-10-14 — 分批推送后的首轮 CI 边界

提交 54dadbd 的 GitHub Actions 运行 38507113118：Linux verify 成功；Windows pnpm verify 成功，但 test:performance 的持续速率未达 100/s；desktop-lifecycle 在 inspectWindowsCore 的 PowerShell 进程查询中报 spawnSync powershell.exe ETIMEDOUT。该 CI 运行失败，不能用本地候选门禁成功覆盖。此次没有改动生命周期 smoke runner，超时原因尚未确定，不断言是产品进程未退出，也不宣称已修复。既有 Windows 性能问题仍按用户决定延后，没有降低阈值或增加专项排查。

本次授权是按功能提交并推送现有实现，不是正式发布或关闭 Issue。#23/#24 的基础设施现已提交，历史表中的 Can commit NO 改为基础设施已提交、发行验收仍未通过；性能、签名、公证、跨平台和视觉证据缺口继续保留。#16 既有本地原生证据仍是限定版本与环境的历史结果，新推送的 CI 生命周期结果单独记为未通过。


## 2026-10-14 — 分批提交：六栏 UI 与独立配置操作

提交六栏导航、独立输出/规则编辑与应用、来源/凭据管理、诊断、中文说明和设计/术语/ADR 文档，以及 createOnly 来源并发保护。桌面 37 项及 Core 90 项单元测试通过；真实 Core 配置/凭据/连接验收通过。Spec、Correctness、Security、Recovery 覆盖范围沿用 2026-10-13 的详细审查，并以本次拆分后完整候选重新验证基础门禁；原生视觉仍未验收，Windows CI 生命周期超时另行记录，不将其列为通过。

候选 tree `f153797a1de11b77e94d78778173a7ccff717972`，parent `9d97da1211f26a848b9ff9f2c82aefca9e8ebb2e`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-1S7LQ2\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。

## 2026-10-14 — 一键启动提交候选的测试超时

候选 tree a0953e7e18ce3402563e6675e026ce76a8dd969f 首次验证 `%TEMP%/state-hub-candidate-wXN2Gg/evidence.json` 在 pnpm test 失败：ConfigManager 的跨栏保留并独立应用规则/输出多步骤用例耗时约 5700ms，超过 Vitest 默认 5000ms，36/37 项通过。该测试源码与此前已通过的 UI 候选 f153797a 相同；本轮 dev 改动只有脚本和运行说明。保留失败，不将其归因于已证实的产品缺陷，也不宣称已修复。随后对同一暂存 tree 重新执行完整候选验证，没有修改代码、断言或测试时限；结果在该批最终提交记录中另列。

第二批发布基础设施提交 9d97da1 的 CI 38507554772 同样为 Linux verify 成功、Windows verify 的性能阶段失败、desktop-lifecycle 的 PowerShell 进程检查超时。两个远端运行均不标为通过；本地 Rust/基础门禁与远端生命周期结果保持分开。

## 2026-10-14 — 多步骤界面回归的单用例时限

同一候选 a0953e7e 在第二个干净目录 `%TEMP%/state-hub-candidate-ry4KmQ/` 再次仅因同一用例 5745ms 超过默认 5000ms 而失败；没有通过重试把两次失败隐去。该用例串行执行两个完整 schema 表单流程，属于正确性断言，不是产品延迟门禁。因此只把这个用例的执行上限设置为 15000ms，并添加原因注释，其他测试和所有产品性能阈值保持不变。全部业务断言保留。定向重跑在约 6909ms 完成并通过，证明其完成路径需要超过 5 秒；不能宣称解决了产品性能问题。

这项小型测试运行修正与一键启动一起归入开发流程批次，提交标题和范围明确包含它。随后重新暂存并运行完整候选验证，最终 tree 与结果由该批记录给出；不复用此前失败候选的 PASS。


## 2026-10-14 — 分批提交：一键启动与开发回归流程

提交根目录 npm run dev、README/运行说明，并为跨栏两轮表单操作的单个正确性测试设置 15 秒执行时限，保留所有断言。初始同一用例两次 5 秒超时记录保留；修正后定向及全套候选验证通过。Spec/Correctness 为顺序准备依赖、失败短路、复用既有桌面监督和启动路径；Security 无新管理 token 或持久凭据；Recovery 复用 2026-10-13 同一启动命令的两次真实启动/退出证据，不修改产品性能门禁。

候选 tree `347c783194cedba84a0cb0908ff67c50aa1fb429`，parent `6c454ebf545c53ab0376b4b117230953909990d7`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-BiyUQE\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


## 2026-10-14 — 提交汇总与文档收尾

- 54dadbd chore(perf): add opt-in Windows storage and CPU diagnostics
- 9d97da1 feat(release): add native packaging, updater and signed candidate gates
- 6c454eb feat(desktop): add six-section navigation and independent configuration editing
- d6f4253 chore(dev): add one-command startup and stabilize multi-step UI regression

四批代码分别提交并普通 fast-forward 推送到 origin/main；逐个核对提交 tree 等于该批 evidence tree，没有改写旧提交或强制推送。最终代码提交 d6f4253978912bf0842f9576048e762bfaa286d8 之后只更新 ISSUE_PROGRESS、AI_IMPLEMENTATION_LOG、UI_REDESIGN_HANDOFF 三份说明文档，引用已验证代码结果，不冒称文档 tree 相同。进度表 #1/#22/#23/#24 的非 PASS 状态未改为 PASS；由于 stable-policy 读取该表，文档收尾额外检查 release tests 和 stable gate 继续拒绝当前未完成验收状态。

最新已完成的远程 CI 38508006405（6c454eb）：Linux verify 和 Windows 真实生命周期通过；Windows pnpm verify 成功，但后续性能测试发生 ECONNREFUSED，任务失败。此前两轮生命周期查询超时保留，不能用新一次通过抹去；没有根因修复结论。最终提交的远程 CI 将另行产生，不将推送成功表述为 CI 全绿。


## 2026-10-14 — Windows CI 存储位置诊断与修复候选

最新主分支 CI 38509002796：Linux verify、Windows 基础 verify 与 desktop-lifecycle 成功，Windows 性能失败（持续 97.28/s、P95 316.21ms、突发 P95 843.37ms）。本机原代码 pnpm test:performance 退出 0，日志 `%TEMP%/state-hub-ci-perf-baseline.log`；不以本机结果代替 CI。

远端诊断 38511425115 在同一运行器比较两处临时目录：SQLite WAL + FULL 的 500 次提交，系统 TEMP 用时 9707.39ms、P95 33.01ms，RUNNER_TEMP 用时 97.22ms、P95 0.303ms。完整事件负载持续输入 P95 从 234.27ms 降至 10.31ms、吞吐从 97.28/s 升至 100.16/s。带 100 微秒 CPU 采样的 runner-temp 突发 P95 104.38ms 仍失败，不能称为完整验收通过。诊断产物 `%TEMP%/state-hub-ci-diagnostics-38511425115/` 与远端 artifact 保留。

修复仅在自动 verify 的两个 Windows job 中把 TEMP/TMP 指向 RUNNER_TEMP，涵盖真实 Core 与桌面 smoke 的临时数据库；Linux 保持原路径。Spec/Correctness 审查保持原负载、100ms 延迟断言和吞吐门禁；Security 不修改 SQLite 持久化、鉴权或发布权限；Recovery 保留全部真实进程场景和断言。旧 PowerShell 查询超时及 ECONNREFUSED 原因尚未证实，不能因本次目录修正宣称都已修复。随后验证准确暂存 tree，再推送运行完整 CI；当前仍待远端正式结果，不关闭 Issue。


## 2026-10-14 — 用户修订性能要求：启动与正常使用优先

用户明确表示性能目标合理性未定，要求优化当前验收并同步 Issue。已修改 GitHub #1/#22/#23/#24，#22 改为 open/needs-info/DEFERRED，移除其作为 #23/#24 当前验收依赖；不关闭 Issue、不伪造性能 PASS。#24 原文将包装 #23 错写为 #22 的引用一并纠正。

日常 push/PR 保留四项基础门禁、Windows 原生生命周期并加入 release policy tests；性能移到独立手动 performance-report.yml。事件/状态/驱动/安装首屏的旧数值默认 reference-only，仍记录实际值和 referenceTargetsMet，主动设置 STATE_HUB_ENFORCE_PERFORMANCE_TARGETS=1 可对照旧阈值。1000 事件单元测试改为逐条命令已提交及完整事件计数断言。启动等待、HTTP 成功、投递、投影、重启、退出、安全和签名断言保留。stable gate 只允许 #22 显式 DEFERRED 豁免；其他未通过项继续拒绝。保留已证实的 Windows RUNNER_TEMP 存储位置修复。

修订前候选 bf60288dd98939e3293ef8660eb53c9e9b49c90e 的证据 `%TEMP%/state-hub-candidate-BG5AoJ/evidence.json` 保持 FAIL：安装和单元测试退出 0，acceptance 在 plugin-runtime 的 Vitest/tinypool 通信报 ERR_IPC_CHANNEL_CLOSED，未运行后续 check/build。用户随后改变要求，故该候选未提交，不再重试已废弃范围，不能把新候选结果归属给它。

当前定向验证：性能政策 4/4、release 12/12、1000 事件完整性 1/1；workflow YAML 和自动/手动触发分离检查通过。Spec 审查对应用户的新验收优先级；Correctness 检查正确性断言与 bounded timeout 保留、只有数值阈值降为参考；Security 检查无持久化/鉴权/签名豁免且只允许 #22 DEFERRED；Recovery 检查真实生命周期与重启/回收路径未删除。完整候选、真实启动与远端 CI 结果随后补记。


## 2026-10-14 — 调整后的本地验证完成

候选 tree `07681d923293203f236faf355b625bdbbceb2d0c`，父提交 `7cb5c54e57c2fe464c41cf7378f029a830af68c7`，证据 `%TEMP%/state-hub-candidate-fdYHDx/evidence.json`：冻结安装、test、test:acceptance、check、build 全部退出 0，候选整体 PASS；同一导出目录 release tests 12/12（release-tests.log）。性能政策 4 项回归包含超参考不阻断、显式对照仍拒绝、无效测量与真实功能错误继续失败。此前 BG5AoJ 的 IPC FAIL 不改写；本次通过不代表已根治历史运行器偶发 IPC 问题。

工作树原样运行完整性能报告与 20 次驱动启动均退出 0（`%TEMP%/state-hub-reference-policy-performance.log`、`state-hub-reference-policy-driver.log`），仅作为新报告策略的执行证据，未做性能结案。

真实根目录 npm run dev 使用独立临时数据：`%TEMP%/state-hub-usable-b543669e8c7246dd8eca148a81cda7a0/`，含 dev.log、startup-evidence.json、shutdown-evidence.json。桌面首屏回执有效，Core 健康和 Vite 均 HTTP 200；Ctrl+C 后记录的桌面/Core PID 与 1420/Core 端口均不存在。开发构建和同时运行验收下的时间仅记录，不作为发布性能基线；未声称完成原生视觉检查。未改用户配置/凭据。

提交前再次读取 VALIDATION、核对 index tree，按当前用户授权提交和推送。远端 CI 待运行结果，不关闭 Issue，不发布 stable。

代码提交 `21c63322646a9d65ad78d212387e1109b3de6d0a` 的 tree 与上述候选证据一致；后续仅这两份进度/日志文档补记结果，复用该代码证据，不声称文档 tree 相同。


## 2026-10-14 — 远端功能 CI 全部通过

GitHub Actions [38513301287](https://github.com/GRIT-LRJ/state-hub/actions/runs/38513301287)，提交 `15f1692afe5069e7d0d3454d6d10c6377fbfc5f3`（功能/CI 修复代码 `21c63322646a9d65ad78d212387e1109b3de6d0a`）：Windows verify、Linux verify、Windows desktop-lifecycle 三个任务均 success。该结论按用户修订后的功能标准成立，不表示旧 100ms/100/s/1s 性能目标达标。历史失败与未完成的三平台正式发行仍保留。

后续本次收尾仅修改 ISSUE_PROGRESS、AI_IMPLEMENTATION_LOG 两份说明文档，引用已验证代码和上述 CI；不改变程序、workflow、依赖、测试或进度表的验收状态。按 VALIDATION 的纯文档例外复用准确代码候选与远端证据，并检查 stable policy 仍拒绝当前未完成的 #1。Issue #1/#22 同步附上此结果，#22 保持 open/needs-info/DEFERRED。
