# Windows supervisor 日志轮转验证（2026-10-27）

正式 Windows helper 现通过管道接收 Bridge 的合并 stdout/stderr，由 supervisor 独占写入日志；子进程不再持有需要轮转的文件句柄。独立 sink 与候选 pipe PoC 通过后才接入正式平台，POSIX 服务未改变。

## 行为与安全边界

- `bridge.log` 和一个 `bridge.log.1`，各最多 10 MiB。持续输出时在 UTF-8 字符边界轮转；流式 Decoder 跨输入块保存部分字符，非法 UTF-8 使用替换字符，不按 GBK 猜测解码。
- 轮转通过持有的原生文件句柄，相对于 pinned 目录句柄 rename。逐级目录与文件均检查底层物理路径，拒绝 Junction/reparse、硬链接、只读文件和路径变化；不通过未验证的路径写入。文件拒绝第二个写入者，允许读取/rename；rename 的共享冲突有有限退避。
- 旧超大当前/备份日志在启动时保留最多 10 MiB 尾部，向前跳过截断起点的 UTF-8 continuation bytes。裁剪是诊断保留策略，不是可恢复的审计归档事务。
- 创建进程只显式继承 pipe 写端；supervisor 创建子进程后立即关闭自己的写端。旧 Bridge Job 排空后等待 pipe EOF，再做更新切换/清理。pipe 写盘失败会记录 supervisor 错误并关闭 Job；不让服务继续悄悄丢日志。
- `logs -f` 原有 native reader 能识别文件身份变更。快速轮转可能跳过未及时读取的旧文件内容，不承诺完整回放所有日志；完整归档不在本实现范围。
- 轮转随新包内 helper 安装生效。现有更新保留长期运行的 ABI 1 helper，不能把只更新 Bridge EXE 等同于替换旧 helper。现有 install 拒绝已有安装，尚无正式保留配对修复命令；不要把重新安装当作已经可用的流程。树外修复候选见 [helper 专项 PoC](windows-bridge-phase3-helper-upgrade.md)，自动迁移仍未完成。

## 实测结果

独立 sink：7-byte 输入块拆开中文/Emoji，循环轮转、重启追加、超大旧日志裁剪、当前/备份硬链接拒绝均通过。保留的备份+当前内容与原输入的精确尾部比较，并以 fatal UTF-8 解码验证。

真实 supervisor pipe：持续 stdout/stderr 输出，子进程保持句柄打开时仍可轮转；native LogTail 读取最新中文；停止后 Job/pipe 排空。备份在运行中被替换为硬链接时，外部文件不变、服务失败关闭、捕获命令身份退出。

最终完整整合：**101 PASS / 0 FAIL / 655 assertions / 54 files / 144.34s**。全库 check 0 error / 1 个既有 PhoneApp.svelte a11y warning；PoC TypeScript、许可头检查通过。原始日志在 ignored `scripts/poc-win/artifacts/latest-regression.log` 和 `latest-check.log`，需在目标机器重新运行复现。

```powershell
npx --yes --package bun@1.4.4 bun test bridge/src/platform scripts/poc-win/04-filesystem scripts/poc-win/05-git scripts/poc-win/06-preview scripts/poc-win/07-web-gate/path.test.ts scripts/poc-win/08-runtime-integration scripts/poc-win/09-user-service scripts/poc-win/10-update scripts/poc-win/11-observability
npx --yes --package bun@1.4.4 bun run check
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json --noEmit
npx --yes --package bun@1.4.4 bun scripts/license-headers.ts --check
npx --yes --package bun@1.4.4 bun bridge/scripts/build.ts windows-x64
```

最后一条编译产物 0.0.1+0，119869440 bytes，SHA256 `67bf97a48cd1199b5b537af6c927088221d20a7a513ab1f71c3faa95b8268201`，未发布。

完整回归结束后**串行**运行以下显式实机实验，避免安装器真实 PATH 改动与回归冲突。脚本拒绝已存在的 CodeRail 启动项，短暂注册 HKCU/PATH 并在结束时核对恢复；不应与用户在用的正式安装并跑。

```powershell
npx --yes --package bun@1.4.4 bun scripts/poc-win/09-user-service/compiled-lifecycle.ts --paired --logs
```

实际输出：

```json
{"compiledEmbeddedLogPipe":true,"legacyLogsBounded":true,"unicodeTailPreserved":true,"logsCli":true}
{"compiledInstallUninstall":true,"noNodeBunOnPath":true,"pairedBackground":true,"cloudflareE2E":false,"ownStartupRemoved":true,"pathRestored":true,"installedImageRemoved":true,"ownedServiceProcessesRemaining":0,"realRelog":false,"cleanRoom":false}
```

实机使用真正包内 helper，无安装现场 C# 编译依赖，CLI PATH 只保留 System32；11 MiB 的当前日志与备份被限制并保留中文尾部。配对服务器是本地协议 fixture，不能代替真实 Cloudflare/手机端联调。

## Gate 与后续

Gate 2 本机已通过，Gate 3/4 **未通过**。本轮另补 [用户安装与防火墙说明](windows-bridge-user-guide.md)，CLI 提示仅需到站点的出站 HTTPS/WebSocket，未改防火墙或要求管理员。

仍待真实另一标准用户、重登自启、休眠/网络切换、净室验收和 helper 升级迁移。Cloudflare Windows 下载/Manifest、真实网页/手机审批与历史回放、Windows runner/签名发布未完成；未部署、触发 Actions 或创建 Release。
