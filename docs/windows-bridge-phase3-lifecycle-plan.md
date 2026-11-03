# Windows 安装、更新与卸载剩余实现边界

本文件记录已实测的架构约束，避免后续继续基于父进程存活的测试误判驻留完成。Gate 3/4 **尚未准出**。2026-10-27，分支 `codex/windows-bridge-phase2-4`。

## 2026-10-27 最新补充

最新覆盖：status 资源详情与 writer 自动轮转均已渐进接入正式 Windows 平台，最终完整回归 101 PASS/0 FAIL/655 assertions，真实包内 helper 安装、中文日志裁剪轮转、配对后台和卸载通过。详见 [status](windows-bridge-phase3-status.md)、[日志轮转](windows-bridge-phase3-logging.md)。下方 85 项与对应未实现项为历史断点。Gate 3/4 仍未通过，helper 自动迁移与真实账户/重登/休眠/Cloudflare 验收仍待完成。

正式 install/uninstall 与 supervisor 清理 actor 已按独立 PoC → 平台模块 → 真实编译 CLI 跑通，详见 [最新安装卸载证据](windows-bridge-phase3-cleanup.md)。下方“仅证明机制、完整卸载未实现”等条目是先前断点，已被此进展覆盖。Gate 3/4 仍未准出。

最新整合 **85 PASS / 0 FAIL / 500 assertions / 44 files**；另新增停服双目录切换/健康失败回退 PoC **1 PASS/16 assertions**。持续 supervisor 更新与回滚、真实崩溃 journal 恢复已实测并渐进合入，详见 [更新证据](windows-bridge-phase3-update.md)。下一步补 writer 轮转、status 详情及真实远程/手工验收。不能把 detached 或父 CLI 退出当成 Job 逃逸。仍需更新崩溃恢复、实际远程联调及标准用户/重登/休眠/净室验收。

## 已关闭的能力问题（历史断点）

| 问题 | 真实结果 | 采用方式 |
| --- | --- | --- |
| 只 unref 能否越过安装 CLI 退出 | 独立夹具和真实 UserService 父 CLI 退出测试均复现后台消失 | supervisor 启动同时设置 `detached:true` 和 unref；实际父退出回归已通过 |
| detached 能否逃离外层命令 Job | 不能；父 CLI 已正常退出，后台仍为外层 Job 成员，关闭 Job 后消失 | 不开放命令逃逸；远程会话内的更新/卸载应交给独立 supervisor actor |
| 正在运行的映像能否直接删掉 | 私有 ping.exe 拷贝上尝试 POSIX disposition，Win32 5，映像仍存在 | 不依赖自删除、重启后删除或管理员权限 |
| 内存加载的托管 helper 能否释放磁盘映像 | SHA256 验证实际字节，再 Assembly.Load；磁盘文件删除后方法仍正常运行 | 可用系统 PowerShell 加载包内已验证 helper，避免占用安装目录 EXE；只证明机制，未实现生产卸载 |
| 旧 Bridge Job 内的命令能否完成自身重启 | 旧 Job 被清理会杀调用者 | 正式 supervisor 已持有重启控制：整旧 Job 清零后再启动新 Bridge，supervisor PID 不变 |

独立入口：`parent-exit.test.ts`、`background-job.test.ts`、`self-delete.test.ts`、`memory-cleanup.test.ts`。后两项 probe 的 PASS 表示准确检测平台能力，**不表示卸载已实现**。运行中的系统 ping.exe 从未修改，测试仅执行私有副本。

## 下一步实现顺序

1. **可恢复的安装事务**。现有 `install-transaction.ts` 已验证仅注册但不启动、所有权冲突拒绝、注册表提交后注入失败的 PATH/启动项撤回。应加入 journal 恢复路径和失败后已拥有文件的清理，再迁入正式模块、开放 `install`。不能将保留诊断文件称为零残留。不得覆盖未知 PATH 改动、其他启动项或非自有目录。
2. **受控清理 actor**。清理必须来自 Bridge Job 之外；不能在被清理的 Job 中 spawn 一个 helper 就假设它会存活。先在 supervisor 下验证 actor 的 Job/句柄生命周期、精确等待 CLI PID+创建时间退出，再做文件移除。验证 helper 的实际内存字节 SHA256 后加载，不能先 Get-FileHash 路径、再重新读可替换的文件加载。
3. **清理安全边界**。安装 id/物理 root/journal 必须一致；逐级原生 no-follow 句柄，拒绝外部 Junction/目录替换及未知所有权；只操作明确拥有的状态、bin/runtime/adapters 和启动项/PATH。不得用拼接 shell、跨 shell 递归删除、或 `Remove-Item -Recurse` 跟随未知路径。未知文件或锁未释放应保留目录并给出明确失败结果。
4. **更新激活**。现有暂存已验证长度+完整 SHA256+x64、篡改/追加 overlay 拒绝、旧安装不变。还需由 supervisor actor 停旧 Job、切换 current/previous、启动新版、验证真实健康响应；失败按同样顺序退回 previous。不能让旧 Bridge 子进程承担切换。Manifest 获取与签名/来源信任、超时/下载上限、更新事务 journal 仍需实现。
5. **本机闭环后再远程/发布**。复用现有测试 Worker 完成真实配对、浏览器与手机审批/历史回放；本地协议 fixture 不代替 Cloudflare。组织 Windows runner 访问/标签未核实前不触发 Actions。Windows 标准用户、重登、真实睡眠、净室验收单列，不以故障注入代替。

## 代理与日志边界

正式 Windows 网络层已接入只读当前用户 WinHTTP 手工代理，HTTP/WS 显式代理与 CONNECT 双向往返在 Bun 1.4.4 实测通过；显式 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 继续交 Bun 处理，系统代理回退尊重 host/domain/port NO_PROXY 与本地预览。PAC/WPAD 自动求解、SOCKS、系统代理回退的 CIDR NO_PROXY 不在已验证支持范围；不支持项不能静默当成功。未修改系统代理配置。

依据：[WinHttpGetIEProxyConfigForCurrentUser](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetieproxyconfigforcurrentuser)、[Bun detached](https://bun.sh/reference/bun/Spawn/BaseOptions/detached)、[mapped view 的删除限制](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex)。

正式 logs/-f 已有有界原生句柄读取和 UTF-8 流解码，能跟随追加/截断/外部文件轮换；writer 自动轮转尚未实现，不能将读取测试当成生产日志轮转。文件 Symlink 创建在本机 EPERM，硬链接拒绝已通过，未声称文件 Symlink 分支实测通过。
