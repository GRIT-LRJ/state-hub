# 真实桌面生命周期验收

本测试启动实际 Tauri、WebView 和打包 Core，使用独立的应用 identifier 和临时数据目录。测试窗口隐藏，不使用开发者的日常配置。它与客户端连接状态机的单元测试互补。

Windows PowerShell：

```powershell
pnpm install --frozen-lockfile
pnpm build:sidecar
$env:VITE_STATE_HUB_LIFECYCLE_SMOKE = '1'
pnpm --filter @state-hub/desktop tauri build --no-bundle --features lifecycle-smoke --config src-tauri/tauri.lifecycle-smoke.conf.json
Remove-Item Env:VITE_STATE_HUB_LIFECYCLE_SMOKE
node tools/desktop-lifecycle-smoke.mjs apps/desktop/src-tauri/target/release/state-hub-desktop.exe
```

Rust/Cargo 需要在 PATH 中。测试专用构建必须同时启用 Cargo feature 与 Vite 标记；日常构建不包含故障注入逻辑。该可执行文件仅用于验收，不作为发行包。

测试分别断言：

1. **Core 崩溃自动恢复**：真实界面取得快照并收到 SSE 后，测试杀死 Core；由 Rust supervisor 自动启动下一代 Core，界面完成第二代连接；随后通过正常 Tauri exit 路径退出。Windows 可重用 PID，因此以实际 spawn 和连接代次证明恢复。
2. **启动失败有上限**：给 Core 一个确定无法作为数据库打开的路径；恰好启动五次后报告耗尽，不无限重启。
3. **桌面异常退出**：界面首次连接后外部 runner 终止自己启动的桌面进程；Core 在父管道关闭后退出。
4. **无遗留 Core**：上述每种情形都核对所有受测 Core 进程已退出；Windows 同时检查 PID 与程序路径，区分 PID 已被重用的情况。

输出给出临时证据目录，其中记录代次、PID、连接和退出结果，不包含管理 token。保留目录便于失败调查。单元测试另外验证 snapshot-before-subscribe、竞态、退避和 stale ready fencing。

失败场景显式记录 FAIL。Windows 存活检查同时核对程序路径；失败清理在同一个已持有的进程句柄上验证身份并终止，避免误伤复用旧 PID 的进程。真实浏览器连接还验证了管理 API 的预检与 SSE 跨域响应；仅 Node HTTP 客户端通过不能证明浏览器可以连接。

这些结果只证明所测试平台上的生命周期行为；不替代安装包、签名、公证、升级或启动性能验收。
