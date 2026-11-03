# Windows 更新与恢复验证

2026-10-27，Bun 1.4.4，Windows 11 x64，非提升当前用户。Gate 3/4 **尚未准出**；本文证明已实现的本机更新子集。

## 正式行为

`coderail update` 从已配对站点的 `/api/version/windows-x64` 获取清单，也支持显式 `--manifest <url>`。清单 schema 1、目标 windows-x64、helperProtocol 1；要求版本、完整 SHA256、64 bytes～1 GiB 的长度（带浏览器的 exe 约 611 MiB）与下载地址。HTTPS 为默认安全边界，仅本地 fixture 允许 loopback HTTP；拒绝含凭据的 URL、不安全重定向、超长清单和不兼容协议。版本相同不下载，低于当前版本则拒绝。

下载按流写入私有临时文件，超时/长度超限/坏 SHA 会清理临时文件。暂存后再验证完整长度、SHA256 和 x64 PE，已有暂存被修改也会拒绝。清单本身依赖配置站点的 TLS 信任，尚无额外发行签名验证。

更新由持续存活的 supervisor 执行。CLI 收到确认后退出；supervisor 排空旧 Bridge Job，精确等待调用者 PID+创建时间退出，然后将 `bin/current` 改名为 `bin/previous`，暂存目录改名为 current。每次 rename 为原子操作，整体有短暂 current 缺失窗口，由 journal 恢复，**不是两个目录的一次整体原子交换**。

候选必须写入匹配 PID、版本与新启动时间的 connecting/connected 状态，并保持存活；失败清理候选 Job，恢复旧字节与安装标记，再启动旧版。此检查证明本地 bootstrap；外部服务是否健康单独由实际 WebSocket 验证。普通网络故障不应当作坏包回滚。

第二次更新前，只有上一份 committed journal 证明所有权且 SHA256 相符的旧备份才可清理。当前 generation 此时保持完整。备份篡改在停旧 Bridge 之前拒绝；清理旧备份中途崩溃后仍能启动已提交版本，并继续更新。

supervisor 在持有实例锁后恢复未完成 journal，依据真实文件布局和 SHA256 处理“rename 已完成、journal 尚未写完”。完成状态也核对 schema/安装 id/版本标记，不静默接受未知未来 schema。崩溃注入仅在 `CODERAIL_POC` 编译条件中启用，正式 helper 不含该入口。

## 证据

```powershell
npx --yes --package bun@1.4.4 bun test scripts/poc-win/10-update
node bridge/node_modules/typescript/bin/tsc -p scripts/poc-win/tsconfig.json --noEmit
npx --yes --package bun@1.4.4 bun scripts/poc-win/10-update/compiled-update.ts <old.exe> <new.exe>
```

最后一项是显式脚本，会短暂操作真实 HKCU CodeRail/Path，拒绝已有启动项，必须与普通回归串行执行。两个真实打包版本已实测：

```json
{"compiledUpdate":true,"from":"0.0.1+900001","to":"0.0.1+900002","supervisorPidStable":true,"badShaRefused":true,"previousVersionExecutable":true,"defaultManifestRoute":true,"bridgeReconnected":true,"reconnectGapMs":2007,"updateMs":8466,"cloudflareE2E":false}
{"compiledUpdateThenUninstall":true,"noNodeBunOnPath":true,"pairedBackground":true,"cloudflareE2E":false,"ownStartupRemoved":true,"pathRestored":true,"installedImageRemoved":true,"ownedServiceProcessesRemaining":0,"realRelog":false,"cleanRoom":false}
```

900001/900002 是本地测试构建号，未发布。最后又补充了完成 journal 的 schema/标记核查；完整源码回归 **96 PASS / 0 FAIL / 612 assertions / 50 files / 159.04s**，全库 check 0 error、既有 warning 1，Bridge/PoC TypeScript 通过。最新默认 `0.0.1+0` 包重建后，真实配对后台→卸载 smoke 再次通过。默认包 119851520 bytes，SHA256 `2e1b7ed2e8c00ccbfeda71afebebba04ef5e36666617b9372d47f1faed00121f`。

独立验证还证明：运行中的私有映像可取得 DELETE 权限句柄并改名其 generation 目录，映像仍运行；直接删除运行中映像此前返回 Win32 5。两种操作不能混为一谈，不依赖映像直接自删除。

## 本轮修复与限制

- Bun 1.4.4 的 Windows spawn 不显式传 env 时，本进程新加入的环境变量未被转发；独立 PoC 复现，服务启动现显式传规范化环境。
- 更新/回滚更换控制 nonce 时，旧 stop 请求可能丢失；stop 现在在同一 root PID+创建时间下跟随当前 nonce，并捕获新出现的子树，未用 fixture PID 补杀。
- 一次失败探针遗留的服务已使用修正后的通用 stop 控制正常收割；它仍记为失败历史，不算测试通过。
- 当前 helper ABI 为 1；旧开发包的 helper ABI 0 明确拒绝安全更新，需要重装当前包。更新保持 helper 进程不变；未来 helper ABI 升级还需独立迁移设计。
- Worker Windows Manifest 路由、下载发布、代码签名/SmartScreen 方案、真实 Cloudflare 会话/审批回放尚未完成，不能将本地协议 fixture 当成发布验证。
- writer 自动轮转、status 的 PID/内存/监听详情、防火墙引导待补；实际标准用户、重登、休眠与净室测试仍待验。
- GitHub 授权现已生效，组织有在线 Linux x64 与 macOS ARM64 runner，没有 Windows runner。发布组只允许 main 上 release.yml；不猜空闲、不触发不兼容系统的测试。
