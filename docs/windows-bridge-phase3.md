# Windows Phase 3：用户态驻留 PoC

## 最新进展（覆盖下方历史待办状态）

最终扩大回归（含安装恢复）：**71 PASS、0 FAIL、415 assertions、36 文件、91.39s**。全库 check 仍为 0 error /既有 warning 1，新增 PoC tsc/license headers 通过；Gate 3/4 仍未准出。

新增安装恢复 PoC **1 PASS、15 assertions**：真正让安装进程在注册表提交后退出 42（不经过 catch 回滚），由新进程/调用重新读取 journal 恢复自有 PATH 与启动项，重复恢复通过；安装 id/entry 篡改和第三方启动项改动被拒绝。文件仍保留，不能声称完整恢复/零残留卸载。`install-recovery.ts` 暂未迁入正式目录。

更新：完整整合 **70 PASS、0 FAIL、400 assertions、35 文件、90.65s**；全库 check 0 error / 既有 warning 1，Bridge/PoC tsc 通过。新增真实父 CLI 退出用例先失败后修复，supervisor 启动已加 `detached:true`。只 unref 的旧测试遗漏已确认，不再沿用其驻留结论。手工代理原生读取、HTTP/WS+CONNECT、环境优先级和绕过规则已验证；未实现 PAC/WPAD 自动求解或 SOCKS。内存加载 helper 的删除机制 PoC 可行，但完整卸载尚未实现。

剩余生命周期闭环的具体安全约束与实测结果见 [下一步实现边界](windows-bridge-phase3-lifecycle-plan.md)。在最新完整套件之后，端口按根 PID 扫描也改用创建时间约束的子树捕获，真实 Vite/HMR + 身份回归 **2 PASS、17 assertions**。

当前最终整合 **63 PASS、0 FAIL、362 assertions、30 文件、88.73s**，全库 check 0 error / 既有 warning 1。最新单文件程序（119737856 bytes）在 PATH 仅有 System32 时，实际运行 version、中文 Emoji logs、未配对 status 成功。复跑：`npx --yes --package bun@1.4.4 bun scripts/poc-win/09-user-service/compiled-cli.ts`。SHA256 与完整回归输出位置见 [最新断点](windows-bridge-phase2-progress.md)。Gate 3/4 仍未通过。

后续完整回归：**60 PASS、0 FAIL、351 assertions、29 文件、85.77s**；服务生命周期额外连续 4 轮通过。新增正式 `logs`/`logs -f` **3 PASS、10 assertions**，验证 UTF-8 分块、追加、截断、文件替换与退出；硬链接拒绝通过，文件 Symlink 创建受本机 EPERM 限制，未验收该分支。没有自动轮转 writer，不能把外部测试换文件说成自动轮转已完成。

历史故障：扩大回归先有一次整树停机等待超时，再有夹具 PID JSON 的 Unexpected EOF。新增进程创建时间过滤与剩余身份诊断、夹具原子写就绪文件；前者是明确存在的 PID 归属缺陷，但未保留首次超时的进程身份，不能据此断言首次超时的确定根因。修复后完整回归与四轮额外生命周期均通过，稳定性后续持续观察。

`install-transaction.test.ts` 已验证未配对安装仅注册、冲突拒绝，以及注册表写入提交后注入故障的 PATH/启动项回滚；只用 UUID 值，真实 PATH 不变。保留的自有文件和 journal 仍需恢复/清理流程，未接主 CLI。详细独立入口见 [PoC 说明](../scripts/poc-win/09-user-service/README.md)。

Bun 1.4.4 全部整合回归 **56 PASS、0 FAIL、327 assertions、26 文件、84.63s**；全库 check 0 error / 既有 warning 1。**Gate 3 仍未准出**。

- supervisor 自身持有重启生命周期：旧 Job 清零后才启动新 Bridge，supervisor PID 不变；不再依赖即将被杀的 Bridge 子进程完成重启。正式 service 支持仅注册、暂不启动，供未配对安装使用。
- 发布构建已预编译并嵌入 x64 GUI supervisor，测试验证二进制提取；开发模式保留 C# 编译回退。pair/restart CLI 已支持，完整 install/update/uninstall 尚未接入。
- 防止后台状态攻击：完整目录链 pin、拒绝 reparse，日志/锁硬链接保护；metadata 使用句柄相对原子写入。独立测试验证外部 sentinel 不变。
- npm Codex 原生包与桌面应用本机缓存发现通过，支持无应用注入 PATH 的环境，不执行 `.cmd` shim；尊重显式原生 CODEX_PATH。尚未实际重登验证 Explorer 的新登录环境。
- 正式 Bridge 测试覆盖 token 请求黑洞、卡住的 WebSocket upgrade、注入时钟间隙，五秒内恢复；不是实际 sleep/resume 或 Wi-Fi 切换验收。
- 安装目录/二进制所有权和用户 PATH 注册表保存仍为独立 PoC，只使用 UUID 测试值，不修改真实用户 PATH。升级暂存额外 **1 PASS、8 assertions**：SHA256/长度/x64 校验、重复暂存与篡改拒绝，旧安装不变；无切换/回滚实现，不宣称升级已完成。

仍需完整 CLI 事务与卸载清理、日志查看/轮转、更新激活/回滚、现有 Cloudflare Worker 真实配对及手机远程链路、真实标准用户/重登/休眠。没有创建永久 CodeRail 启动项，未部署或发布。

2026-10-27 America/Chicago，分支 `codex/windows-bridge-phase2-4`。**Gate 3 未准出**。候选真实测试通过后已渐进移入正式平台 service 模块，PoC 再导出同一实现。没有创建永久 CodeRail 启动项。

最新正式编译 Bridge 本机闭环：`bridge-service.test.ts` **1 PASS、5 assertions、9.31s**；GUI supervisor 启动正式 main.ts 编译产物，连接仅在 loopback 的 Worker 协议测试端，发送 Windows hello，执行协作停止，临时启动项移除。不是 Cloudflare 远程 E2E。main.ts 已接入 supervisor 私有 nonce 文件协作停机，Agent/命令环境不会继承该控制路径。

扩大整合回归最终：**46 PASS、0 FAIL、278 assertions、18 文件、63.64s**；全库 check 0 error/既有 warning 1。Windows 平台 service status/install/uninstall 已接入，完整 install/pair/update/uninstall CLI 仍待完成。

创建时 Job list、完整嵌入式运行器与服务候选合并回归：**14 PASS、0 FAIL、84 assertions、30.41s**。正式 service 再导出后的三个生命周期测试 **3 PASS、24 assertions、12.84s**。当前扩大整合回归仍在运行，以最终输出为准。

## 已实测

`scripts/poc-win/09-user-service/`：

- `supervisor.cs`：.NET Framework C# 编译为约 10KB WinExe，PE subsystem=GUI，无需系统级 Service 或提升权限。继承当前用户环境/认证目录，UTF-8 日志；独占 lock 防双开，PID+创建时间防止状态中的 PID 被复用。目录链通过原生句柄真实路径校验并拒绝 reparse，句柄固定后操作私有状态目录。
- 创建子进程通过 STARTUPINFOEX 的 Job list，在 CreateProcessW 中指定 KILL_ON_JOB_CLOSE Job，再恢复初始线程；仅显式 log handle 可继承。不存在先创建、再用户态分配 Job 的间隙。协作停止先写私有请求文件，等两秒后仍未退出则关闭 Job。
- `autorun.ts`：HKCU Run，UUID 测试项中文往返、幂等注册、所有权冲突保护、精确移除通过；没有碰用户其他启动项。遵守 Run 命令行 260 字符限制，超限拒绝执行。
- `service.ts`：隔离候选安装/重复启动/重启/卸载，真实编译 Bun fixture，真实后台进程及 ping 后代，协作停止并等待整树归零。只操作 UUID 临时目录和 `CodeRail-PoC-*` 启动值。

本轮三个测试最近完整结果 **3 PASS、0 FAIL、24 assertions、11.89s**（随后补强创建时 Job list，supervisor 独立重测通过，完整整合复跑中）。C# 编译器：本机 `%SystemRoot%/Microsoft.NET/Framework64/v4.0.30319/csc.exe`。后续发布包应附带预编译辅助程序，安装不应强依赖现场编译器；开发回退需明确失败信息。

```powershell
npx --yes --package bun@1.4.4 bun test scripts/poc-win/09-user-service
```

## 选型理由与边界

HKCU Run 保持用户登录会话和个人开发环境，无管理员要求；系统可以延迟执行启动项，因此不承诺登录后固定秒数开始运行。[Microsoft Run 文档](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)。无需使用有标准用户限制的 RunOnce。托盘首期不实现。

不把主 CLI 编译为 GUI 子系统，避免命令行等待/输出行为变化；轻量 WinExe 仅负责无窗口后台运行、Job 与日志。没有依赖 Windows 11 上可能为可选组件的 VBScript。

Job list 与显式继承句柄列表来自 [UpdateProcThreadAttribute 官方接口](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。支持 Windows 10+；本轮只实测当前 Windows 11 x64，不能代替所有系统版本验收。Bun 正式运行器已从相同 PoC 采用创建时 Job list，并仍保留 x64 限制。

待完成：完整 CLI 安装/配对别名、安装位置/PATH/代理、轮转日志、版本 manifest/SHA256/双目录升级回滚、Wi-Fi/休眠快速重连、防火墙指引；预编译 helper 打包与安装回退。另需独立标准用户、真实重登/休眠和干净安装验收。当前账户为非提权运行，不能等同独立标准账户。尚未触发 Actions、部署 Cloudflare、发布或 push。
