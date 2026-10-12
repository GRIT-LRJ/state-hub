# Issue 施工总表

事实源：GitHub Issue #1、各子 Issue 全文、`docs/ARCHITECTURE.md`。`阻塞依赖` 是实施 DAG；`验收依赖` 不阻止开始写代码，但阻止最终 PASS。状态描述的是本地代码与验收结果，GitHub open/closed 状态另行核对。执行顺序优先保证正确性与安全边界，再做运行时、管理界面、集成、性能及发布。

## 2026-10-12：修复进度（最新）

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
| #22 容量与延迟验收 | PASS | Medium | #2、#8、#9、#10、#12、#13、#15 / 无 | 真实事件与状态投影负载、共享资源竞争、重启后真实 HTTP 重放；优化查询和调度让步 | 已完成本地规定规模验收 | 隔离 tree 四项门禁、test:performance PASS；无 SSE 订阅场景 | Spec/Correctness/Standards/Security PASS | c934ba5、3325dfb |
| #23 Packaging 与 Updater | BLOCKED | High | 无 / #2、#16、#17、#18、#19、#22 | 三平台安装与升级 smoke；Windows 已完成真实安装、签名升级和失败恢复 | Windows 未签名 EXE 创建约 3.3 秒，首屏超标；macOS/Linux 真实运行仍缺证据；现已获推送授权，但发行工作流尚未纳入本次验证提交 | 四项基础门禁、Rust 6/6、release 11/11、sidecar、Windows 更新 smoke PASS；驱动激活 P95 100.84ms；安装首屏 P95 4485ms FAIL；进程创建对照已记录 | Spec FAIL：首屏性能和 macOS/Linux 真机证据未达标；Correctness 架构局部 PASS；Can commit NO | — |
| #24 Stable 发布门禁 | BLOCKED | High | #23 / #3–#22 | 版本/产品验收 fail-closed gate、三平台签名/公证验证、候选产物证明与四目标 manifest 组装 | 候选流水线和离线组装已实现；#23、正式签名/公证凭据和三平台候选验证未满足 | release 11/11、YAML 语法 PASS；真实签名/公证/证明未运行 | Spec FAIL：#23 和真实候选证据缺失；Can commit NO | — |

`#23` 的跨平台真实 smoke 与 `#24` 的真实签名、公证需要相应平台和发布凭据的客观证据；基础设施代码可先实施。不能把尚未运行的外部验收记为 PASS。Windows 安装首屏的实测 P95 仍超过 1 秒，也属于技术阻断，不是领域决策。
