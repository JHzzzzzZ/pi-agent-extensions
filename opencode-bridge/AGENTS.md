# opencode-bridge 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:12:29Z / Commit: 56da138 / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
本地 HTTP CONNECT → SOCKS5 桥：`helper` 独立进程让 Pi `httpProxy` 经 v2rayN 转发。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 桥进程 | `opencode-bridge-helper.mjs`（零依赖，socket 错误/ECONNRESET 下存活，端口被占以 0 退出） |
| 探测/派生 | `bridge.ts`（`session_start` 先探 `127.0.0.1:<port>`，多实例共享同一桥，detached+unref） |
| settings 同步 | `index.ts` `/opencode-bridge-sync`（人工确认，仅增/删 `httpProxy`，余字段不动） |
| 恢复 | `/opencode-bridge-restore`（备选列表恢复，恢复前再备一份当前配置） |
| 状态 | `/opencode-bridge` 状态命令 |
| 端口配置 | `PI_BRIDGE_PORT`/`PI_BRIDGE_SOCKS_HOST`/`PI_BRIDGE_SOCKS_PORT` |

## CONVENTIONS
- 扩展绝不自动改 settings.json —— 自动写则多 Pi 实例竞态丢配置。
- 写前备份 `settings.json.bak-opencode-bridge-<时间戳>` —— 无备份即不可撤销。
- settings 读写经 `ProxySyncDeps` 注入（plan/apply 两阶段）—— 直读写则测试无法确定性复现竞态。
- 探测/派生/fs/sleep 经 `BridgeDeps` 注入 —— 违则 helper 集成测试须拉真实网。
- 端口自定义走环境变量（交互式持久化见 todo 未做）—— 改 `httpProxy` 不联动探测端口即断连。

## ANTI-PATTERNS
- Pi 持有桥子进程资源 —— 实证：detached+unref，Pi 退出桥仍活，多实例共享。
- 整文件重写 settings —— 实证：sync 只动 `httpProxy` 一字段，余配置原样保留。
- helper 遇 ECONNRESET 退出 —— 实证：`helper.test.ts` 手写 fake SOCKS5 压测存活。
- 端口被占报错 —— 实证：被占以 0 退出，视为已有桥复用。

## COMMANDS
```bash
cd opencode-bridge && npm install && npm test   # 70 测试；另有 npm run typecheck
```
