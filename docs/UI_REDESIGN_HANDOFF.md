# UI 重构交付与续接记录

## 提交状态（2026-10-14）

已按功能提交并推送；六栏 UI 为 6c454eb，一键开发流程为 d6f4253。最新验证与远端 CI 边界见 [Issue 进度](ISSUE_PROGRESS.md) 和 [施工日志](AI_IMPLEMENTATION_LOG.md)。没有关闭 Issue 或正式发布。

## 实现验收记录（2026-10-13）

用户恢复任务后，六栏重构与 grill-with-docs 文档已实现，隔离候选树四项基础门禁和 Windows 桌面生命周期均通过。原生截图/点击通道不可用，默认及最小窗口、缩放、长名称的视觉验收仍未覆盖；不据此关闭 Issue 或宣布发行通过。

2026-10-12 的暂停与失败测试是历史记录，详见 [施工日志](AI_IMPLEMENTATION_LOG.md) 和 [Issue 进度](ISSUE_PROGRESS.md)；已由本次实现与自动化结果更新。截至该日尚未提交或推送；2026-10-14 已按上述批次提交。Issue 未关闭。

## 已完成的产品决定

- 单窗口固定侧栏：概览、来源、输出、规则、诊断、设置；启动进入概览。
- 输出与规则按次独立审阅、独立应用，不使用跨栏统一草稿。输出允许没有规则；规则只选择已生效输出。切栏保留本次运行内的编辑，应用当前操作不夹带另一栏内容。
- 表单中文解释、规则分组、就地凭据和 Codex/PushPlus 分步引导。快捷流程允许中途结束，不暗中覆盖对象或轮换凭证。
- 来源 Token、凭据、全局暂停和状态确认明确立即生效。最近投递按需读取最多 500 条脱敏记录；支持包仍先预览再导出。
- 设置分为凭据、配置版本、关于；回滚恢复整套输出与规则，不恢复密钥或来源授权。

## 文档入口

[上下文地图](../CONTEXT-MAP.md)、[桌面上下文](../apps/desktop/CONTEXT.md)、[术语表](../apps/desktop/GLOSSARY.md)、[设计与六栏使用讲解](../apps/desktop/docs/UI-DESIGN.md)、[独立操作决策](../apps/desktop/docs/adr/0001-independent-configuration-operations.md)。

## 验证证据

- 隔离候选 tree：`8edc383ec8e1dd7a81226f8b5369f4ee478ad083`，parent：`68286bed2901036a6dd312ae043c28a8463a679b`。证据：`%TEMP%/state-hub-candidate-gvxmTC/evidence.json`。冻结锁文件安装及 test / test:acceptance / check / build 全部 exit 0。
- 桌面 37 项组件/逻辑测试、Core 90 项单元测试通过；真实 Core 验收包含并发创建来源不轮换旧 Token、系统凭据、配置发布/回滚、状态确认/暂停、断线恢复。
- Windows 原生生命周期：`%TEMP%/state-hub-desktop-lifecycle-rJeLiz/results.json`。监督重启后界面重新连接、五次启动失败后停止、父进程异常退出后清理 Core 三场景通过。这不代替视觉验收。
- 普通桌面程序已重新构建（非 lifecycle-smoke）：`apps/desktop/src-tauri/target/release/state-hub-desktop.exe`，SHA256 `87FBAC10F1463C0FD8DEAD1432C1470FAF9B752257FAD5481FCB6A9E3A002760`。日志：`%TEMP%/state-hub-ui-normal-build-20261013.log`。未创建安装包或替换已安装版本。
- 验证后仅收尾本文件、设计说明、Issue 进度和施工日志四份说明文档；代码证据归属上述 tree，不声称最终文档 tree 相同。

## 仍需注意

原生视觉检查待具备 UI 通道时完成。构建仍报告前端 chunk 大小警告；本次未测启动性能。此前 #22 的 Windows CI 性能未达标，以及 #23/#24 的跨平台、签名与发行验收缺口保持原状态。

任务开始前已有的 #23/#24 updater、首屏计时、发行与性能诊断修改也已保留并分别提交；六栏 UI、发行基础设施和一键启动属于不同提交，不要将整个系列误当作只有 UI 修改。
