# Windows status 资源采样（2026-10-27）

已在独立 PoC 验证后渐进接入正式 Windows 平台。`coderail status` 显示服务树 PID、working set/private bytes 的逐进程总和、监听地址/端口；`status --json` 保留旧字段并新增 `resources`、可选 `resourcesError`。现有 POSIX adapter 不实现可选 details，原行为保留。

采样通过 native supervisor PID 与创建时间校验建立根身份，捕获后代进程并持有句柄；异步端口查询后再次检查根和各进程存活。内存使用 `K32GetProcessMemoryInfo`，布局只允许 x64。若进程已退出则丢弃样本，查询失败明确返回 unavailable，不伪造零内存或无端口。结果是带时间戳的采样，不是原子系统快照；新生进程可能到下一次采样才出现。working set 含共享页面，总和不是系统独占物理内存。

## 验证

- PoC：真实 Job 内监听器、无关监听器排除、根退出后拒绝旧身份；内存及资源两项合测 2 PASS / 0 FAIL / 7 assertions。
- 平台兼容加资源合测 12 PASS / 0 FAIL / 48 assertions，包含 Linux/macOS 服务迁移静态行为。
- 真实用户生命周期加资源合测 3 PASS / 0 FAIL / 21 assertions：运行中 supervisor/Bridge 数据、重启、停机后 stopped、整个捕获树清空。
- 全库 check：0 error、1 个既有 PhoneApp.svelte a11y warning；Bridge/PoC tsc 和许可头检查通过。
- 正式 exe 构建及独立实机 smoke：CLI PATH 只有 System32，读取运行中后台监听器的内存/PID/端口，停止后返回 resources.running=false。未注册启动项、未修改用户 PATH；服务通过自身控制停止。

```powershell
npx --yes --package bun@1.4.4 bun test bridge/src/platform scripts/poc-win/11-observability
npx --yes --package bun@1.4.4 bun test scripts/poc-win/09-user-service/service.test.ts scripts/poc-win/11-observability
npx --yes --package bun@1.4.4 bun bridge/scripts/build.ts windows-x64
npx --yes --package bun@1.4.4 bun scripts/poc-win/11-observability/compiled-status.ts bridge/build/coderail-windows-x64.exe
```

smoke 输出：

```json
{"compiledStatus":true,"noNodeBunOnCliPath":true,"liveOwnedListener":true,"stoppedResources":true,"registryChanged":false}
```

新产物 0.0.1+0，119853568 bytes，SHA256 `0762b48c5e8e87fd03445e9f65e5217abdfe85e7b82b0b1b8cbef0f31c942236`。未发布。此前 96 项全量回归是状态功能接入前的基线，本次针对性验证不能称为更新后的全量 98 项回归。

Gate 3/4 仍未通过。下一步是写入端日志自动轮转、防火墙指引、真实 Cloudflare/网页手机联调及 CI/发布；重登、休眠、另一标准用户、净室仍单列待验。
