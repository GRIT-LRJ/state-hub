# 提交与结案验证

## 验证哪个版本

工作树测试只证明当前工作树，不能证明其中一部分提交或某个旧 HEAD。

提交前显式暂存本次修改，然后运行：

```sh
node tools/verify-candidate.mjs
```

该命令导出 Git index 的完整 tree 到新的临时目录，按锁文件安装依赖，依次运行 `pnpm test`、`pnpm test:acceptance`、`pnpm check`、`pnpm build`。不复制原工作树的依赖或编译产物。输出的 `evidence.json` 记录 tree、父提交、锁文件摘要、环境、逐项退出码及日志位置；任何失败都不会标为 PASS。临时目录保留供调查。

commit 后用 `git rev-parse HEAD^{tree}` 与 evidence 的 tree 核对。二者相同才可把这份测试证据归属于该提交。之后更改 index 或代码需要重新验证；仅有提交信息不同不会改变 tree。

纯说明文档的收尾可以复用最近已验证的代码结果，前提是审查确认 diff 不含代码、依赖、构建输入、运行配置、测试或 CI 修改。记录被验证的代码 commit/tree 以及文档 diff；不要声称文档提交的 tree 与旧证据相同。涉及可执行行为或验收门禁的修改仍必须重新运行对应门禁。这样既保留证据边界，也避免为不影响程序的措辞修订重复运行全部产品测试。

CI 的 `verify.yml` 在 push 和 pull request 上从 checkout 运行四项基础门禁、release policy 单元测试和 Windows 真实桌面生命周期验收。Windows 临时数据库使用 RUNNER_TEMP，避免系统 TEMP 磁盘差异。CI 通过不能替代本地未覆盖的原生视觉、签名或跨平台发行验收。

## 当前阶段：可启动、可使用

2026-10-14 用户明确调整优先级：100 events/s、100 ms 输入 P95、1 s 启动等指标的合理性尚未确认，不再作为当前阶段的硬门禁。保留功能测试中的请求成功、持久化、投递、重启恢复及退出回收断言，也保留防止永远等待的测试超时；超时是失败保护，不表示已确定产品响应目标。

性能由手动 `performance-report.yml` 或 `pnpm test:performance` 测量，默认输出 `reference-only`、实际值和 `referenceTargetsMet`。超出旧参考值不使功能检查失败；运行错误、无效测量和正确性断言失败仍退出非零。`STATE_HUB_ENFORCE_PERFORMANCE_TARGETS=1` 仅供主动对照旧目标，不能据此重新宣称未经确认的目标成为正式要求。带 CPU 采样的 `performance-diagnostics.yml` 只用于定位，不与无采样基线混用。

Issue #22 显式记作 DEFERRED，既不伪造 PASS，也不阻断当前产品门禁。stable policy 只对 #22 的 DEFERRED 状态作例外，其余功能、原生包装、签名、公证和安全要求照常拒绝未通过项。重新启用性能硬门禁必须先补齐负载/环境/测量定义并获得用户确认。

## 验证哪些行为

每个 Issue 的结案记录必须把 acceptance criterion 对应到实际测试和可观察断言。至少区分：

- 单元逻辑：例如退避上限、状态仲裁、脱敏规则。
- 真实 Core：通过 HTTP 请求、持久数据库和真实进程验证接受、恢复及投递。
- 真实桌面：启动 Tauri 可执行文件，验证其自动监督 Core、界面重连及退出回收。测试中手动重启 Core 只证明客户端重连，不能代替监督验收。
- 容量：事件路径与状态投影路径分别测量，不能用 append-only 成绩代表仲裁路径。
- 发行：已安装程序、平台、签名、升级和启动性能分别有证据，不能用前端 Vite build 代替。

四项基础门禁全部通过只是必要条件。Spec、Correctness architecture、Security 和 Crash/recovery review 必须说明检查范围；没有执行或没有覆盖的条件保持未通过。

## 发现历史 PASS 的阻断

保留旧提交和历史证据，在 `ISSUE_PROGRESS.md` 撤回受影响 Issue 的当前 PASS，指出哪个验收条件失效。把所需正确性修复作为独立提交完成，避免藏在尚未完成的打包或发布工作树中。修复后重新验证受影响链路，再恢复结案状态。

推送和关闭 Issue 是两个动作：推送已验证提交不表示所有 Issue 完成；关闭必须满足该 Issue 的全部验收依赖。施工日志记录修复行为、曾发现的问题和实际证据，不用测试数量替代规格覆盖。
