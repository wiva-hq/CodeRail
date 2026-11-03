# Windows Bridge 本轮保存与交接（2026-10-27）

保存分支：`codex/windows-bridge-phase2-4`。用户明确要求保存当前进度并 push；本次是未完成阶段的代码检查点，不是发布或 Gate 3/4 准出。正式安装清理实现提交为 `83c6298`，更新、回滚与崩溃恢复实现为 `b6dfea4`。最终 push 的提交 SHA 由执行后与远端核对，避免在提交内容里预填结果。

## 已验证

- Bun 1.4.4 完整整合回归：96 PASS、0 FAIL、612 assertions、50 files。原始日志在 ignored `scripts/poc-win/artifacts/latest-regression.log`；跨机器复现需重新运行，不将本机日志当作已上传附件。
- 全库 `bun run check`：0 error，既有 Svelte a11y warning 1；Bridge 与 PoC TypeScript 检查通过。
- 编译版安装、配对后台运行及卸载通过；实际 HKCU 启动项与用户 PATH 恢复，已捕获服务进程清零。双版本更新、坏 SHA 拒绝、失败回滚和真实 supervisor 崩溃恢复详见 [更新报告](windows-bridge-phase3-update.md)。服务器为本地协议 fixture，不能代替 Cloudflare 端到端验收。
- 最后独立内存 PoC：`K32GetProcessMemoryInfo` 通过绑定进程身份的句柄读取 working set/private bytes，1 PASS、0 FAIL、2 assertions。仅验证当前 Windows x64，未接入正式 CLI status。此项独立执行于 96 项回归之后。

## 精确复现命令（仓库根目录，PowerShell）

```powershell
npx --yes --package bun@1.4.4 bun test bridge/src/platform scripts/poc-win/04-filesystem scripts/poc-win/05-git scripts/poc-win/06-preview scripts/poc-win/07-web-gate/path.test.ts scripts/poc-win/08-runtime-integration scripts/poc-win/09-user-service scripts/poc-win/10-update
npx --yes --package bun@1.4.4 bun test scripts/poc-win/11-observability/memory.test.ts
npx --yes --package bun@1.4.4 bun run check
node bridge/node_modules/typescript/bin/tsc -p bridge/tsconfig.json --noEmit
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json --noEmit
npx --yes --package bun@1.4.4 bun scripts/license-headers.ts --check
```

真实编译安装/更新实验会暂时注册当前用户启动项与 PATH，必须单独串行执行，不能与要求真实 PATH 保持不变的回归同时运行。详见更新报告中的显式运行命令。此检查点没有再次触发完整实机安装。

## 未完成与下一步

Gate 2 本机已通过；Gate 3、Gate 4 保持未通过。

1. 正式 status 的 PID、内存、监听端口详情；日志写入端自动轮转；防火墙首次运行指引。
2. Cloudflare Windows Manifest、下载入口、安装脚本和实际网页/手机端审批、Git、开发预览联调；离线历史回放及兼容性验收。
3. Windows CI runner、签名/SmartScreen 方案与发布验证。当前组织读取权限已恢复，但已查到的 runner 只有 Linux x64 与 macOS ARM64，没有 Windows runner；未触发 Actions，也未修改 runner 配置。
4. 实际另一标准用户、重登自启、休眠恢复、网络切换及净室卸载验收。用户允许本机联调，无需等待虚拟机；尚未执行的验收不计通过。
5. helper ABI 升级迁移方案及卸载文件删除中途崩溃的完整恢复保障。

失败探针目录 `%TEMP%\crrootupdate-tdJ9EK` 保留诊断文件，其服务已通过通用所有权控制停止，核对无剩余捕获进程；没有以 fixture PID 强杀伪造通过。构建产物与测试工作目录不纳入 Git。

本轮不合并 main、不创建 Release、不部署 Cloudflare、不擅自重启/休眠/提权。恢复自动化保持暂停，既有目标仍未完成。
