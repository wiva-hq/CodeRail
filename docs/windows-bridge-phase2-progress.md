# Windows Phase 2–4 续跑断点

## 当前状态（2026-10-27，本轮保存检查点，覆盖下方历史记录）

**helper 升级专项最新断点**：新增独立 `12-helper-upgrade` PoC，树外 helper 替换、坏候选回滚、三个阶段真实退出 42 后恢复、备份篡改拒绝、树内调用拒绝均通过，**1 PASS/34 assertions/9.59s**；PoC tsc/许可头通过。配对/自有注册表保持，旧根/Bridge/嵌套 ping 退出。尚未正式合入或开放 CLI；远程树内自动迁移未实现。测试首先暴露 Run 启动命令 260 字符限制，改用短临时目录才通过，长路径安装仍待修复；下一步 PoC 自定位短启动命令。详见 [helper 报告](windows-bridge-phase3-helper-upgrade.md)。正式代码最近全量仍为下述 101 项，Gate 3/4 未通过。上一日志提交 `e1a3178` 已 push 并核对远端一致。

**最新进展（日志轮转完成，覆盖下文历史待办）**：Windows supervisor 已改为 pipe 单写入器，10 MiB 当前日志+一个备份，UTF-8 边界轮转与旧超大日志裁剪，写入失败清空 Job。最终整合 **101 PASS / 0 FAIL / 655 assertions / 54 files / 144.34s**，全库 check 0 error/既有 warning 1，PoC tsc/许可头通过。新编译包真实安装→配对后台→超大中文日志/CLI logs→卸载通过，真实 HKCU/PATH 恢复、捕获进程零残留。产物 119869440 bytes，SHA256 `67bf97a48cd1199b5b537af6c927088221d20a7a513ab1f71c3faa95b8268201`。详见 [日志证据](windows-bridge-phase3-logging.md) 和 [用户指引](windows-bridge-user-guide.md)。此结果仍不是 Cloudflare E2E/重登/休眠/净室，Gate 3/4 未通过；旧 helper 自动迁移仍待实现。

**推送后续进展（覆盖本节较早的 status 待办与产物数据）**：Windows status 的 PID/内存/监听端口已通过 PoC 并接入正式可选 PlatformAdapter 能力；平台加资源 12 PASS/48 assertions、生命周期加资源 3 PASS/21 assertions。新编译 CLI 在无 Node/Bun PATH 时读取真实后台数据、停止后返回 stopped，通过且不改注册表。全库 check 0 error/既有 warning 1、Bridge/PoC tsc 通过。新产物 119853568 bytes，SHA256 `0762b48c5e8e87fd03445e9f65e5217abdfe85e7b82b0b1b8cbef0f31c942236`；旧 96 项是此前基线，非本次再次全量结果。详见 [status 报告](windows-bridge-phase3-status.md)。`f6cf61b` 已成功 push 且远端 SHA 核对一致；后续更改另行保存。Gate 3/4 仍未准出。

- Goal **active**，恢复自动化 `coderail` **PAUSED**；普通额度可用，最近本窗口 70%，重置点 `1793124673`。未买 credits/手动 reset。
- 独立分支 `codex/windows-bridge-phase2-4`。安装/卸载已保存 `83c6298`；正式更新与恢复已保存 `b6dfea4`。用户要求本轮保存、补齐文档并 push 此分支；push 结果以远端 SHA 核对及交付回复为准。未部署或触发 Actions，不合并 main。
- 最新完整整合 **96 PASS / 0 FAIL / 612 assertions / 50 files / 159.04s**；全库 check 0 error、既有 Svelte warning 1；Bridge/PoC tsc 通过。原始输出 ignored `scripts/poc-win/artifacts/latest-regression.log`。
- 正式 CLI 已具备 install/pair/status/logs/restart/update/uninstall。update 默认访问配对站点 Manifest，校验平台/ABI/版本/长度/完整 SHA，流式下载后由持续 supervisor 排空旧 Job、精确等待调用者、切换双目录、检查新进程 bootstrap；失败恢复旧字节/标记与服务。逐次 rename 原子，整个事务不是一次原子交换；journal 覆盖缺失 current 的窗口。旧开发 helper ABI 0 拒绝更新。
- 中文/Emoji 路径、连续更新、备份篡改拒绝、三处真实 root 崩溃、清旧备份崩溃后继续更新、未知 journal schema 拒绝均有 PoC。崩溃入口只在 CODERAIL_POC 编译；正式 helper 无该开关。
- 真实编译 900001→900002 更新：坏 SHA 拒绝、root PID 稳定、previous 旧版可执行、新 Bridge hello，连接间隔 **2007ms**，更新测时 **8466ms**。随后真实卸载：启动项删除、PATH 恢复、安装目录/EXE 和已捕获服务进程清零。服务器是本地 fixture，**不是 Cloudflare E2E**。见 [更新证据](windows-bridge-phase3-update.md)。
- 最新默认 0.0.1+0 包 119851520 bytes，SHA256 `2e1b7ed2e8c00ccbfeda71afebebba04ef5e36666617b9372d47f1faed00121f`。重建后实际编译 CLI 配对后台→卸载再通过。900001/2 仅本地测试号，未发布。
- 独立 PoC 复现 Bun 默认 spawn 未传递 process.env 新增变量，已显式传 env。stop 跟随同一 root PID+创建时间的新 nonce，修复回滚窗口请求丢失；失败探针已通过通用 stop 正常收割，无 fixture PID 强杀。映像 DELETE 句柄/目录改名可行，直接删除映像 Win32 5，不能混淆。
- GitHub 现在 role admin、admin:org scope 已授权。组织在线 Linux x64 / macOS ARM64（读取时 busy=false），没有 Windows runner；mac 发布组只接受 main release.yml，当前分支未获此 workflow 使用权。未改 runner 配置或触发 Actions。
- Gate 2 本机通过；**Gate 3/4 未准出**。接下来 status 资源详情、writer 自动轮转、防火墙提示，然后真实 Worker/网页手机联调与 CI/下载发布。实际另一标准用户/重登/休眠/净室、helper ABI 升级仍待验/设计；不擅自提权、重启、休眠或启用 Sandbox。
- 本轮最后新增 `11-observability/memory.ts` 独立 PoC：通过绑定进程句柄调用 `K32GetProcessMemoryInfo`，读取 working set/private bytes；独立测试 **1 PASS / 0 FAIL / 2 assertions**。这项在完整 96 项回归后单独验证，尚未合入正式 status，不把两次执行称作一次 97 项全量回归。复现命令和交接边界见 [本轮保存说明](windows-bridge-checkpoint-2026-10-27.md)。

## 历史记录（以下包含过时状态，仅保留追溯）


## 最新断点（以下历史记录由本节覆盖）

**最后整合回归已结束：71 PASS、0 FAIL、415 assertions、36 文件、91.39s**（含新增真实安装崩溃恢复与 journal 篡改拒绝）。PoC tsc、license headers、staged diff check 通过。原始输出仍为 ignored `scripts/poc-win/artifacts/latest-regression.log`。正式源码构建与 compiled CLI smoke 对应上述最后一次 `dd030878...` 产物；后续仅新增 PoC/文档。没有生产部署或 push，Gate 3/4 未通过。

当前 checkpoint 已有 `8f4c8dd`（另有 `d62145f`、`33c5501`），尚未 push。后续新增安装 crash-recovery PoC：实际子安装器在 PATH 注册表提交后 `process.exit(42)`，重新读取 journal 可撤回自有启动项/PATH、幂等重复恢复；篡改安装 id/PATH entry 会拒绝且不触碰已注册状态，后改启动项也不删除。独立 **1 PASS、15 assertions**；相关 5 文件较早合测 6 PASS/49 assertions，Bridge/PoC 类型检查通过。自有安装文件保留，完整安装/卸载仍未接入。

最新普通额度检查用量 98%，仍允许普通执行；未购买 credits、未手动 reset。沿用同一 `coderail` 自动化新增一次检查：2026-10-27 **08:11 America/Chicago /13:11 UTC**，先验证窗口重置点 `1793106639` 已过和 ordinaryUsageAllowed；当前配置 ACTIVE，触发恢复后需暂停，避免重复或打断正常工作。旧 03:10 一次任务已执行并暂停过，下方“自动化暂停”是历史状态。Goal API 仍 paused、无 resume 参数，不新建 Goal 或伪造状态，用户已授权的普通任务继续。

**最后记录：本地已有 `33c5501`、`d62145f` 两个 checkpoint，后续代理/父进程退出修复正在保存；未 push。完整回归 70 PASS、0 FAIL、400 assertions、35 文件、90.65s**。随后端口/进程身份回归 2 PASS /17 assertions；全库 check 0 error /既有 warning 1，Bridge/PoC tsc 通过。最新源码重新构建、真实 compiled CLI 的 version/logs/status/本地 pair→foreground Bridge hello 通过。产物 119741440 bytes，SHA256 `dd03087878f3ad0e10f83db5169ab44f294843b8170fb2786245a6d94f47e56f`。证据：[JSON](../scripts/poc-win/evidence/2026-10-27-lifecycle-checkpoint.json)。旧产物 hash 和下方 63/60/56 数字均为历史。

关键新结论：仅 unref 不足以让 Bun Windows 后台越过父 CLI 退出，真实父退出测试先失败后修复为 detached:true；detached 仍继承外层 Job，不能用于逃逸远程命令树。正在运行的映像无法直接删除（私有副本 Win32 5），经 SHA256 验证后内存加载的托管 helper 可删除磁盘映像并继续执行。后者只证明能力，完整 uninstall 尚未实现。下一步优先接可恢复安装事务与 supervisor 外部清理 actor，再更新切换/回滚，详见 [生命周期实现边界](windows-bridge-phase3-lifecycle-plan.md)。不要重复猜测自删除或 unref 行为。

代理已渐进合入：只读当前用户 WinHTTP 手工配置、HTTP/WS CONNECT 实测、环境代理优先和 NO_PROXY host/domain/port、本地预览绕过；PAC/WPAD、SOCKS、系统代理回退 CIDR 未实现。没有修改真实用户 PATH/永久启动项、系统代理或防火墙。Gate 3/4 仍未通过，不能发布完成；CLI 配对 fixture 不是 Cloudflare E2E。

**当前最终回归：63 PASS、0 FAIL、362 assertions、30 文件、88.73s**。最新 `bun run check` 0 error / 既有 warning 1，PoC TypeScript、license headers 与 staged diff whitespace 检查通过。最后源码重新编译成功；真实编译 CLI 在 PATH 仅含 System32 时执行 version、UTF-8 logs、未配对 status 均通过。产物 `119737856` bytes，SHA256 `152c65c10747ded65124a567a08a9f04330f1ea769058fa691d8caa97980fa05`。原始回归输出为 ignored `scripts/poc-win/artifacts/latest-regression.log`。

升级暂存补强：追加未信任 overlay 的文件此前可能只校验前缀；已用失败用例复现，改为同时核对已暂存文件的完整长度与 SHA256，9 assertions 通过。完整 installer/update 仍是 PoC，不激活任何更新。以上结论仅针对当前 Win11 x64，Gate 3/4 仍未通过。

最新补充：完整整合回归已扩大至 **60 PASS、0 FAIL、351 assertions、29 文件、85.77s**；服务生命周期另连续 4 轮各 1 PASS/9 assertions。日志功能后加 **3 PASS、10 assertions**，Bridge/PoC TypeScript 均通过。`logs` 查看近期输出，`logs -f` 跟随；没有启动 PowerShell 辅助进程，仍未实现 writer 自动轮转。后续改动交付前应再运行完整整合与编译。

保留失败历史：扩大回归曾 **57 PASS/1 FAIL**（停机等待超时），之后 **58 PASS/1 FAIL**（夹具读取尚未写完的 PID JSON）。Toolhelp 树捕获已加创建时间校验，防止旧父 PID 关系误归属；夹具改为 UTF-8 临时文件原子发布。一次超时没有保留到足以确定根因的存活身份，不能声称已证明它由 PID 复用导致；新诊断会报告剩余 PID+创建时间。上述完整绿与额外四轮是修复后的实际证据。

Unicode 同目录 stat 误取另一文件大小也已先复现、再修复为 native canonical 名称精确匹配。PATH 撤回只删除本次插入的一个精确值，保留后加重复项和不同 Unicode 路径。安装事务额外 PoC：仅注册、不启动；模拟注册表已提交后报错可还原 PATH/启动项，保留自有文件和诊断 journal，**不是零残留卸载或崩溃恢复**。

- 独立分支仍为 `codex/windows-bridge-phase2-4`。既有改动已保存本地提交 `33c5501`；本节对应后续改动尚待提交。没有 push、触发 Actions、部署 Cloudflare 或发布。
- Bun 1.4.4 完整整合回归：**56 PASS、0 FAIL、327 assertions、26 文件、84.63s**。包含新增 Unicode 物理路径隔离、npm/桌面 Codex 发现、服务原地重启、安装文件、PATH 所有权、连接故障恢复测试。全库 `bun run check`：0 error、既有 Svelte warning 1；PoC TypeScript 检查通过。
- 已复现并修复安全问题：`İ-project` 与 `i̇-project` 是不同 Windows 物理目录，但 JavaScript lowercase 相同。授权现在在 native realpath 后按规范化物理路径组件比较，避免 Unicode 折叠越权；实际读写与外部目录拒绝测试通过。Windows 写入前的 lstat 不再把权限/占用错误当作不存在。
- supervisor 持续存活并负责重启：先清空旧 Bridge Job，再启动新子进程；旧命令树无残留。包内已嵌入预编译 x64 GUI helper，安装时不要求 C# 编译器；开发源码运行保留编译回退。pair/restart CLI 已接入。
- 新源码 Windows x64 单文件重新构建成功，实际 `version` 输出 `0.0.1+0`。构建后另有 scope 错误处理小改动，交付前需再次构建。没有将构建成功当作完整安装验收。
- 升级暂存新增独立 PoC：SHA256/长度/x64 PE 校验、坏包拒绝、重复暂存、篡改检测、当前安装保持不变，**1 PASS、8 assertions**（此项在上述 56 项之后单独运行）。尚无激活/回滚或自删除实现，未迁入主库。
- **Gate 3/4 未准出**：完整 install/update/uninstall CLI、日志查看/轮转、受控切换回滚、Cloudflare 远程端到端、下载发布与真实标准账户/重登/休眠仍待完成。已有网络测试仅注入时钟间隙与 TCP/WebSocket 故障，不能替代真实休眠和 Wi-Fi 切换。
- GitHub 仓库 runner 0、组织 API 403 的外部条件不变；等待用户提供授权/可用 Runner Group 标签，不猜机器空闲状态。现有 Goal API paused、无 resume 参数，已请用户在 UI 继续；普通额度允许时本聊天仍继续授权工作。一次性恢复自动化保持暂停，防止重复执行。

下一步：完成安装事务协调（PATH/启动项所有权及失败回滚）→ 完整 CLI 与日志 → 更新激活/恢复 → 现有测试 Worker 联调 → Windows Runner/发布验证。用户允许本机测试，不等待 VM，不擅自提权、重启或启用 Sandbox。

2026-10-27 America/Chicago。分支 `codex/windows-bridge-phase2-4`。既有 Phase 0/1 与本阶段改动尚未提交。用户授权完成后本早晨 push 独立分支；未授权合并 main 或跳过门禁。

Gate 1 PoC 12/12。Gate 2 本机候选文件、Git、预览与真实 Svelte 卡片验证通过，详见 [Phase 2 报告](windows-bridge-phase2.md)。本文件此前记录的文件系统失败已修复，历史原因保留在报告中。

本次续跑回归：Bun 1.4.4，29 PASS、0 FAIL、179 assertions、7 文件、24.46s。含平台10、文件系统/原生句柄/正式RPC12、Git4、预览1、网页路径2。不是 Cloudflare 远程端到端或净室安装验收。

最新：正式层已接入文件/Git、Job 命令运行器、私有 ACL、用户环境/注册表 PATH、端口、长驻 IPC/ConPTY。Windows Agent 已改为每会话独立 Worker，协议取消 500ms 后整 Job 清理并恢复。42 PASS、0 FAIL、251 assertions，47.04s；全库 check 0 error/既有 warning 1。真实正式 Agent 审批/取消/恢复/隔离通过，4 个命令进程约 711ms 消失。详见 Phase 2 报告续跑更新。Gate 2 本机准出，正进入 Phase 3。

Windows service 的 status/install/uninstall 已接正式模块，main 接入 nonce 控制文件协作停机。尚缺完整 CLI 生命周期、打开外部链接、日志轮转、升级、网络恢复等。完整合并回归 **46 PASS、0 FAIL、278 assertions、18 文件、63.64s**；全库 check 0 error/既有 warning 1。已验证正式编译 Bridge 无窗口后台启动、向本地 Worker 协议测试端 hello、协作停机。不是 Cloudflare 或 Gate 3/4 完整验收。正在保存本地 checkpoint，尚未 push。

`09-user-service` 候选已迁入正式模块，PoC 再导出。C#/Bun 均为 CreateProcess Job list；内嵌 Worker 编译测试、后台生命周期和异常退出 Job 清理通过。详见 [Phase 3 报告](windows-bridge-phase3.md)。正式 service helper 目前现场编译 C#，发布包预编译 helper 尚待实现。

GitHub 重新核查：仓库 runner API **total_count=0**；组织 runner API **403**，提示需组织管理员/runner 权限。已异步请用户让组织管理员开放 Windows Runner Group 给 wiva-hq/CodeRail 并提供标签，或补充当前账号权限。未触发 Actions，不猜 runner 空闲状态。该外部条件不阻止本机实现继续。Cloudflare 仍未部署。

继续顺序：环境/工具发现与私有 ACL → suspended Worker + Job 与 process/shell/net → 每会话独立 ACP Worker 取消恢复 → 用户身份后台 CLI 生命周期 → CI/Cloudflare/发布验证。禁止 console-event/AttachConsole、fixture PID 补杀或未验证即合入。完成后提交并 push 当前分支。

用户允许现有 Cloudflare Worker + Windows 本机/笔记本联调，无需等待 VM。干净系统、另一标准用户、中文用户名、真实重登/休眠尚未验收；Gate 3/4 不得标通过。本机 Hyper-V 查询被拒、Sandbox.exe 不存在；未提权、重启或启用系统特性。组织 runner 原查询403，不能猜空闲机和标签。Cloudflare 尚未部署，使用 Wrangler 前核对技能、精确目标和权限。

已确认旧额度窗口重置、普通额度允许；一次性 coderail 自动化已暂停。现有 goal API 仍返回 paused（没有 resume 接口），不新建重复 goal，继续用户已授权任务。运行 fixture 位于 ignored artifacts，本次回归已退出，无持续测试服务。
