# Issue 施工总表

事实源：GitHub Issue #1、各子 Issue 全文、`docs/ARCHITECTURE.md`。`阻塞依赖` 是实施 DAG；`验收依赖` 不阻止开始写代码，但阻止最终 PASS。状态描述的是本地代码与验收结果，GitHub open/closed 状态另行核对。执行顺序优先保证正确性与安全边界，再做运行时、管理界面、集成、性能及发布。

## 2026-10-14：分功能提交与推送（最新）

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
| #22 容量与延迟验收 | TODO | Medium | #2、#8、#9、#10、#12、#13、#15 / 无 | 真实事件与状态投影负载、共享资源竞争、重启后真实 HTTP 重放；优化查询和调度让步 | 已有实现保留；用户将 Windows CI 性能优化延后，不阻塞本次启动/运行验收 | Windows CI 基础门禁 PASS、事件性能 FAIL；此前本地/独立 Linux 性能 PASS | Correctness/Architecture 静态 PASS；性能未达标证据保留 | c934ba5、3325dfb（均保留） |
| #23 Packaging 与 Updater | BLOCKED | High | 无 / #2、#16、#17、#18、#19、#22 | 三平台安装与升级 smoke；Windows 已完成真实安装、签名升级和失败恢复 | Windows 未签名 EXE 创建约 3.3 秒，首屏超标；macOS/Linux 真实运行仍缺证据；基础设施已提交；真实发行验收继续保留 | 四项基础门禁、Rust 6/6、release 11/11、sidecar、Windows 更新 smoke PASS；驱动激活 P95 100.84ms；安装首屏 P95 4485ms FAIL；进程创建对照已记录 | Spec FAIL：首屏性能和 macOS/Linux 真机证据未达标；Correctness 架构局部 PASS；基础设施已提交；发行验收仍未通过 | 9d97da1（基础设施） |
| #24 Stable 发布门禁 | BLOCKED | High | #23 / #3–#22 | 版本/产品验收 fail-closed gate、三平台签名/公证验证、候选产物证明与四目标 manifest 组装 | 候选流水线和离线组装已实现；#23、正式签名/公证凭据和三平台候选验证未满足 | release 11/11、YAML 语法 PASS；真实签名/公证/证明未运行 | Spec FAIL：#23 和真实候选证据缺失；基础设施已提交；发行验收仍未通过 | 9d97da1（基础设施） |

`#23` 的跨平台真实 smoke 与 `#24` 的真实签名、公证需要相应平台和发布凭据的客观证据；基础设施代码可先实施。不能把尚未运行的外部验收记为 PASS。Windows 安装首屏的实测 P95 仍超过 1 秒，也属于技术阻断，不是领域决策。

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
