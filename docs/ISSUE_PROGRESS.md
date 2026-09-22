# Issue 施工总表

事实源：GitHub Issue #1、各子 Issue 全文、`docs/ARCHITECTURE.md`。`阻塞依赖` 是实施 DAG；`验收依赖` 不阻止开始写代码，但阻止最终 PASS。状态描述的是本地代码与验收结果，GitHub open/closed 状态另行核对。执行顺序优先保证正确性与安全边界，再做运行时、管理界面、集成、性能及发布。

| Issue | 状态 | 优先级 | 阻塞依赖 / 验收依赖 | 核心修改与模块 | 当前可实施 | Tests | Review | Commit |
|---|---|---|---|---|---|---|---|---|
| #1 总规格 | IN PROGRESS | 总验收 | 所有子 Issue | 全系统最终黑盒/白盒验收 | 否，等待子项 | 待最终审查 | 待最终审查 | — |
| #2 Core 验收 Harness | PASS | 基础 | 无 / 无 | 真实 Core HTTP/SSE 测试基础 | 已完成 | PASS | PASS | e99f6cc |
| #3 插件安装、信任与 Catalog | TODO | Critical | 无 / #2 | 插件安装、信任库、动态定义 | 是 | 待运行 | 待审查 | — |
| #4 独立插件进程 | TODO | Critical | #3 / #2 | JSON-RPC、子进程与隔离 | 否，等待 #3 | 待运行 | 待审查 | — |
| #5 插件旁路升级 | TODO | Critical | #4 / #2 | 升级校验与原子激活 | 否，等待 #4 | 待运行 | 待审查 | — |
| #6 插件安全卸载 | TODO | Critical | #3 / #2 | 依赖检查与卸载 | 否，等待 #3 | 待运行 | 待审查 | — |
| #7 ClaimIdentity 防碰撞 | PASS | High | 无 / #2 | 确认、转换、贡献者身份 | 已完成 | PASS | Spec/Correctness PASS | ecd9ef6 |
| #8 生产者事务边界 | PASS | 正确性基础 | 无 / #2 | 命令、账本、投影、outbox 原子提交 | 已完成 | PASS | PASS | a417699 |
| #9 TTL 与投影 revision | PASS | 正确性基础 | 无 / #2 | 到期调度、回落、旧投影抑制 | 已完成 | PASS | PASS | 6d166a6、c9786f0 |
| #10 配置生命周期 | TODO | High | #3 / #2 | 校验、revision、驱动热激活 | 否，等待 #3 | 待运行 | 待审查 | — |
| #11 HTTP 目标授权 | TODO | High | 无 / #2 | SSRF 防护与具体目标授权 | 是 | 待运行 | 待审查 | — |
| #12 Delivery 恢复 | PASS | 正确性基础 | 无 / #2 | lease、恢复、fencing | 已完成 | PASS | PASS | c9786f0 |
| #13 Append-only 投递 | PASS | Medium | 无 / #2 | 批处理、重试、TTL、死信 | 已完成 | PASS | Spec/Correctness PASS | de8b4e6、cfe4d86 |
| #14 支持包脱敏 | PASS | High | 无 / #2 | 来源分类、预览与导出 | 已完成 | PASS | Spec/Correctness/Security PASS | 5c9992d |
| #15 统一历史保留 | PASS | Medium | 无 / #2 | 保留预算、持久防重身份 | 已完成 | PASS | Spec/Correctness PASS | 4d3c178 |
| #16 Sidecar 与 SSE 恢复 | TODO | High | 无 / #2 | 桌面进程监督、快照后订阅 | 是 | 待运行 | 待审查 | — |
| #17 来源与 PushPlus 管理 | TODO | High | 无 / #2、#16 | 来源、凭据引用、UI | 是 | 待运行 | 待审查 | — |
| #18 驱动与配置管理 UI | TODO | High | #10 / #2、#16 | DriverInstance、Binding、revision UI | 否，等待 #10 | 待运行 | 待审查 | — |
| #19 暂停、确认与诊断 UI | TODO | High | #7、#14 / #2、#16 | 运行管理、确认、支持包 | 否，等待 #7、#14 | 待运行 | 待审查 | — |
| #20 Codex spool 验收 | TODO | High | 无 / #2、#8、#9 | hook、spool、drain 黑盒验收 | 是 | 待运行 | 待审查 | — |
| #21 VK87 契约验收 | TODO | High | 无 / #2 | fake HID、选择器、65 字节 profile | 是 | 待运行 | 待审查 | — |
| #22 容量与延迟验收 | TODO | Medium | #2、#8、#9、#10、#12、#13、#15 / 无 | 真实 Core 压测 | 否，等待 #10、#13、#15 | 待运行 | 待审查 | — |
| #23 Packaging 与 Updater | TODO | High | 无 / #2、#16、#17、#18、#19、#22 | 三平台安装与升级 smoke | 是，基础设施可先做 | 待运行 | 待审查 | — |
| #24 Stable 发布门禁 | TODO | High | #23 / #3–#22 | 签名、公证、provenance、stable gate | 否，等待 #23 | 待运行 | 待审查 | — |

`#23` 的跨平台真实 smoke 与 `#24` 的真实签名、公证需要相应平台和发布凭据的客观证据；基础设施代码可先实施。不能把尚未运行的外部验收记为 PASS。
