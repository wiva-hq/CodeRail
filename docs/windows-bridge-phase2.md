# Windows Phase 2：本地 Gate 2 验证与整合进度

## 最新安全回归补充

本次 Bun 1.4.4 扩大回归 **56 PASS、0 FAIL、327 assertions、26 文件、84.63s**。全库 check 0 error / 既有 warning 1。以下早期整合状态保留为历史；正式 process/shell/net/terminal/service 接入已完成到 [最新断点](windows-bridge-phase2-progress.md) 所列范围。

实测发现 Windows 的两个不同物理目录 `İ-project` 与 `i̇-project` 在 JS lowercase 下合并，原本可能绕过 caller folders 的 cwd 授权。修复采用 native realpath 后的物理组件精确比较，仅统一 ASCII 盘符；新测试验证合法 Unicode 目录读写成功、另一物理目录被拒绝。`.GIT` / `.Git` 原生别名仍受保护，本机 `.gıt` 是不同目录，按实际文件系统语义处理。未用 JS Unicode 折叠作为物理授权依据。

日期：2026-10-27，America/Chicago。分支 `codex/windows-bridge-phase2-4`。

## 续跑整合更新

旧额度窗口重置后，完成正式 Windows process.run、私有 ACL、用户环境/注册表 PATH、端口发现、长驻双向 IPC/ConPTY 接入。正式 Agent 在 Windows 改为每会话独立 Job，取消先发 ACP 协议通知，500ms 后停止整 Job，再恢复持久会话；POSIX 保留原共享进程路径。

最新合并回归：**42 PASS、0 FAIL、251 assertions、14 文件、47.04s**。`bun run check` 0 error，既有 Svelte warning 1 条；PoC/Bridge TypeScript 通过。正式 Git RPC 直接调用实际平台层，中文 CRLF diff/stage/commit 通过，无测试替换依赖。正式 terminal RPC 通过 PowerShell/CMD UTF-8、resize、持续输出/恢复缓存、关闭后不重新出现。

真实 `agents-live.ts`：审批命令启动后取消，4 个命令进程约 **711ms** 全部消失；会话记忆恢复，独立会话仍健康。[证据](../scripts/poc-win/evidence/2026-10-27-production-agents.json)。新长驻通道另经旧 Gate 1 的专项回归：ACP 22 个进程约 378ms、app-server 11 个约 162ms 清理，均在协议取消宽限 500ms 后执行，恢复成功，无 collateral。专项使用 POC_FILTER，不能冒充完整 12 项重跑。

运行器先 CreateProcessW suspended、加入 Job、再 ResumeThread；失败仅在尚未运行且未加入 Job 的初始进程上作启动回滚。环境通过原生内存环境块传递，不落盘；配置/内嵌 Worker 位于受保护用户目录。编译后的平台适配器已验证在 PATH 无 Node/Bun 时执行内嵌 Worker。ACL 独立读取核实为当前用户与 SYSTEM FullControl，保护继承，Junction 被拒。长驻 IPC 有帧/队列上限，洪泛会失败并清理整 Job，尾部输出已验证完整排空。

扩大回归发现 watcher 的只读共享句柄会短暂阻挡外部原地写入；改为观察性 read/write/delete sharing，保留 no-follow 与句柄真实路径检查。新增原生回归与高频写入已通过。本机 MoveFileEx 替换活跃目标句柄仍可报 EPERM，未宣称此限制消失，Bridge 原子替换继续有界重试。

Gate 2 本机门禁已满足，进入 Phase 3 驻留 PoC。后台 service、install/update/uninstall 尚未实现；Cloudflare 远程联调、干净系统/标准账户、重登/休眠、签名发布均未验收。

新增复跑：`npx --yes --package bun@1.4.4 bun test scripts/poc-win/08-runtime-integration`；真实 Codex 整合：`npx --yes --package bun@1.4.4 bun scripts/poc-win/08-runtime-integration/agents-live.ts`（读取当前用户已登录 Codex，会发起模型请求；仅批准脚本精确匹配的 UUID fixture 命令）。

## Gate 2 本地准出结果

候选实现完成 Gate 2 的本地准出验证后，开始渐进整合正式平台层。没有启用完整 Windows Bridge，也没有执行安装、Cloudflare 部署或 GitHub Actions。

| 准出项 | 直接证据 |
| --- | --- |
| 平台既有回归 | 整合前 9/9；包含 macOS/Linux 边界、服务调用顺序与 Windows 未实现能力拒绝执行 |
| Windows 文件系统 | 11/11；中文、空格、Emoji、大小写、长路径、Junction 越界/悬空、共享锁重试与失败保留原字节、快照收敛、真实回收站及精确还原 |
| Windows Git | 4/4；Git 2.51.0.windows.1、GCM 2.6.1，CRLF/LF 混合、中文 diff/commit、literal path、钩子禁用、超时整 Job 清理 |
| Windows 开发服务 | 1/1；真实 ConPTY PowerShell 启动 Vite，按后代 PID 发现监听端口，复用 Bridge Proxy 转发 HTTP/HMR，断线重连成功，关闭后进程归零 |
| 网页路径工具 | 2/2；Windows drive/UNC 根目录、反斜杠、case 与 POSIX 反斜杠文件名/大小写回归 |
| 合并回归 | 27 PASS，0 FAIL，159 assertions，6 个文件，22.90s |
| 全库静态检查 | 0 error；保留既有 PhoneApp.svelte 无障碍 warning 1 条 |
| PoC TypeScript / license headers | 退出码 0 |

实际浏览器进一步挂载**原有** FilesCard、ChangesCard、BrowserCard 和真实 MachineConn，以候选 Windows 后端通过 RPC 验证，而非静态 mock：

1. FilesCard 读取并保存 `中文 空格.txt` 的中文/Emoji 文本。
2. ChangesCard 显示首行不变、第二行仅 +1/−1，完成 stage，并用 Ctrl+Enter 提交；Git 实际历史为 `20eecff 网页验收 中文提交😀`。
3. BrowserCard 自动列出 `:59134 node.exe 127.0.0.1`，打开真实 Vite 页面。
4. 候选原子写入修改 main.js 后，iframe 无刷新显示 `HMR 已更新 中文😀`；代理日志记录 1 个 WebSocket、1 条 HMR update，避免把直接刷新或绕过代理当作通过。

证据：[浏览器 RPC/代理记录](../scripts/poc-win/evidence/2026-10-27-gate2-browser.json)、[中文 diff 截图](../scripts/poc-win/evidence/2026-10-27-gate2-diff.png)、[HMR 截图](../scripts/poc-win/evidence/2026-10-27-gate2-hmr.png)。这不是 Cloudflare 远程端到端验收，后者属于 Gate 4。

## 已开始的正式整合

- `bridge/src/platform/win32/{paths,native,fs,watch,recycle,job}.ts`：已从验证目录移入；PoC 使用再导出引用同一实现。IFileOperation PowerShell 脚本改为 text asset + EncodedCommand，为单文件打包保留可用路径。
- PlatformAdapter.fs 增加可选 openScope；macOS/Linux 原有 I/O 分支保留。Windows path/canonicalize 与 scoped 文件 RPC 已接入，未实现的 process/service/私有 ACL 能力继续拒绝执行。
- 正式文件 RPC 新增整合测试已通过：14 个断言覆盖 wire 路径、文件/目录操作、binary 编码、.git 和外部 Junction 拒绝。
- Windows Git 策略已移入正式模块，Git 处理函数通过可选 executable/arguments 平台钩子调用；POSIX 原命令构造保留。注册表探测已写为原生 RegGetValueW，强制走该 fallback 的真实回归尚待补齐。
- 当前 Git 执行的 suspended worker/Job 管理仍在 PoC；尚未接入正式 Windows process.run 与 shell.userEnv，因此不能宣称生产 Windows Bridge 已能完整运行。端口发现也尚未移入正式 net adapter。

## 关键失败与修复

最初文件系统 9 PASS、1 FAIL：只申请 FILE_READ_ATTRIBUTES 的目录句柄未阻止改名。加入目录读取权限后，READ-only sharing 又阻塞自身 rename。最终采用 READ|WRITE sharing、禁止 DELETE sharing，加上 NtCreateFile 单组件相对打开与 NtSetInformationFile 句柄相对替换，不通过删除目标或退回原地截断规避问题。独立攻击测试允许父目录改名并替换为外部 Junction，写入仍落在原目录对象，外部文件不变。

监听测试曾只等文件数相等，早于最终内容指纹收敛；现等待最终快照逐项一致。Git 的空 diff.external 曾触发“cannot spawn”错误，已改为 diff/show/log 的 --no-ext-diff 和 --no-textconv。整合后偶见测试目录 EBUSY 清理错误；补齐全部 Job 成员句柄等待，并对独占文件释放采用有界退避，未补杀任何 fixture PID。

## 复跑

```powershell
npx --yes --package bun@1.4.4 bun run test:fs-win32
npx --yes --package bun@1.4.4 bun run test:git-win32
npx --yes --package bun@1.4.4 bun run test:preview-win32
npx --yes --package bun@1.4.4 bun test scripts/poc-win/07-web-gate/path.test.ts
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json
npx --yes --package bun@1.4.4 bun run check
npx --yes --package bun@1.4.4 bun run test:platform
```

浏览器测试入口：`bun scripts/poc-win/07-web-gate/run.ts`，就绪信息写入 ignored artifacts/web-gate-ready.json。打开其 url；验证完创建 manifest.stop 文件，入口会关闭服务和 Job 并清理工作目录。`poke.ts` 仅修改该 UUID 测试目录以触发 HMR。

边界：Windows 11 x64 / Bun 1.4.4，非提权用户；不是另一标准账户或干净系统。UNC 语法/边界已测，未对远程 SMB 共享做 I/O 验收；UNC 回收站明确拒绝，绝不永久删除代替。GCM 安装及非交互配置已测，尚未证明当前账户的 GCM/SSH 远程认证可用。跨平台逻辑回归在 Windows 上执行，真实 macOS/Linux CI 尚未重跑。Gate 3/4、安装升级卸载、休眠/重登、手机远程审批与净室验收均未完成。
