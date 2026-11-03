# Windows 安装与卸载闭环验证

2026-10-27，Bun **1.4.4**，Windows 11 x64，当前非提升用户，分支 `codex/windows-bridge-phase2-4`。本文证明本机安装/驻留/卸载子集，**Gate 3/4 尚未准出**。

## 已合入 Windows 平台模块的行为

- `coderail install` 仅接受编译后的 Windows CLI；将包复制到当前用户状态目录的 `bin/current/coderail.exe`，写安装 id/物理 root/SHA256、所有权 journal，注册 HKCU Run 和用户 PATH。先安装、后配对；配对前不会启动未授权 Bridge。未知启动项或非自有目录拒绝。
- 通过安装路径执行 `coderail pair <site>` 后，隐藏 supervisor 持续运行，配对 CLI 可正常退出。所有 Bridge 子进程在创建时归入 Job；重启先排空旧 Job。
- `coderail uninstall` 先以安装 id、物理 root、预期启动命令和 PATH journal 校验所有权，再撤回本安装拥有的注册表项，最后请求清理 actor。命令输出明确为 **cleanup scheduled**；最终删除发生在调用 CLI 退出之后，失败保留 `cleanup-error-<nonce>.txt`，不将握手当成已删完。
- 运行中：supervisor 在 Bridge Job 之外创建清理 actor，actor 自持 kill-on-close Job 句柄；SHA256 验证读取的实际 helper 字节后在内存加载，握手检查 PID、创建时间、nonce、Job 句柄。随后停止旧 Bridge Job，精确等待调用者/host 退出，删除文件。
- 未运行：本地 CLI 启动同样的内存 actor。它继承任何外层 Job，**没有逃逸机制**；不能将此路径作为远程受管命令中的持久驻留保证。远程运行应由存活的 supervisor 交接。
- 原生 no-follow 相对句柄递归预检整棵自有树；拒绝 Junction、硬链接、只读文件、未知顶层文件与活动锁。先预检，再删除；中文、Emoji、超过 MAX_PATH 的子树通过。
- PATH 撤回 journal 记录删除前后值，处理“注册表已写入、journal 还未确认”的重试；不多删后来添加的同名 PATH 条目。完成撤回后重复调用不再更改 PATH。恢复遇到其他进程修改的歧义值会拒绝，不能声称提供跨进程注册表原子事务。
- PATH 提交通知通过独立受管 helper 发送 `WM_SETTINGCHANGE/Environment`，超时清理整个 helper Job，报告通知失败而不假装撤销已提交注册表。依据：[Microsoft WM_SETTINGCHANGE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange)、[SendMessageTimeout](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)。现有终端仍持有自己的旧环境。

## 可复现命令与实际结果

```powershell
npx --yes --package bun@1.4.4 bun test scripts/poc-win/09-user-service
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json --noEmit
npx --yes --package bun@1.4.4 bun run check
Push-Location bridge
npx --yes --package bun@1.4.4 bun scripts/build.ts windows-x64
Pop-Location
npx --yes --package bun@1.4.4 bun scripts/poc-win/09-user-service/compiled-lifecycle.ts
npx --yes --package bun@1.4.4 bun scripts/poc-win/09-user-service/compiled-lifecycle.ts --paired
```

最后两个是**显式测试脚本**，不纳入日常 test 自动发现：会短暂操作实际 HKCU CodeRail/Path；已有 CodeRail 启动项时直接拒绝。测试保存私有恢复快照，不覆盖未知状态；结束核对启动项删除和 PATH 原值恢复。两种编译 CLI 场景均已实测通过。

```json
{"compiledInstallUninstall":true,"noNodeBunOnPath":true,"pairedBackground":true,"cloudflareE2E":false,"ownStartupRemoved":true,"pathRestored":true,"installedImageRemoved":true,"ownedServiceProcessesRemaining":0,"realRelog":false,"cleanRoom":false}
```

配对场景的服务器是测试进程中的本地协议 fixture，明确不代表 Cloudflare 端到端。安装的真实 EXE 被执行，并在其自身退出后删除；测试不是只删一个未执行的 PE fixture。

产物 `bridge/build/coderail-windows-x64.exe`：119814144 bytes，SHA256 `ed57335e79e98296767785f10a623d6813b6d33afba5e923f5b43da44c68b253`。构建本身无发布动作。

服务套件此前一次修正后 **35 PASS / 0 FAIL / 212 assertions**；随后迁入平台模块的定向 9 文件 **13 PASS / 0 FAIL / 92 assertions**，安装→卸载两状态另 **2 PASS / 14 assertions**，环境通知独立 **1 PASS / 2 assertions**。最新整合回归 **85 PASS / 0 FAIL / 500 assertions / 44 files / 104.37s**，全库 check 0 error / 既有 warning 1；Bridge/PoC tsc、license headers、diff whitespace 检查通过。真实安装脚本与普通套件必须串行，避免临时 PATH 修改干扰不变断言。

## 尚未准出

- 更新暂存已验证长度/完整 SHA256/x64；另有停服双目录切换/健康失败回退 PoC 1 PASS/16 assertions，运行中更新、更新 journal 恢复与稳定 helper 升级尚未实现；不开放 `update` 假入口。
- 安装出错后的文件撤回保留所有权与诊断；完整文件删除过程中突发断电/进程终止的事务恢复没有保证。外部文件锁或用户新文件导致目录保留时必须报告失败。
- writer 日志自动轮转、真实 Cloudflare 网页/手机审批与断线历史回放、Windows CI 发布与下载入口尚未完成。
- 真实另一个标准用户、重登自启、睡眠恢复与净室卸载未验收。现有当前用户非提升测试和网络故障注入不替代这些项目。
- GitHub 当前账号为组织 member；组织 runner API 403、仓库 runner 0 的条件尚未解除。需要组织 owner 授权或开放 Runner Group 和实际标签，未触发 Actions。
