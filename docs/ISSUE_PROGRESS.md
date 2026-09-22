# Issue 施工总表

事实源：GitHub Issue #1、各子 Issue 全文、`docs/ARCHITECTURE.md`。`阻塞依赖` 是实施 DAG；`验收依赖` 不阻止开始写代码，但阻止最终 PASS。状态描述的是本地代码与验收结果，GitHub open/closed 状态另行核对。执行顺序优先保证正确性与安全边界，再做运行时、管理界面、集成、性能及发布。

| Issue | 状态 | 优先级 | 阻塞依赖 / 验收依赖 | 核心修改与模块 | 当前可实施 | Tests | Review | Commit |
|---|---|---|---|---|---|---|---|---|
| #1 总规格 | IN PROGRESS | 总验收 | 所有子 Issue | 全系统最终黑盒/白盒验收 | 否，等待子项 | 待最终审查 | 待最终审查 | — |
| #2 Core 验收 Harness | PASS | 基础 | 无 / 无 | 真实 Core HTTP/SSE 测试基础 | 已完成 | PASS | PASS | e99f6cc |
| #3 插件安装、信任与 Catalog | PASS | Critical | 无 / #2 | 持久验包、publisher 信任、动态定义与来源校验 | 已完成 | pnpm verify PASS | Spec/Correctness/Security PASS | c42694a |
| #4 独立插件进程 | PASS | Critical | #3 / #2 | 子进程、握手、健康、故障隔离与 stateful 恢复 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | 20ed2e4 |
| #5 插件旁路升级 | PASS | Critical | #4 / #2 | 旁路迁移、活动版本与配置 revision 原子激活、崩溃恢复 | 已完成 | pnpm verify PASS | Spec/Correctness/Security/Recovery PASS | 348f1a9（基础设施 ce22ccf） |
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
| #16 Sidecar 与 SSE 恢复 | TODO | High | 无 / #2 | 桌面进程监督、快照后订阅 | 是 | 待运行 | 待审查 | — |
| #17 来源与 PushPlus 管理 | TODO | High | 无 / #2、#16 | 来源、凭据引用、UI | 是 | 待运行 | 待审查 | — |
| #18 驱动与配置管理 UI | TODO | High | #10 / #2、#16 | DriverInstance、Binding、revision UI | 是，待 #16 验收 | 待运行 | 待审查 | — |
| #19 暂停、确认与诊断 UI | TODO | High | #7、#14 / #2、#16 | 运行管理、确认、支持包 | 是 | 待运行 | 待审查 | — |
| #20 Codex spool 验收 | TODO | High | 无 / #2、#8、#9 | hook、spool、drain 黑盒验收 | 是 | 待运行 | 待审查 | — |
| #21 VK87 契约验收 | TODO | High | 无 / #2 | fake HID、选择器、65 字节 profile | 是 | 待运行 | 待审查 | — |
| #22 容量与延迟验收 | TODO | Medium | #2、#8、#9、#10、#12、#13、#15 / 无 | 真实 Core 压测 | 是 | 待运行 | 待审查 | — |
| #23 Packaging 与 Updater | TODO | High | 无 / #2、#16、#17、#18、#19、#22 | 三平台安装与升级 smoke | 是，基础设施可先做 | 待运行 | 待审查 | — |
| #24 Stable 发布门禁 | TODO | High | #23 / #3–#22 | 签名、公证、provenance、stable gate | 否，等待 #23 | 待运行 | 待审查 | — |

`#23` 的跨平台真实 smoke 与 `#24` 的真实签名、公证需要相应平台和发布凭据的客观证据；基础设施代码可先实施。不能把尚未运行的外部验收记为 PASS。
