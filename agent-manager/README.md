# agent-manager — 独立 agent 管理工具（非 Pi 扩展）

`agent-manager` 是一个**独立于 pi 运行**的本地工具：一个 Node HTTP 进程 + 浏览器页面，用来浏览/检索/重命名/删除 pi 落盘会话，并启动/观察/停止本工具发起的 pi agent 子进程。agent 不感知它的存在；pi 未运行也能浏览会话。

- 零构建、零运行时依赖（只用 Node 内置模块），不 import 宿主 SDK（`@earendil-works/*`）、不注册任何 pi 扩展点。
- 仅监听 `127.0.0.1`；**请勿做端口转发/反向代理对外暴露**（页面无鉴权）。
- 服务端与前端都不带任何外部 URL（无 CDN/字体/图标），断网可用。

## 快速开始

```bash
# 从仓库根运行
node agent-manager/server.ts                  # 默认端口 8787，自动打开浏览器
node agent-manager/server.ts --port 9000 --no-open   # 换端口 / 不自动开浏览器

# 或进入目录
cd agent-manager && npm start                 # node server.ts
npm start -- --port 9000 --no-open            # npm 透传参数
```

要求 Node ≥ 22.18（原生 type-stripping 直接运行 `.ts`，无构建步骤）。

`npm start` 之外的开发命令：

```bash
cd agent-manager
npm install            # devDependencies：typescript + @types/node
npm test               # core + agent-runner + server 测试（node:test）
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm run test:e2e       # 真机 e2e（opt-in，需 AGENT_MANAGER_E2E_MODEL + 鉴权 + 网络）
```

## 设置

优先级：**CLI flag > 环境变量 > 配置文件 > 默认值**。

| 设置 | CLI | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 端口 | `--port <n>`（0 = 随机） | `AGENT_MANAGER_PORT` | `8787` |
| 会话目录 | `--sessions <dir>` | `AGENT_MANAGER_SESSION_DIR` | `<home>/.pi/agent/sessions` |
| pi 路径 | `--pi <path>` | `AGENT_MANAGER_PI` | PATH 中的 `pi` |
| 不自动开浏览器 | `--no-open` | `AGENT_MANAGER_NO_OPEN=1` | 自动打开 |
| 帮助 | `--help` / `-h` | — | — |

配置文件由设置页面写入：`<home>/.pi/agent/agent-manager/config.json`（工具自有数据目录；回收站也在同根 `trash/`）。会话目录与 pi 路径保存后即时生效（pi 路径在有运行中 agent 时需重启生效）；**端口改动下次启动生效**，页面会提示。

`--pi` 推荐指向 `cli.js`（如 `.../node_modules/@earendil-works/pi-coding-agent/dist/cli.js`）：Node 直启，绕开 Windows 上 `.cmd` 必须经 `cmd.exe` 包装与引号问题。留空则用 PATH 中的 `pi`。

## 功能

**会话页**：列出/检索（用户+助手文本与会话名，大小写不敏感）会话，预览尾文与宿主接续命令；重命名 = 向会话文件末尾追加一条宿主语义的 `session_info`（不改文件名/header）；删除 = 移入工具回收站（可恢复，含原路径与 mtime）。重命名/删除/恢复都是**两段式**：先 dry-run 返回计划，页面弹确认后再带 `confirm:true` 执行。

**Agents 页**：以 `pi --mode json -p` 启动子进程（新建 / `--session` 接续 / `--fork` 分支），实时查看状态、pid、最后输出与逐行输出（运行列表 2s 轮询、详情 1s 增量轮询，页面隐藏时暂停）；停止按钮二次确认后杀**整个进程树**（win32 `taskkill /T /F`，posix 进程组）。

**设置页**：改 sessionDir / piPath / port 并持久化，显示当前解析出的 pi 命令与各路径。

## 安全边界

- 仅 listen `127.0.0.1`；Host 头白名单（`127.0.0.1` / `localhost` / `[::1]`），伪造 Host 一律 403（防 DNS rebinding）。
- POST 强制 `Content-Type: application/json`（挡跨站表单 CSRF）、请求体 ≤ 1MB。
- 静态资源只允许 `/`、`/index.html`、`/app.js`、`/style.css` 四个白名单路径，其余 404。
- 无鉴权、无多用户：**不要做端口转发**。
- 写操作只发生在用户显式确认后；回收站不自动清空——最坏情况可手工从 `trash/` 恢复（同名 `.meta.json` 记录原路径）。

## 能力边界（明确不做）

- **不做外部 pi 进程发现**：只能看到并管理本工具启动的 agent；别的终端里跑的 pi 与本工具无关。
- 不给运行中的 agent 发消息（想接续就停止后在会话页用 `pi --session <id>` 或本工具「接续」启动）。
- 无鉴权/远程访问、无 WebSocket/SSE、无会话树可视化、无分页/索引、无暗色主题。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `server.ts` | node:http 路由（15 条 API + 静态白名单）、安全守卫、`openBrowser`、CLI 主入口 |
| `settings.ts` | CLI/env/配置文件四级设置解析与持久化 |
| `core.ts` | 会话 JSONL 解析/列出/检索/预览 + 两段式重命名/删除/回收站/恢复 |
| `agent-runner.ts` | pi 子进程启动、JSON 事件归约、输出环形缓冲、进程树停止 |
| `web/index.html` `web/app.js` `web/style.css` | 零依赖前端（三 Tab：会话 / Agents / 设置） |
| `server.test.ts` | 真实 HTTP（端口 0）+ 临时目录 + stub pi 的 13 条契约测试 |
| `e2e.test.ts` | 真机 e2e（opt-in，4 条）：真实廉价模型 + 隔离会话目录 + HTTP 全链路 |

## 真机 e2e

```bash
cd agent-manager
AGENT_MANAGER_E2E_MODEL=opencode-go/deepseek-flash npm run test:e2e
```

未设置 `AGENT_MANAGER_E2E_MODEL` 时用例全绿跳过（无 key/无网环境不会挂）；设置后使用真实 pi + 隔离目录（`PI_CODING_AGENT_SESSION_DIR` 指向临时目录），不触碰用户真实会话。
