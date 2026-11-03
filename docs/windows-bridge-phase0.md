# Windows bridge: Phase 0

核查日期：2026-10-26（America/Chicago）。用户已确认审计清单与平台隔离方向。

## 外部权限

本轮只执行只读权限查询，未推送、发布、触发 Actions、部署或修改远程数据库。

| 项目 | 实测证据 | 边界 |
| --- | --- | --- |
| GitHub | `gh auth status`：koerimikan，repo / workflow scope；仓库 API：admin / push 为 true | 未进行写操作探针 |
| Actions | 已启用；Release active；release 环境仅允许 main | 允许 GitHub 官方 Actions 与 oven-sh/setup-bun；未验证 runner 可用性、secret 有效性 |
| Releases | 仓库 admin / push，workflow 声明 contents:write | 未创建 Release |
| Cloudflare | Wrangler 4.145.0 OAuth 登录成功，能访问 Wiva 账户，含 Workers 与 D1 写 scope | scope 不等于实际部署成功 |
| Worker | `deployments list -c wrangler.test.jsonc` 成功 | 仅验证 coderail-test 可读 |
| D1 | `d1 info coderail-test -c wrangler.test.jsonc` 成功 | 未执行写入或 migration |
| Durable Objects | 配置包含 MACHINE → Machine 及 SQLite migration | namespace 和 migration 权限未单独验证 |

目标测试部署使用 `wrangler.test.jsonc`，Worker / D1 均为 `coderail-test`。
默认 `wrangler.jsonc` 是自部署模板，不自动认定为已部署目标。

## 已迁移边界

`bridge/src/platform/types.ts` 定义 `path`、`process`、`shell`、`fs`、`net`、`service`，以及 Git 平台参数。
`index.ts` 显式选择 darwin / linux / win32；未知平台拒绝执行。

| 原入口 | 平台实现 |
| --- | --- |
| env.ts：用户环境、PATH、命令执行、Full Disk Access | posix/index.ts |
| main.ts：launchd / systemd、状态、日志跟随、浏览器打开、停止信号 | posix/service.ts、posix/index.ts |
| terminals.ts：默认 shell、启动和旧信号终止 | shell / process |
| agents.ts：ACP 子进程启动、工具发现和旧终止 | shell / process |
| scope.ts：真实路径、目录包含、.git 路径段 | fs / path；授权决策保留在 scope.ts |
| config.ts：私有目录和文件 mode | fs |
| files.ts：平台回收站目录 | fs |
| git.ts：安全 Git 参数、环境、空文件 diff 路径 | git |
| proxy.ts：lsof 端口发现 | net |

Windows 桩对未实现操作抛出 `PlatformUnsupportedError`，不回退到 POSIX。版本、帮助、机器基础信息可加载，服务状态返回 unsupported。

## 与接口草案的分阶段差异

Phase 0 保留 Bun 子进程句柄和显式命名的 `stopLegacy` 兼容层，以原样迁移现有 POSIX 行为。
**该层不承诺进程树清理，不是 Windows 终止方案。** Windows 的 spawn / stop 均拒绝执行。

草案中的 ManagedProcess / PtySession、terminateTree、原子写入、watch、网络变化提示等，分别在 Phase 1 / 2 / 3 的 PoC 和功能实现后替换或补齐。不可把 Phase 0 当作 Windows 远程执行已可用。

已有终端缓存、ACP 协议取消、WebSocket 转发、会话和审批逻辑仍在业务层。
协议包与 Worker 的字符串路径判断尚未改为 Windows 语义；Windows 文件访问必须保持禁用，直到 Phase 2 完成端到端授权测试。
构建 target、安装脚本、下载 manifest 和发布流水线仍待后续阶段处理。

## 本轮独立安全变更

真实路径使用异步 `fs.realpath.native`（与 sync.native 等价的底层接口），避免 macOS 权限等待阻塞主线程。
仅 ENOENT 允许回退解析最近存在父目录；其他错误直接失败。
拒绝通过悬空链接创建文件，拒绝将普通文件当成父目录。
目录包含判断使用路径边界，避免 `/work` 与 `/work-other` 混淆。
这些是安全行为收紧，不将其描述为纯搬移。仍存在路径检查和操作之间的竞争窗口，Phase 2 需继续处理。

## 验证

使用与 CI 一致的 Bun 1.4.4：

```powershell
npx --yes --package bun@1.4.4 bun install --frozen-lockfile
npx --yes --package bun@1.4.4 bun run check
npx --yes --package bun@1.4.4 bun run test:platform
npx --yes --package bun@1.4.4 bun scripts/license-headers.ts --check
```

修改前基线：Worker / bridge TypeScript 通过；Svelte 0 error、1 条既有无障碍 warning；许可证检查通过。
新增测试验证：平台选择、Windows 拒绝回退、POSIX 路径边界、真实 Junction/符号链接解析、创建路径回退、悬空链接、非目录父节点，以及 launchd / systemd 生成内容和命令顺序。

服务测试使用注入的命令执行器，不安装或停止本机服务。当前主机为 Windows；未声称验证 macOS/Linux 上真实 PTY、launchd 或 systemd 运行。

修改后验证结果：

| 检查 | 结果 |
| --- | --- |
| frozen lockfile 安装 | 通过；锁文件未修改 |
| 全项目 check | 通过；0 error，1 条与基线相同的 Svelte warning |
| test:platform | 9 pass，0 fail，37 assertions |
| license-headers --check | 通过；新增源码也均带许可证头 |
| git diff --check | 通过 |
| CLI version | 0.0.1+0 |
| CLI status --json | 正常返回，Windows service 为 unsupported |

Gate 0 的既有静态检查和本轮新增测试全部通过。原生 macOS/Linux 运行回归仍需在对应系统执行；Phase 1 不得据此宣称 Windows 终端、进程树或 Codex 已验证。

后续首要风险验证在 `scripts/poc-win/` 中完成：Bun compile / 子进程 / WebSocket / watcher → ConPTY → 进程树清理 → Codex 协议取消。
