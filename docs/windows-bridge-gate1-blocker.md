# Gate 1 专项：Windows 命令取消与会话恢复

日期：2026-10-26，America/Chicago。实验代码限于 `scripts/poc-win/`，没有进一步修改 `bridge/src/` 或启用 Windows adapter。

**验收结论：Gate 1 遗留命令取消阻塞项已关闭（PoC 范围）。完整 codex 套件 12 PASS、0 FAIL、0 SKIP，退出码 0；全库 check 和 test:platform 均通过。**

## 问题与选型

协议返回 `interrupted` / `cancelled` 只证明 turn 停止，不证明 Windows 命令子树退出。当前 CLI 的直接 app-server 和 ACP 均存在这一边界；切换协议本身不能解决。

**采用 ACP 2.2.2 + 每逻辑会话独立 Worker + bridge 持有 Job Object 作为默认架构。** 保留现有前端审批及消息映射。app-server 同样验证通过，可作为协议适配层的另一实现。不能继续让多个逻辑会话共用一个会被强制回收的 ACP 实例。

取消顺序为：先发送 `turn/interrupt` 或 ACP `session/cancel` → 500ms 宽限期 → 若命令仍在会话 Job 内，关闭带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job → 等待捕获的进程句柄全部 signalled → 新 Worker 执行 `thread/resume` / `session/load` → 继续对话。定时器不等待 RPC 应答，避免挂起的协议阻塞收割。命令自然退出时保留原 Worker；本次强制恢复实验明确要求走重启分支。

方案 A 作为受限优化保留：在批准命令前建立独占 approval lease，Toolhelp 快照记录原有基础进程，通过父子关系发现新进程，保留进程句柄和创建时间，放入命令专属 Job；Job 继承覆盖后续后代。协议取消后给 1.5s，再关闭命令 Job。实测 app-server PID 不变，原 thread 可正常执行下一轮。

**A 不能作为唯一保障。** 新根进程在首次异步快照前退出时，单靠父 PID 链无法完备证明归属；共享 runtime 的并发审批也会混淆归属。实现拒绝重叠 lease，可排队获取；默认 B 则从任何审批或模型任务开始前就持有整个会话 Job，不依赖抓到短命令根节点。移入正式 bridge 时沿用已验证的 suspended-launch → assign Job → resume 启动方式，消除创建与 Job 绑定之间的窗口；本次 Codex PoC 在 initialize 和任何模型工作前完成绑定。

## 实现与断言

| 文件 | 职责与验证 |
| --- | --- |
| `03-codex/process-jobs.ts` | x64 Toolhelp 原生进程快照、创建时间/句柄、Job 成员查询；无控制台事件 API；A 的独占审批 lease 与命令 Job |
| `03-codex/cancellation.ts` | 真 app-server 审批 → PowerShell → Node → Node → ping；协议取消后命令归零，同一 runtime/thread 再次响应 |
| `03-codex/process-matrix.ts` | 多层链、短进程 churn、预先存在的 sibling 不受影响、重叠审批被拒绝；另验 detached 根进程先退出后，B 仍清理存活后代 |
| `03-codex/session-worker.ts` | 独立 ACP/app-server Worker、500ms 宽限期、整 Job 回收与持久会话恢复；同一 turn 的审批共享该 session lease |
| `03-codex/recovery.ts` | app-server B 实测：运行中的命令被清理，另一个独立会话仍响应；历史读取及模型复述随机 marker 均通过 |
| `03-codex/acp-recovery.ts` | ACP B 实测：allow_once 审批、嵌套 Node/ping、session/cancel、Job 清理、session/load 后复述随机 marker |
| `03-codex/run.ts` | 单入口完整回归；历史 console-signal 实验已移出执行路径 |

所有测试工作目录用 `realpathSync.native` 解析；传输流显式 UTF-8。审批只放行精确生成的本地测试命令，不修改全局 execpolicy，不批准其他命令。fixture PID 文件只作为独立覆盖率断言；清理模块只接收 runtime PID/审批 lease 或会话 Job 所有权，不接收 fixture PID、路径匹配或进程名作为清理依据。

命令退出同时用保留的原生进程句柄和 `Get-CimInstance Win32_Process` 复核；成功断言先于 finally 的紧急防护 Job 关闭。不存在测试末尾按 fixture PID 补杀后再宣告通过的路径。未再执行 GenerateConsoleCtrlEvent 或 AttachConsole。

## 复跑命令

Windows 11 x64 10.0.26200；非管理员用户；Bun 1.4.4（38afee6c8）；Codex 0.163.0-alpha.10.2；ACP 2.2.2；当前用户已有 ChatGPT 登录态与 gpt-6.1-sol。运行会调用真实模型并产生新测试会话。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 codex
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json
npx --yes --package bun@1.4.4 bun run check
npx --yes --package bun@1.4.4 bun run test:platform
```

`POC_FILTER` 必须未设置，才能将整个 codex suite 计为全量通过。原始带时间戳日志保留在 ignored `artifacts/`。最终结果与精确数值见本文末尾验收记录。

## 失败记录与适用边界

保留 Phase 1 最初取消失败证据，没有覆盖旧日志。本轮第一次全量回归中 A 也曾超时：Job 成员查询先于 Toolhelp 捕获了 ping，记录暂用 `<job member>`，后续没有补全名称，导致按进程名判断 readiness 一直不满足。现已在每轮快照更新已捕获记录，保留句柄所有权；完整失败输出另存 `evidence/2026-10-26-gate1-regression-before-fix.log`。

早期 root-exits fixture 没有 detached，Windows 下 Node 退出连带终止子进程，无法建立所需场景；已改为 detached + unref，并断言命令根节点先退出而后代仍存于 Job。该 fixture 错误本身不构成 A 丢进程的证据。

“零残留”结论限于本机实测的普通 CreateProcess 后代和记录的场景，不扩展到 UAC 提权、外部服务/WMI 创建、允许 breakaway 或跨用户进程。遇到 Job 绑定或权限错误必须失败关闭。Windows 10、ARM64、其他 Codex/Bun 版本未验收。关闭 Job 会结束该会话 runtime，持久会话历史可恢复，但未完成命令的外部副作用不会回滚，也不会自动重跑命令。

本次是 Gate 1 底层 PoC 的验收；正式 bridge adapter、Svelte 端完整 E2E 与安装发布属于后续工作。未把 PoC 通过等同于 Windows 产品已经发布。旧 `all` 套件还包含未采用的直接 FFI ConPTY 候选，其历史失败独立保留，不宣称候选全绿。

## GitHub Actions 检视

未触发 Actions。现有发布工作流使用 self-hosted Linux X64 与 macOS coderail-mac 标签。组织 `wiva-hq` 的 runners / runner-groups API 均返回 403，当前令牌无组织 runner 管理读取权限，无法核实在线/空闲机器或 Windows runner 标签。没有猜测标签或修改工作流；后续需要 Actions 时应先取得可见的 runner 清单并选择有空位的组织本地机。

## 依据

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [PROCESSENTRY32W](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- Codex 协议字段以本机 CLI `app-server generate-ts` 输出和真实 RPC 回归为准；schema 方法面检查不能代替 live 语义兼容验证。

## 最终验收记录

| 检查 | 结果 |
| --- | --- |
| 用户要求的 `run.ps1 codex` | 完整 12 PASS、0 FAIL、0 SKIP；退出码 0 |
| A：真实命令取消 | 8 个存活命令成员，协议后仍残留 8 个；1,500ms 宽限后 Job 清理，总耗时 1,723.9ms；CIM 与句柄复核归零；同一 app-server PID 66356、同一 thread 后续回复正常 |
| B：app-server | 500ms 后仍有 3 个命令成员；整会话 Job 12 个进程全部退出，关闭后 104.5ms；新 runtime 恢复历史与随机 marker；另一个 session PID 41764 正常响应 |
| B：ACP | 500ms 后仍有 8 个命令成员；整会话 Job 23 个进程全部退出，关闭后 364.6ms；旧 prompt 返回 cancelled，新 Worker session/load 后恢复 marker 并正常回复 |
| 根先退出 | 根退出后 Job 仍持有 7 个存活成员；关闭后全部退出，不依赖命令根 PID |
| 多层链 / churn | 均清理归零，原有 sentinel 与 runtime 保持存活，重叠 approval lease 被拒绝 |
| 崩溃恢复 | bridge-owner surrogate 崩溃后 Job 清理 runtime，重新读取持久历史成功 |
| 协议兼容 | 当前 schema 方法面通过，模拟缺失 turn/interrupt 被拒绝；真实流式、审批、取消与恢复同时通过 |
| PoC TypeScript | 退出码 0 |
| `bun run check` | 退出码 0；0 error，1 条既有 PhoneApp.svelte 无障碍 warning |
| `bun run test:platform` | 9 PASS、0 FAIL，37 个断言 |

最终原始日志：[gate1-codex.log](../scripts/poc-win/evidence/2026-10-26-gate1-codex.log)；结构化结果：[gate1-results.jsonl](../scripts/poc-win/evidence/2026-10-26-gate1-results.jsonl)；环境、检查与运行后进程审计：[gate1-summary.json](../scripts/poc-win/evidence/2026-10-26-gate1-summary.json)。修复前失败日志独立保留，未计入本轮通过数。
