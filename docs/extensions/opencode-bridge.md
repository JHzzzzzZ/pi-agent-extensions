# opencode-bridge — HTTP CONNECT → SOCKS5 桥 helper 的拉起与 settings 联动

> last verified @ 0260f89

## 职责与边界

opencode-go 等模型按出口 IP 限区，Pi 又只支持 HTTP 代理（不认 socks5://）——本扩展在 session_start 拉起/复用一个独立 helper 进程（opencode-bridge-helper.mjs），把 Pi 的 httpProxy 流量经 HTTP CONNECT 转到本地 SOCKS5（v2rayN 默认 127.0.0.1:10808）。**不做**：绝不自动改 settings.json（sync 必须人工确认；solo 开启时例外，由 solo 审批门自动批准，见 `docs/cross/solo-approval-gate.md`）、不是开机自启（随 Pi 会话起）、不持有 helper 子进程资源、不代理 Pi 以外的流量。

## 文件地图

- `opencode-bridge-helper.mjs` — 零依赖独立进程，HTTP CONNECT → SOCKS5 桥本体；协议行为注释即契约。改协议必看这里。
- `bridge.ts` — 可测试核心逻辑（配置解析、端口探测、ensureBridge 生命周期、sync/restore 的 plan/apply），**不 import Pi 宿主 API**。
- `index.ts` — Pi 宿主接线：session_start 探测/拉起、`/opencode-bridge`（状态）、`/opencode-bridge-sync [port]`、`/opencode-bridge-restore`；审批门经 `solo-gate.ts`（只读，fail-closed）。
- `helper.test.ts`（真实子进程集成）、`bridge.test.ts`（全 fake 单测）、`index.test.ts`（fake Pi 宿主 + fake deps）。

## 核心数据流

1. session_start → 探测 `127.0.0.1:<port>` → 已有桥直接复用（多 Pi/subagent 实例共享一个桥），否则 detached + unref 派生 helper，Pi 不持有子进程。
2. `/opencode-bridge-sync` → planHttpProxySync 只读出 plan（SET / REMOVE / NOOP / FOREIGN）→ ctx.ui.confirm 人工确认（solo 激活时自动批准）→ applyHttpProxySync 备份原文后落盘 → 重启 Pi 才生效。
3. 改端口：一次确认覆盖全部动作——指纹确认停旧桥（shutdown 响应体含自家 BRIDGE_SHUTDOWN_MARKER）→ 起新桥 → httpProxy 写入联动；端口持久化到 settings.json 同目录 opencode-bridge.json。
4. `/opencode-bridge-restore` → 从备份列表选择恢复（人工确认）；恢复前先把当前配置再备份一份，保证恢复本身可撤销。

## 不变量

- fail-closed：任何落盘动作（写 httpProxy / 改端口迁移 / 恢复备份）必须经一次人工 confirm 才执行（solo 模式除外：`isSoloActive()` 命中则自动按批准路径，restore 自动选最新备份），plan/apply 两阶段（planHttpProxySync / applyHttpProxySync，bridge.ts）——绝无静默写入路径。
- 仅增/删 httpProxy 字段，settings.json 其余配置原样保留（bridge.ts applyHttpProxySync）。
- 写前备份：`settings.json.bak-opencode-bridge-<时间戳>`；restore 前再备份当前配置（bridge.ts applyRestore）。
- FOREIGN：检测到非本桥的已有 httpProxy 一律不碰、不覆盖。
- 端口优先级：命令参数 > `PI_BRIDGE_PORT` > opencode-bridge.json > 默认 10899；仅绑定 127.0.0.1（bridge.ts）。
- 指纹门控：停旧桥前必须验证响应体含 BRIDGE_SHUTDOWN_MARKER，不符即中止——防止误杀同端口上别人的代理（bridge.ts）。
- 自包含：核心逻辑不引 Pi 宿主 API，socket/fs/spawn/sleep 边界全经 BridgeDeps 注入，settings/端口配置读写经 ProxySyncDeps 注入（docs/cross/deps-ports.md）。

## 已知坑

- fae081e：jiti 转译下 import.meta.url 是 data: URI，fileURLToPath 抛异常被静默吞掉，只剩 ~/.pi/agent/extensions 兜底——git 检出安装时报 HELPER_MISSING。修复 = 仅 file: URL 才走 fileURLToPath + `__dirname` 兜底候选；改 helper 寻址勿回退。
- helper 监听端口被占（EADDRINUSE）以 0 退出是**故意的**多实例竞争安全设计，不是 bug（helper.test.ts 有回归）。
- ECONNRESET 回归：客户端中途断开后 helper 必须存活——每个 socket 的 error/close 都要清理对端，helper.test.ts 专测此条。
- 分片 SOCKS5 应答必须按缓冲累积解析，不能假设单个 data 事件是完整握手包（helper.test.ts 分片用例）。
- v1.1.0 曾在 session_start 自动改 settings.json，155e449（breaking `!`）改回手动确认——别"顺手"加回自动化。
- httpProxy 写入要重启 Pi 才生效；sync 后"看似没生效"多半是这个。
- helper 日志写在 helper 同目录 opencode-bridge.log，单行与文件大小有上限，只记诊断不记 payload。

## 改动清单

- 必跑：`cd opencode-bridge && npm install && npm test`（113 个）+ `npm run typecheck`。
- 协议/进程契约改动 → 必看 `helper.test.ts`（真实 helper + 手写 fake SOCKS5，无外部网络）；配置/生命周期 → `bridge.test.ts`；宿主接线 → `index.test.ts`。
- fake 模式（docs/cross/deps-ports.md）：进程/IO 边界手写 fake BridgeDeps / ProxySyncDeps；宿主交互 fake pi（对齐 goal 手写风格）；协议契约接真实 helper 子进程——文件系统/子进程行为纯函数测试抓不住。
