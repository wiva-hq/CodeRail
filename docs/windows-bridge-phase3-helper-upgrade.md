# Helper 升级专项 PoC（2026-10-27）

代码仅位于 `scripts/poc-win/12-helper-upgrade/`，尚未迁入 `bridge/src`，也未开放正式 CLI 修复命令。它提供本地树外修复的候选机制，**不证明远程命令树内的 helper 自动迁移完成**。

## 已证明的候选链路

1. 校验当前安装 id、物理 root、注册表 startup 与 ownership journal 一致，候选 helper 的长度、x64 PE 与完整 SHA256 合格。
2. 读取并固定服务根 PID+创建时间，捕获后代身份。调用者在该树内时，变更前拒绝；不把 detached 当作 Job 逃逸。
3. 排他 native lock、保存旧 helper 与阶段 journal；通过现有 UserService.stop 排空旧树，原子写入新 helper。若此前运行，重新启动并检查 helper 与 Bridge 子进程仍存活。
4. 候选启动失败时停止失败树、还原旧字节、重新启动；prepared/stopped/active 三个阶段真实 `process.exit(42)` 后，可在下次显式恢复调用中验证字节并退回旧 helper。

配对配置、安装身份、安装的 Bridge EXE、用户启动命令和 PATH 保持不变。测试使用临时 `CodeRail-PoC-*` 注册表值，结束时撤回；没有重启、注销、休眠、提权或修改防火墙。

## 精确运行与结果

```powershell
npx --yes --package bun@1.4.4 bun test scripts/poc-win/12-helper-upgrade/repair.test.ts
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json --noEmit
npx --yes --package bun@1.4.4 bun scripts/license-headers.ts --check
```

最后运行：**1 PASS / 0 FAIL / 34 assertions / 9.59s**。TypeScript 与许可头通过。

```json
{"outsideTreeHelperReplacement":true,"oldProcessesExited":true,"nestedPingExited":true,"insideTreeCallerRefused":true,"failedCandidateRestored":true,"actualRepairProcessExit":42,"journalRecovery":true,"pairingAndRegistryPreserved":true,"remoteInsideTreeMigration":false}
```

旧、新 helper 为真实编译的正式 supervisor 源码，仅在身份输出额外一行标识代际；Bridge 为真实 C# 子进程，启动嵌套 ping。全部旧根、Bridge、ping 的已固定句柄均确认退出。坏候选是立即退出的真实 x64 PE；备份被篡改时恢复会拒绝。崩溃测试覆盖保存准备阶段、停机阶段和候选激活阶段，不是只注入异常然后在同一调用里 catch。

## 已暴露的问题与后续准入条件

- 现有 `install` 明确拒绝已有安装；`update` 保留现有 helper。因此旧文档“重新安装即可更新 helper”缺乏 CLI 实现，不能按现有命令操作，更不能让用户卸载丢失配对后冒充保留配置升级。
- 当前 PoC 要求命令来自旧 Bridge 树外。远程终端内调用会安全拒绝，不能用它宣称自动更新闭环。仍需能跨 supervisor 生命周期的受控 handoff；不重试控制台事件，不假设 detached 能脱离 Job。
- journal 恢复目前需显式调用 PoC；尚未接入启动恢复或正式 CLI。它检查子进程存活，不等同于 Codex/Cloudflare 端到端健康。也未接入正式卸载文件白名单；不要在正在使用的正式安装目录运行候选代码。
- 首次测试在工作区的长目录中被现有 `Run command must fit Windows 260-character startup limit` 校验拒绝。当前启动命令重复包含 helper、state 和 Bridge 的绝对路径；测试改用系统短临时目录后通过，**没有修复长路径安装问题**。下一步先 PoC 自定位的短启动命令；若仍超过 Run 限制，再探测用户级计划任务权限，不能直接假设标准用户有权限。
- 正式合入前需要覆盖并发安装/卸载/更新互斥、开机时未完成 journal 的恢复、候选来源信任和真实编译 CLI 保留配对修复。不能只把候选函数挪入主库就宣称完成。

主干正式代码本轮未改变，最近完整回归仍为日志轮转检查点的 101 PASS/0 FAIL。本轮新增独立 PoC 的 1 PASS 不称为已经重新执行的 102 项全量回归。Gate 3/4 未通过，未触发 Actions、部署或发布。
