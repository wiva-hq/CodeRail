# Windows 用户态服务与安装事务 PoC

在 Windows 11 x64、普通非提权终端运行。统一 Bun 1.4.4：

```powershell
npx --yes --package bun@1.4.4 bun test scripts/poc-win/09-user-service
```

已构建产物的真实 CLI 冒烟（临时私有状态目录，PATH 不含 Node/Bun，逐项验证 version/logs/status）：

```powershell
npx --yes --package bun@1.4.4 bun bridge/scripts/build.ts windows-x64
npx --yes --package bun@1.4.4 bun scripts/poc-win/09-user-service/compiled-cli.ts
```

测试仅注册 `CodeRail-PoC-<UUID>` 临时启动项和用户环境值；不写真实 PATH、不注册永久 CodeRail 后台服务。所有长驻测试子进程由各自 Job 管理并在 finally 中清理。Windows Framework64 C# 编译器用于开发测试；正式构建已嵌入预编译 GUI helper。

| 验证入口 | 验证范围 |
| --- | --- |
| `autorun.test.ts` | HKCU Run 所有权、Unicode、冲突拒绝与精确移除 |
| `supervisor.test.ts` | GUI 子系统、UTF-8、协作退出、异常退出后内核 Job 清理 |
| `service.test.ts` | 注册但不运行、启动、重复启动、同一 supervisor 重启、卸载与进程消失 |
| `restart.test.ts` | 旧 Job 清空再启动新 Bridge、预编译 helper 提取、硬链接/目录 Junction 拒绝 |
| `tree-identity.test.ts` | 用真实进程创建时间排除旧父 PID 关系造成的误归属；确定性模拟旧快照边，不强杀无关进程 |
| `bridge-service.test.ts` | 正式编译 Bridge 经后台服务连接 loopback Worker 协议端、协作停机 |
| `reconnect.test.ts` / `websocket-abort.test.ts` | token 请求黑洞、挂起 upgrade、中断连接、模拟时钟间隙恢复 |
| `user-path.test.ts` | 注册表原类型/宏保存，撤回本次 PATH 条目并保留第三方改动 |
| `install-files.test.ts` | 私有安装文件与所有权、拒绝用户/系统根目录和无关已有文件 |
| `install-transaction.test.ts` | 未配对仅注册；注入注册表提交后故障，回滚启动项和 PATH；保留诊断和已拥有文件 |
| `install-recovery.test.ts` | 安装器在注册表提交后真实退出 42；journal 恢复/幂等、id/路径篡改拒绝与保护第三方启动项，仍保留安装文件 |
| `update-stage.test.ts` | 长度/SHA256/x64 PE 校验、重复暂存、篡改拒绝、当前安装不变 |
| `logs.test.ts` | 有界原生句柄读取、UTF-8 跨块解码、追加/截断/外部换文件、硬链接拒绝、跟随退出；文件 Symlink 因本机 EPERM 未验收 |
| `system-proxy.test.ts` | 只读用户 WinHTTP 配置、环境优先级/绕过、真实 HTTP 与 WS CONNECT；无 PAC/WPAD/SOCKS 支持 |
| `parent-exit.test.ts` / `background-job.test.ts` | 真正退出安装父 CLI 后 supervisor 存活；detached 仍继承外层 Job |
| `self-delete.test.ts` / `memory-cleanup.test.ts` | 检测映像删除限制、验证 SHA256 后内存加载 helper 的删除能力；不等于完整卸载 |

安装和升级文件测试中的合成 PE **从不执行**，仅验证文件策略。它们不能证明安装后的 CLI 可用。注册表回滚不能代替进程崩溃恢复；失败后保留的安装文件不能宣称为净室卸载。升级暂存不激活包，没有实现自动回滚。

测试夹具通过临时文件原子替换发布完整 PID JSON；“文件存在”不等同内容写入完成。历史曾出现未完整 JSON 和一次服务停机超时，见 Phase 3 报告；不得隐藏历史或靠延长超时/fixture PID 补杀宣称稳定。

Gate 3/4 尚缺完整 CLI、日志、安装崩溃恢复与自删除、更新激活/回滚、真实 Cloudflare/手机链路、独立标准用户/重登/睡眠验收。网络故障注入不等同真实系统休眠。不得据此 README 宣称全部准出。
