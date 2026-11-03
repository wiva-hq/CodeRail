# Windows bridge Phase 1：实测报告

日期：2026-10-26，America/Chicago。**更新：Gate 1 命令取消专项 PoC 已通过，完整 codex 套件 12/12；详见 [专项验收报告](windows-bridge-gate1-blocker.md)。Windows adapter 尚未启用，实验模块尚未合入业务代码。**

以下为最初 Phase 1 审计的历史记录（包含当时的失败与旧计数）。最新取消方案为每会话独立 ACP Worker + Job 回收及恢复，方案 A 作为受限优化保留；以专项报告和新增 gate1 evidence 为准。

## 决策

1. **ConPTY：选 Bun 1.4.4 内置 `Bun.spawn({ terminal })`。** 本机已验证三种 shell、中文/Emoji、输入、系统级窗口尺寸、浏览器断开回放，以及 PATH 中没有 Node/Bun 的编译产物启动。当前在线 Bun 文档仍写 Windows 不支持 terminal；本结论只针对实测的 Windows 11 x64 / Bun 1.4.4，不泛化到 Windows 10、ARM64 或其他 Bun 版本。
2. **进程树：主选 Job Objects，`taskkill /F /T` 仅作受控兜底。** bridge 持有带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的句柄；用 `CREATE_SUSPENDED` 启动 Bun worker，绑定 Job 后再 ResumeThread。worker 再创建 Bun ConPTY，避免 shell 在绑定前抢先派生进程。测试证明五层进程链随 Job 关闭消失，独立测试也证明 Job 持有者崩溃后由内核清理子树。不能依赖直接 child.kill，也不能在根进程已退出后才指望 taskkill 找回孤儿。
3. **Codex：首期继续 ACP 2.2.2；不因 Windows 而切换 app-server。** 两者实测都能读取用户登录态、创建会话、流式生成、协议取消和重启恢复。ACP 内部本来就启动 app-server；直接切换并不能绕过已复现的后台命令取消问题。继续 ACP 能保留现有 Svelte 消息、模型/推理配置及审批映射，减少首期改动。保留协议抽象和版本检查，未来可单独迁移。
4. **阻塞：执行中取消不能保证命令树退出。** app-server 返回 `interrupted` 后，测试命令的嵌套 PowerShell 仍存活超过 20 秒。测试末尾已显式清理并核实退出。不得把协议事件当成进程退出证明。

## 环境与范围

| 项目 | 本机实测 |
| --- | --- |
| OS | Windows 11，内核 10.0.26200，AMD64 |
| 权限 | 测试 token 的 elevated=false，无管理员提权 |
| Bun | 1.4.4（38afee6c8），通过 npx 固定版本调用 |
| Node | v22.21.0，仅测试 fixture、npm 与依赖安装使用 |
| Windows PowerShell | 5.1.26100.9711 |
| PowerShell Core | 7.6.5 |
| Codex | 本机桌面附带 CLI，0.163.0-alpha.10.2 |
| ACP / node-pty | 2.2.2 / 1.1.0（预编译 win32-x64 原生模块） |
| 模型与认证 | 当前用户 ChatGPT 登录；目录模型默认 gpt-6.1-sol，未替换模型 |

本轮源码只添加在 `scripts/poc-win/`，报告在 `docs/`。未进一步修改 `bridge/src/`、Worker、Svelte、根依赖或发布流水线；Phase 0 的既有未提交改动保留。
未触发 GitHub 发布、Cloudflare 部署或服务安装。新建的 Codex 测试会话历史保留在用户 Codex 数据目录，便于恢复检查；没有接管或修改原有聊天。

## 精确复跑命令

在仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 all
```

入口自动检查所需依赖，按根 `bun.lock` 和 PoC 独立 `package-lock.json` 安装缺失项；不全局安装 Bun。显式调用 npm.cmd / npx.cmd，规避 Windows PowerShell 的 npx.ps1 重解析问题。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 runtime
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 terminal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/poc-win/run.ps1 codex

node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json
npx --yes --package bun@1.4.4 bun run check
npx --yes --package bun@1.4.4 bun run test:platform
```

Codex 测试进行真实推理，会使用当前账户额度。只允许指定的本地慢命令 fixture 审批；其他命令审批被拒绝。工作目录包含中文和空格。所有套件用当前 CLI 的绝对路径启动，不依赖固定的 `.codex` 二进制安装布局，不打印 token 或账户 email。

原始带时间戳日志位于 `scripts/poc-win/artifacts/`。可审阅的实测 JSONL 快照见 `scripts/poc-win/evidence/`；失败也保留，整体命令遇到失败返回 1，不把候选方案失败或 SKIP 伪装为能力通过。

## Task 1.1：Bun 底座

| 实验 | 结果与解释 |
| --- | --- |
| 默认编码 | cmd code page 437；Windows PowerShell Console 输出 437、管道 `$OutputEncoding` 为 20127（ASCII）。确实不能假设默认 UTF-8 |
| 强制 UTF-8 | chcp 65001；PowerShell 显式设置 InputEncoding / OutputEncoding / `$OutputEncoding`；中文和 Emoji 往返通过 |
| 单文件 exe | `bun build --compile --target=bun-windows-x64`；内嵌文本资源正常；将 PATH / Path 置空、清除 BUN_BE_BUN / NODE_OPTIONS 后启动，资源与内置终端均通过 |
| WebSocket | 24 客户端、6,144 条 echo、72 MiB UTF-8 payload；另做 32 次真实升级后的 TCP 突断；最终 56 连接关闭，活动连接 0 |
| 内存 | 记录 before / peak / after RSS，断开后两次 GC 和 1 秒等待；断言残留增长小于 192 MiB。此为短时压力验证，不是长期无泄漏证明 |
| 递归 watcher | 高频写入发生严重事件合并/丢失，并收到 filename=null；不能依赖每个路径事件。全量 readdir 能核对最终 152 个文件；生产实现必须做 overflow/null 后的 snapshot rescan，必要时轮询 |
| 独占文件 | PowerShell 使用 FileShare.None 持有文件；Bun 写入返回 EBUSY；释放后写入成功，watcher 仍能收到后续变动 |

最初 watcher 测试要求收到 hot/rename 的逐路径事件，实际只收到少量路径和 null，因此失败。最终测试保留丢失计数并验证重扫描策略，未宣称修好了原始 watcher。Phase 2 仍需实现有界退避、快照差异和重命名语义。

## Task 1.2：终端与清理

| 候选 / 场景 | 实测结论 |
| --- | --- |
| Bun 内置 terminal | powershell.exe / pwsh.exe / cmd.exe 均通过；中文、Emoji、ANSI、双向输入均通过 |
| resize | 将 80×24 调整至 127×39，用新启动的 .NET Console 客户端读取 WindowWidth / WindowHeight，验证实际尺寸。Node 缓存的 stdout 尺寸仍显示 80×24，不能用缓存值否定 ConPTY resize |
| node-pty 1.1.0 | 预编译模块能在 Bun 下加载、创建终端和输出中文；resize 调用不崩溃。但清理时 console-list helper 报 AttachConsole failed，不采用它替代已验证的 Bun 内置路径 |
| 直接 bun:ffi ConPTY | CreatePseudoConsole / CreateProcessW 调用成功；本 PoC 中 Node fixture 输出进入父标准输出，未可靠进入预期的输出管道，I/O 验证超时。**候选失败，不合入、不宣称 FFI 在 Windows 一概不支持** |
| WebSocket 重连 | 同一终端 PID，在无订阅者时继续产生输出；重新连接先回放 256 KiB 有界缓存，再收 live frame，随后输入命令成功 |
| Job Objects | 三轮 PowerShell → Node → Node → ping；Job 在主进程恢复前绑定；每轮四个 PID 均由 CIM 确认消失 |
| taskkill /F /T | 相同四层链三轮；每轮四个 PID 均确认消失 |
| owner crash | 只结束 Job 持有者，故意不加 /T；内核关闭最后 Job 句柄后四层子树全部消失 |
| 最终组合 | 暂停的 Bun worker 先入 Job，再启动 ConPTY PowerShell → Node → Node → ping；同时按 CIM 扩展所有实际后代，最终复核共 9 个 PID 全部消失 |

上述“无孤儿”是明确 fixture、重复次数和当前系统上的实测结果，不是对任意 breakaway、不同 token、外部创建进程或其他系统版本的普遍证明。生产不得允许 breakaway；Windows 10 / ARM64 尚未覆盖，FFI 结构尺寸仅按本次 x64 实验验证。

断线实验验证浏览器断开后的进程继续与内存回放，不声称终端 shell 可跨 bridge 崩溃继续运行。bridge 崩溃时 Job 的预期行为正是清理工作进程。

## Task 1.3：Codex

| 能力 | app-server | ACP 2.2.2 |
| --- | --- | --- |
| 当前用户登录态 | account/read 返回 chatgpt | session/new 成功；不触发登录或复制 token |
| 含中文/空格 cwd | 通过 | 通过 |
| 新会话 | thread/start | session/new |
| 流式文本 | item/agentMessage/delta | session/update agent_message_chunk |
| 生成中取消 | turn/interrupt → interrupted；服务仍响应 | session/cancel → stopReason=cancelled |
| 重启后恢复 | thread/resume + thread/read + 后续 POC_RECOVERED | session/load + 后续 ACP_RECOVERED |
| 审批 | untrusted 策略实际触发指定慢命令审批，客户端 accept 后 PID 文件证明命令运行 | 沿用现有 ACP 权限映射；本轮未单独声称完成 ACP 慢命令审批回归 |
| 命令执行中取消 | **失败：协议 interrupted 后嵌套命令仍存活超过 20 秒** | 共用 app-server 底层；没有证据表明加一层 ACP 能修复该问题 |
| 分发 | 当前 CLI 可直接 stdio 启动，无 JS wrapper | 将 adapter bundle 成约 1.65 MB JavaScript，再以 CODEX_PATH 指向本机 CLI，从不同 cwd 启动成功 |
| 维护成本 | 少一个进程/协议层，但需重写现有会话、配置与审批映射，跟踪 app-server schema | 多一个 JS 进程/映射层，需固定版本并回归；当前前后端改动最少 |

原生控制台事件测试使用独立隐藏控制台和独立 helper：FreeConsole → AttachConsole(测试 PID) → 忽略 helper 自身 Ctrl+C → GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)。未向承载本次聊天的控制台发信号。
首次实验 API 调用成功，app-server 仍存活，但当前生成**没有**被该信号取消；随后协议 interrupt 完成取消，重启后历史仍可恢复。最终一键复跑中，信号之后的协议 interrupt 虽返回，turn/completed 却在 120 秒内没有到达，实验失败；finally 关闭 Job 并清理了测试进程。因此控制台事件不仅不可靠，还可能干扰后续协议完成通知，**不采用它作为生产降级路径**。首次成功的恢复不掩盖复跑失败，两个结果都保存在日志中。

崩溃恢复另用了独立 bridge-owner surrogate：由其启动 app-server，工作提交前绑定 Job；完成一轮 BRIDGE_CRASH_READY 后，只结束 owner。owner 与 app-server 都消失，随后新 server 能恢复同一 thread 历史。此为所有权模型 PoC，不是现有 bridge 已支持 Windows 的宣称。

协议检查从本机 CLI 重新 generate-ts，验证 initialize、account/read、thread/start、thread/resume、thread/read、turn/start、turn/interrupt；模拟删除 interrupt 后断言拒绝。它只能检测方法表变化，字段语义升级仍必须跑 live 回归，不能宣称兼容所有未来版本。

## 阻塞与备选方案

**首选架构闭环仍被 Codex 嵌套命令取消残留阻塞；控制台事件也没有提供可靠补救。** 直接 FFI ConPTY 候选已失败退出选型，Bun 内置替代路径已通过。

可选修复方向：

1. 优先修复/升级 Codex 的 Windows 命令树终止，并对同一慢命令 fixture 复跑。必须同时证明协议 interrupted、命令 PID 消失、server 仍响应、同会话可继续。
2. 若运行时无法按命令树取消，采用独立会话 worker + Job：先协议取消，超时后关闭该会话 Job，重启并恢复 durable thread。该降级必须在网页明确显示“执行器已重启”；当前每 harness 共用一个 ACP 进程的结构不能直接这样做，否则会中断其他会话。
3. 在过渡期禁用 Windows 远程命令执行，仅保留已验证能力；不满足本次完整 Gate 1。

本轮不越过 PoC 范围修改共享 ACP 生命周期，也不把已知 PID 的 fixture 清理冒充通用生产解决方案。

## Gate 1

| 准出项 | 状态 |
| --- | --- |
| 一键入口、固定 Bun、独立依赖、保存原始日志 | 已完成 |
| ConPTY 与 Job / taskkill / owner crash 清理实测 | 首选组合通过；直接 FFI 候选失败并排除 |
| 明确 Codex 选型、流式生成取消、历史恢复 | 已完成；首期继续 ACP |
| 执行中取消无残留、非致命信号可靠补救 | **未通过；信号未取消当前生成** |
| 全库 check 与 test:platform | 通过：0 error，1 条既有 Svelte warning；9/9 平台测试通过 |
| PoC 独立 TypeScript 检查 | 通过 |

**Gate 1 保持关闭。没有把本轮实验代码合入 bridge/src。**

## 文档依据

- [Bun spawn reference](https://bun.sh/reference/bun/spawn)：用于核对 API；文档 Windows terminal 限制与本次锁定版本实测不同，结论以实验边界为准。
- [Microsoft node-pty](https://github.com/microsoft/node-pty)：候选实现与预编译模块。
- [CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)：原生 ConPTY 接口。
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：进程组所有权与限制。
- [GenerateConsoleCtrlEvent](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)：Ctrl+C 不能按非零进程组精确投递，因此只在独立控制台实验。
- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)：协议概念；本次字段与方法以安装的 CLI 生成 schema 和 live 结果核对。

## 日志原样摘录与最终计数

累计 24 个不同实验项：21 PASS、3 FAIL。末轮一键执行返回 1；Job worker 的全部 CIM 后代另做了补充复核。PASS 代表该实验断言完成，不代表其中每个被探测候选都适合生产（例如 node-pty 的 cleanShutdown=false）。

完整快照：[结果 JSONL](../scripts/poc-win/evidence/2026-10-26-results.jsonl)、[取消诊断](../scripts/poc-win/evidence/2026-10-26-cancel-diagnostics.jsonl)、[汇总](../scripts/poc-win/evidence/2026-10-26-summary.json)。原始 timestamp 日志仍保留在 ignored artifacts。

```jsonl
{"name":"encoding-baseline-and-forced-utf8","status":"PASS","durationMs":572,"details":{"defaultPowerShell":{"elevated":false,"pipeline":20127,"consoleOut":437},"cmdCodePage":"437","forcedOutput":"UTF8_中文😀\r\n65001"}}
{"name":"websocket-throughput-disconnect-memory","status":"PASS","durationMs":1536,"details":{"workers":24,"received":6144,"echoed":6144,"utf8Bytes":75497472,"durationMs":327.72159999999985,"rssBefore":28753920,"rssPeak":44638208,"rssAfter":35962880,"disconnected":56,"remainingConnections":0,"memoryLimitBytes":201326592}}
{"name":"bun-terminal-worker-contained-by-job","status":"PASS","durationMs":12592,"details":{"trackedPids":[19608,51384,56792,26628,30872,15440,48096,54136,65796],"remaining":0,"design":"assign suspended Bun worker before it can spawn ConPTY; bridge owns Job handle"}}
{"name":"app-server-stream-cancel-recover","status":"PASS","durationMs":11876,"details":{"threadId":"01a17b79-c7c1-7242-a778-dc146906c335","model":"gpt-6.1-sol","streamDeltas":13,"cancelMs":124.90229999999974,"interrupted":true,"serverResponsiveAfterCancel":true,"restoredTurns":1,"resumedReply":"POC_RECOVERED"}}
{"name":"app-server-command-approval-and-running-cancel","status":"FAIL","durationMs":31384,"error":"Error: Timeout waiting for PIDs gone: 33896\n    at until (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\common.ts:21:13)\n    at async assertGone (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\common.ts:45:9)\n    at async <anonymous> (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\03-codex\\live.ts:74:13)\n    at async result (unknown)"}
{"name":"acp-stream-cancel-session-load","status":"PASS","durationMs":14723,"details":{"sessionId":"01a17b7a-722c-7d12-b733-5ad799efe3fa","cancelMs":78.30630000000383,"stopReason":"cancelled","loadedAfterRestart":true,"followupText":"ACP_RECOVERED"}}
{"name":"codex-isolated-console-ctrl-c-and-recovery","status":"FAIL","durationMs":130349,"error":"Error: Timeout waiting for turn/completed\n    at until (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\common.ts:21:13)\n    at async event (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\03-codex\\rpc.ts:52:11)\n    at async <anonymous> (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\03-codex\\console-signal.ts:35:109)\n    at async result (E:\\Citrus Cafe\\Wiva\\CodeRail\\scripts\\poc-win\\common.ts:53:27)"}
```
