# Issue 施工总表

## 2026-10-14：开发窗口连接 Core 修复（验证中）

第二候选 41af94d819a9495e05320373285738a277d092bf（L3FLyn）：全部单元通过；验收首次出现历史运行器 IPC 中断，原样重跑后真实 Core 19 组通过，但桌面旧错误字符串断言未同步，仍记 FAIL。该断言现已改为固定错误码并定向验证，最终候选随后记录。

本次撤回“一键开发启动已可完整使用”的推论：历史 Vite/健康检查/首屏回执不能证明管理页面已经取得 Core 快照。真实请求已复现 localhost:1420 预检 403；新增真实 Core 开发来源回归先红后绿。#16 的既有打包模式证据保留，开发页面连接与开发恢复覆盖在本次完成前保持未通过，不关闭 Issue。

修复仅在 Tauri 开发资源模式下注入当前 devUrl 的精确本机来源，打包模式覆盖清空继承设置，保留临时管理 token 和生产者授权。连接提示改为安全分类，原生保存恢复耗尽终态；前端停止终态定时重试并提示从托盘退出重开。未增加普通浏览器管理或重启 Core 按钮，数据结构不变。

本次验证覆盖 Core 来源/凭证/配置发布/快照/SSE、前端错误与编辑保留、原生模式选择及耗尽读取，并补入真实开发窗口生命周期 CI。候选树及原生验收最终证据随后补记；本段不声明整体 PASS。

原生补充证据：开发默认来源 localhost:1420 的三场景见 `%TEMP%/state-hub-desktop-lifecycle-xIGdox/results.json`，打包来源的三场景见 `%TEMP%/state-hub-desktop-lifecycle-MGGFWW/results.json`，均覆盖首次快照/订阅、监督恢复、耗尽前端回执和退出回收。首次候选 474f9925c53f342ebdf022b6993f0c23b50e5e66 的 dNhmdU/evidence.json 保持 FAIL（两条既有表单测试 5 秒超时）；单独重跑复现后，仅放宽这两条完整多步骤用例到 15 秒，重跑新候选，不把旧失败改写为通过。

事实源：GitHub Issue #1、各子 Issue 全文、`docs/ARCHITECTURE.md`。`阻塞依赖` 是实施 DAG；`验收依赖` 不阻止开始写代码，但阻止最终 PASS。状态描述的是本地代码与验收结果，GitHub open/closed 状态另行核对。执行顺序优先保证正确性与安全边界，再做运行时、管理界面、集成、性能及发布。

## 2026-10-14：当前验收优先级（最新）

用户明确要求以正常启动、正常使用为当前目标，并要求同步修改 Issue。#22 的容量/延迟与 #23 的启动数值要求尚不能确认合理性，改为参考指标，#22 保持 open/DEFERRED，不把此前失败改记 PASS。当前仍要求四项基础门禁、真实 Core 功能验收、Windows 原生生命周期、关键六栏操作及安全边界；三平台安装、更新、签名、公证仍是正式发行条件。以下日期条目为历史记录，以本节和文末新验证结果为准。

## 2026-10-14：分功能提交与推送（历史批次）

用户授权的四批代码均已提交并推送到 origin/main：

- `54dadbd`：chore(perf): add opt-in Windows storage and CPU diagnostics
- `9d97da1`：feat(release): add native packaging, updater and signed candidate gates
- `6c454eb`：feat(desktop): add six-section navigation and independent configuration editing
- `d6f4253`：chore(dev): add one-command startup and stabilize multi-step UI regression

每批代码提交的 tree 均与独立候选 evidence 匹配，冻结安装与四项基础门禁都有通过证据，具体路径见本表末尾与施工日志。开发流程批次首次及原样重试发生同一界面用例的 5 秒超时；最终只调整该多步骤用例时限，保留全部断言后重新验证通过，失败记录保留。文档汇总单独提交，不混入代码批次。

远程 CI 不全部通过：54dadbd / 9d97da1 的 Linux verify 成功、Windows 性能阶段失败、生命周期进程查询超时；6c454eb 的 Linux verify 与 Windows 原生生命周期成功，但 Windows 性能阶段出现 ECONNREFUSED 仍失败（运行 38508006405）。最后开发流程提交和文档提交的 CI 尚待运行结果。不关闭 Issue、不发布 stable；原生视觉、Windows 性能与跨平台正式发行缺口仍保留。

## 2026-10-13：根目录一键开发启动

新增根目录 `npm run dev`：锁文件安装依赖 → 共享包/Core sidecar 构建 → Tauri/Vite/受监督 Core 启动。README 和 OPERATIONS 说明热更新、Core/共享包修改后重启同一命令、Ctrl+C 停止及预装工具链要求。保留 pnpm workspace 与既有脚本。

在临时数据目录实际运行两次，debug 桌面和 Core 启动、Core 健康检查成功；第二次 Vite HTTP 200 且收到首屏渲染回执；两次 Ctrl+C 后桌面/Core 均退出、1420 端口释放。证据 `%TEMP%/state-hub-dev-5caad71192704a5c8be55848ce63d09b/`。未修改用户运行数据或凭据。

候选 tree `26b333184b0e75626f645e7d168afaf294320938`：`%TEMP%/state-hub-candidate-VmtleP/evidence.json` 中冻结安装、unit test exit 0；首次 acceptance 因 Vitest `ERR_IPC_CHANNEL_CLOSED` 失败，保留 FAIL。随后在同一未修改的导出 checkout 重跑 acceptance，再执行 check/build，全部 exit 0，补充证据 `retry-evidence.json`。没有把首次失败改写为通过，既有 Windows 测试进程偶发风险仍保留。收尾仅修改本表和施工日志，未提交、推送、关闭 Issue，真实 index 不变。

## 2026-10-13：六栏 UI 重构实现与验证

用户要求继续后，已完成概览/来源/输出/规则/诊断/设置重排、中文说明、独立输出与规则应用、跨栏保留编辑、来源/凭据即时操作、分步引导及 grill-with-docs 上下文/术语/设计/ADR 文档。详细交付入口见 [UI_REDESIGN_HANDOFF.md](UI_REDESIGN_HANDOFF.md)。

隔离候选 tree `8edc383ec8e1dd7a81226f8b5369f4ee478ad083`（parent `68286bed2901036a6dd312ae043c28a8463a679b`）在 `%TEMP%/state-hub-candidate-gvxmTC/evidence.json` 记录冻结安装和 test / test:acceptance / check / build 全部 exit 0。桌面 37 项与 Core 90 项单元测试通过；真实 Core 验收覆盖配置、来源、系统凭据、暂停/确认和恢复。Windows 原生生命周期三场景通过，证据 `%TEMP%/state-hub-desktop-lifecycle-rJeLiz/results.json`；普通非测试桌面程序也已成功构建。

验收边界：本轮自动化通过，原生窗口布局、缩放、长名称等视觉检查未覆盖（UI 通道不可用）。Spec/Correctness/Security/Recovery 的具体检查范围见施工日志。没有把 UI 全部验收或 #23/#24 发行标为 PASS，没有关闭 Issue。#22 性能延后及既有发行阻断保持原状态。2026-10-12 的 UI 失败/暂停记录保留为历史，不代表当前自动化结果。

验证后只收尾四份说明文档：UI-DESIGN、UI_REDESIGN_HANDOFF、本表、AI_IMPLEMENTATION_LOG；复用上述已验证代码 tree，不声称文档收尾 tree 相同。完整候选包含原有工作树修改；未提交、未推送，真实 index 哈希前后一致。

## 2026-10-12：修复进度

- 用户最新收束：本次完成 retro 修复，以正常启动和运行作为当前验收重点；Windows CI 性能问题留作后续优化，停止新增性能排查。原性能阈值和失败证据保留，不把未达标改写成 PASS。
- 已推送 main 68286be；对应 CI 38221240657：Linux 基础/性能 PASS，Windows 四项基础门禁 PASS，Windows 真实桌面生命周期 PASS，Windows 性能 FAIL。新增性能诊断工具仍未提交、未推送，诊断 workflow 未触发。

- 推送后 CI 新证据：68286be 的 Linux 四项门禁与性能 PASS；Windows 四项门禁 PASS，但事件性能持续约 98.28/s、突发 P95 525.02ms，故撤回 #22 的整体 PASS，不能凭此前本地 PASS 认定远端性能验收通过。曾开始比较 Windows runner 存储与执行开销，现按用户要求延后；阈值、负载及持久化不变。以下先前通过记录保留为限定环境的历史证据。

- 基础验证阻断已修复：47a9311。独立导出的候选 tree 与 commit tree 一致；安装和四项门禁全部通过，Spec/Correctness/Standards review PASS。
- #22 已修复并提交 3325dfb：真实 HTTP/SQLite 状态投影负载通过。50 来源、50 输出、500 绑定/claims；持续 100/s P95 4.40ms，1000 次突发（并发 64）P95 94.44ms，重启恢复 P95 7.19ms。测试未开启管理 UI/SSE，不外推该场景性能。独立 tree 四项门禁及两轴审查 PASS。
- #16 已修复并提交 03f71e6：禁用 updater 的启动问题、打包依赖和真实浏览器 CORS/SSE 传输；实际 Tauri 自动恢复、五次启动失败上限、父进程异常退出清理均 PASS。最终隔离 tree f13aa05 四项门禁及性能门禁 PASS。
- #17–#19 的 #16 验收依赖已满足，结合仍有效的组件、真实 Core 和 Windows 凭据互通测试恢复本地 PASS。#2–#22 共 21 项本地 PASS；#1 整体验收、#23/#24 发行仍未完成，DOMAIN BLOCKED 为 0。
- 保留 Medium：Windows Vitest worker 曾出现 IPC 通道关闭，单文件六次诊断与整套诊断均未复现，最终候选完整通过但底层原因未确定。不是忽略失败或宣称已解决。
- 用户已确认五项架构边界并授权经测试后推送；仅推送已验证提交与记录，未自动关闭 GitHub Issues，未提交的 #23/#24 成果保留。

## 2026-10-12：独立提交结案复核

复核固定提交 `f9abefe692173e150abe5af715dbbf5eaffb34f5`，不包含尚未提交的 #23/#24。远端 `main` 仍为 `c9786f0`，本地领先 42 个提交。此前完整工作树的 PASS 记录保留，但不能据此认定只推这 42 个提交即可完成所有桌面验收。

- 全局提交门禁：干净 checkout 按锁文件安装后，`pnpm verify` 在 `pnpm test` 阶段失败。SDK 导出指向 `dist/index.js`，根测试脚本未先构建 SDK，导致 `plugin-host.test.ts` 无法解析 `@state-hub/sdk`。后续 acceptance/check/build 因串行失败未执行，不能记为本轮 PASS。
- #16–#19：桌面启动依赖仍未提交的 updater 初始化修复与 Core 打包依赖修复；还需在可独立复现的提交上验证实际 Tauri 监督重启和退出清理。状态改为 BLOCKED，原提交和历史测试证据保留。
- #22：现有性能场景仅发送 append-only 事件，没有覆盖规格要求的状态投影负载。状态改为 IN PROGRESS，已有事件吞吐结果仍有效，但不足以代表全部验收条件。
- #2–#15、#20–#21：本次规格与相关实现抽查未发现新的逐项结案阻断；仍受上述全局提交门禁约束。#23/#24 不是这些 Issue 的反向依赖。

完整证据和修复要求见施工日志末尾的“2026-10-12 — 已提交版本结案核验”。本次未推送、未关闭 GitHub Issue、未改写已有 commits。

| Issue | 状态 | 优先级 | 阻塞依赖 / 验收依赖 | 核心修改与模块 | 当前可实施 | Tests | Review | Commit |
|---|---|---|---|---|---|---|---|---|
| #1 总规格 | IN PROGRESS | 总验收 | 所有子 Issue | 全系统最终黑盒/白盒验收 | 否，等待子项 | 待最终审查 | 待最终审查 | — |
| #2 Core 验收 Harness | PASS | 基础 | 无 / 无 | 真实 Core HTTP/SSE 测试基础 | 已完成 | PASS | PASS | e99f6cc |
| #3 插件安装、信任与 Catalog | PASS | Critical | 无 / #2 | 持久验包、publisher 信任、动态定义与来源校验 | 已完成 | pnpm verify PASS | Spec/Correctness/Security PASS | c42694a |
| #4 独立插件进程 | PASS | Critical | #3 / #2 | 子进程、握手、健康、故障隔离与 stateful 恢复 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | 20ed2e4 |
| #5 插件旁路升级 | PASS | Critical | #4 / #2 | 旁路迁移、活动版本与配置 revision 原子激活、崩溃恢复 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | 348f1a9、df8f9f2（基础设施 ce22ccf） |
| #6 插件安全卸载 | PASS | Critical | #3 / #2 | 实例、来源、在途投递依赖检查与原子卸载 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | f483cb0 |
| #7 ClaimIdentity 防碰撞 | PASS | High | 无 / #2 | 确认、转换、贡献者、资源身份 | 已完成 | PASS | Spec/Correctness PASS | ecd9ef6、b5f47f4 |
| #8 生产者事务边界 | PASS | 正确性基础 | 无 / #2 | 命令、账本、投影、outbox 原子提交 | 已完成 | PASS | PASS | a417699 |
| #9 TTL 与投影 revision | PASS | 正确性基础 | 无 / #2 | 到期调度、回落、旧投影抑制 | 已完成 | PASS | PASS | 6d166a6、c9786f0 |
| #10 配置生命周期 | PASS | High | #3 / #2 | 完整契约校验、影响预览、原子 revision、驱动热激活与安全移除 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | df008ce |
| #11 HTTP 目标授权 | PASS | High | 无 / #2 | 精确 origin 授权、DNS 全答案校验、固定 IP 连接 | 已完成 | pnpm verify PASS | Spec/Correctness/Security PASS | 50767f6 |
| #12 Delivery 恢复 | PASS | 正确性基础 | 无 / #2 | lease、恢复、fencing、关闭等待在途投递 | 已完成 | pnpm verify PASS | Spec/Correctness/Integration PASS | c9786f0、c3680eb |
| #13 Append-only 投递 | PASS | Medium | 无 / #2 | 批处理、重试、TTL、死信 | 已完成 | PASS | Spec/Correctness PASS | de8b4e6、cfe4d86、b5f47f4 |
| #14 支持包脱敏 | PASS | High | 无 / #2 | 来源分类、预览与导出 | 已完成 | PASS | Spec/Correctness/Security PASS | 5c9992d |
| #15 统一历史保留 | PASS | Medium | 无 / #2 | 保留预算、持久防重身份 | 已完成 | PASS | Spec/Correctness PASS | 4d3c178 |
| #16 Sidecar 与 SSE 恢复 | PASS | High | 无 / #2 | 实际 Tauri 监督与界面重连、严格管理 CORS/SSE、干净打包启动 | 已完成 Windows 本地验收 | 隔离四项门禁、Rust 7/7、真实 native 三场景 PASS | Spec/Correctness/Architecture/Security/Recovery PASS；IPC 基础设施风险单独记录 | 49e9745、03f71e6（基础设施 2665147） |
| #17 来源与 PushPlus 管理 | PASS | High | 无 / #2、#16 | 来源 Token、OS 凭据引用、PushPlus UI 与业务码 | 已完成；#16 验收依赖满足 | 四项门禁、组件/真实 Core、Windows 凭据互通 PASS | Spec/Correctness/Security PASS；跨平台发行不在此结论内 | 735c148（依赖修复 03f71e6） |
| #18 驱动与配置管理 UI | PASS | High | #10 / #2、#16 | 宿主 Schema 表单、Binding、草案/版本/回滚、旧草案并发保护 | 已完成；#16 验收依赖满足 | 四项门禁、组件与真实 Core 配置生命周期 PASS | Spec/Correctness/Architecture PASS | 7d6734c（依赖修复 03f71e6） |
| #19 暂停、确认与诊断 UI | PASS | High | #7、#14 / #2、#16 | claim revision 确认、暂停恢复、支持包预览/导出 | 已完成；#16 验收依赖满足 | 四项门禁、组件与真实 Core ack/pause/诊断 PASS | Spec/Correctness/Security/Recovery PASS | fe70d5e（依赖修复 03f71e6） |
| #20 Codex spool 验收 | PASS | High | 无 / #2、#8、#9 | 原子 spool、fail-open、并发 drain、多会话真实 Core 验收 | 已完成 | 四项门禁 PASS；CLI 黑盒及真实 Core HTTP 计数 PASS | Spec/Correctness/Security/Recovery PASS | 0e4b0cc |
| #21 VK87 契约验收 | PASS | High | 无 / #2 | fake HID、唯一接口与 65 字节、真实 Core 无硬件验收、人工 opt-in | 已完成 | 四项门禁 PASS；fake HID 与真实 Core PASS | Spec/Correctness/Security/Recovery PASS；运行器偶发 IPC 记为 Medium | 470b30e |
| #22 性能基线与目标校准 | DEFERRED | 非阻断 / needs-info | #2、#8、#9、#10、#12、#13、#15 / 无 | 保留真实负载与指标，补齐场景、硬件、计时和重复测量依据 | 用户明确推迟硬阈值；不影响正常启动/使用验收 | 旧 CI 性能失败保留；新策略待验证 | 不是性能 PASS；参考目标合理性待确认 | c934ba5、3325dfb（历史实现） |
| #23 Packaging 与 Updater | BLOCKED | High | 无 / #2、#16、#17、#18、#19、#22 | 三平台安装与升级 smoke；Windows 已完成真实安装、签名升级和失败恢复 | Windows 首屏旧基线保留为参考；macOS/Linux 真实运行仍缺证据；基础设施已提交；真实发行验收继续保留 | 四项基础门禁、Rust 6/6、release 11/11、sidecar、Windows 更新 smoke PASS；驱动激活 P95 100.84ms；安装首屏 P95 4485ms FAIL；进程创建对照已记录 | Spec 未完成：macOS/Linux 真机证据缺失；首屏数值已降为参考；Correctness 架构局部 PASS；基础设施已提交；发行验收仍未通过 | 9d97da1（基础设施） |
| #24 Stable 发布门禁 | BLOCKED | High | #23 / #3–#21；#22 DEFERRED 豁免 | 版本/产品验收 fail-closed gate、三平台签名/公证验证、候选产物证明与四目标 manifest 组装 | 候选流水线和离线组装已实现；#23、正式签名/公证凭据和三平台候选验证未满足 | release 11/11、YAML 语法 PASS；真实签名/公证/证明未运行 | Spec FAIL：#23 和真实候选证据缺失；基础设施已提交；发行验收仍未通过 | 9d97da1（基础设施） |

`#23` 的跨平台真实 smoke 与 `#24` 的真实签名、公证需要相应平台和发布凭据的客观证据；基础设施代码可先实施。不能把尚未运行的外部验收记为 PASS。Windows 安装首屏超过旧 1 秒参考值的历史事实保留；按 2026-10-14 用户修订，它不再作为当前阻断。

## 2026-10-12 — 六栏 UI 重构暂停（用户要求）

用户要求暂停，待后续明确“继续”再恢复。当前工作树的 #17–#19 UI 重构为 WIP/未通过；上表历史 PASS 仅指列出的既有提交，不适用于本轮未完成界面改动。

已写入六栏 shell、独立输出/规则编辑、来源/凭据分区、最近投递诊断及 grill-with-docs 文档。桌面类型检查曾退出 0，但之后还有表单文案/诊断解析改动；最后一轮类型检查待补。桌面测试退出 1：21 项中 11 失败、10 通过，旧流程测试尚未迁移，新的交互回归与完整候选门禁尚未执行。未提交、未推送、未结案。续接细节见 [UI_REDESIGN_HANDOFF.md](UI_REDESIGN_HANDOFF.md)。


## 2026-10-14 — 分批提交：性能诊断工具

仅提交手动诊断 workflow、临时 SQLite 持久化对照工具和可选 CPU profile 接线。node --check 与 YAML 解析通过；未运行额外性能专项，不更改阈值或 SQLite 生产配置。Spec/Correctness/Security/Recovery 检查限于手动触发、诊断隔离、临时目录清理及默认路径行为保持不变。

候选 tree `74e0810365c5e748983af330c1389b7d4b6c90b2`，parent `68286bed2901036a6dd312ae043c28a8463a679b`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-4MoXxR\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


## 2026-10-14 — 分批提交：打包、更新和发行门禁基础设施

提交独立的原生打包/更新/签名候选工具、手动 workflow、首屏计时和更新入口。隔离 release tests 11/11；相同 Rust 源码工作树测试 7/7；JS/PowerShell/bash 与 YAML 语法检查通过。Spec 仅完成基础设施，三平台真实发行、正式签名和启动性能验收仍不完整；Correctness/Security 审查配置缺失拒绝、HTTPS/签名/版本检查、测试 feature 隔离；Recovery 复用此前本地原生证据，不声称重新验收所有安装平台。

候选 tree `3724b4401cf41cbffa50e07f11d36cc589c09eb8`，parent `54dadbdca141c3ba3986faf70e318eb4bbfc265c`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-oDdtat\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


## 2026-10-14 — 分批提交：六栏 UI 与独立配置操作

提交六栏导航、独立输出/规则编辑与应用、来源/凭据管理、诊断、中文说明和设计/术语/ADR 文档，以及 createOnly 来源并发保护。桌面 37 项及 Core 90 项单元测试通过；真实 Core 配置/凭据/连接验收通过。Spec、Correctness、Security、Recovery 覆盖范围沿用 2026-10-13 的详细审查，并以本次拆分后完整候选重新验证基础门禁；原生视觉仍未验收，Windows CI 生命周期超时另行记录，不将其列为通过。

候选 tree `f153797a1de11b77e94d78778173a7ccff717972`，parent `9d97da1211f26a848b9ff9f2c82aefca9e8ebb2e`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-1S7LQ2\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


## 2026-10-14 — 分批提交：一键启动与开发回归流程

提交根目录 npm run dev、README/运行说明，并为跨栏两轮表单操作的单个正确性测试设置 15 秒执行时限，保留所有断言。初始同一用例两次 5 秒超时记录保留；修正后定向及全套候选验证通过。Spec/Correctness 为顺序准备依赖、失败短路、复用既有桌面监督和启动路径；Security 无新管理 token 或持久凭据；Recovery 复用 2026-10-13 同一启动命令的两次真实启动/退出证据，不修改产品性能门禁。

候选 tree `347c783194cedba84a0cb0908ff67c50aa1fb429`，parent `6c454ebf545c53ab0376b4b117230953909990d7`；证据 `C:\Users\GRIT-LRJ\AppData\Local\Temp\state-hub-candidate-BiyUQE\evidence.json`。冻结安装和 test/test:acceptance/check/build 全部 exit 0；提交前核对 index tree 未变化，提交后再核对 commit tree。本次用户明确授权按功能提交和推送，验证范围为该批代码基础门禁，不等于跨平台发行或性能验收；不关闭 Issue。


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
