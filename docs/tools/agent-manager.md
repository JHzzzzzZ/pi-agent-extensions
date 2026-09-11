# agent-manager — 独立 agent 管理工具（非 Pi 扩展）

> last verified @ 0180cac

## 职责与边界

独立于 pi 运行的本地工具：一个 Node HTTP 进程（仅监听 `127.0.0.1`）+ 零依赖浏览器页面，用于浏览/检索/重命名/可恢复删除 pi 落盘会话，并启动/观察/停止**本工具发起的** pi agent 子进程。pi 未运行也能启动并浏览会话；agent 不感知它。**不是 Pi 扩展**：不注册任何扩展点、不 import 宿主 SDK、根 `package.json` `pi.extensions` 已移除（14→13），install-smoke 不再覆盖它。

**不做**：外部 pi 进程发现（只管理自己启动的 agent）；不给运行中 agent 发消息（接续 = 停止后在会话页用宿主 `pi --session <id>` 或本工具「接续」启动）；无鉴权/多用户/远程访问、无 WebSocket/SSE、无会话树/标签/归档、无分页索引。

**安全边界**：仅 listen `127.0.0.1`（拒绝 0.0.0.0）；Host 头白名单（防 DNS rebinding，伪造 403）；POST 强制 `application/json`（挡跨站表单 CSRF）+ 请求体 ≤1MB；静态资源白名单 `/`、`/index.html`、`/app.js`、`/style.css`（用户输入永不进路径拼接）。页面无鉴权——**勿做端口转发/反向代理**。错误一律静态模板，不回显用户输入。

## 文件地图（8 个 TS 源/测试文件 + web/）

- `core.ts`（W1）— 会话 JSONL 解析/列出/检索/预览 + 两段式 rename/delete/trash/restore；`SessionFsDeps` 注入缝；零运行时依赖。
- `core.test.ts`（14 个）— 真实临时 JSONL 目录真读真写；fs 注入只覆盖「读失败/跨盘 rename 失败」进程边界。
- `agent-runner.ts`（W2）— pi 子进程 start/list/get/output/stop；`resolvePiCommand` 纯函数（platform 注入）；JSON 事件归约；进程树停止。
- `agent-runner.test.ts`（10 个）— fake spawn + 真实短命进程树停止。
- `settings.ts`（W3）— CLI flag > 环境变量 > 配置文件 > 默认值；`SettingsDeps` 注入；配置文件 `<home>/.pi/agent/agent-manager/config.json`（trash 同根）。
- `server.ts`（W3）— node:http 路由（15 条 JSON API + 静态白名单）、安全守卫、`openBrowser`、CLI 主入口。
- `server.test.ts`（13 个）— 真实 HTTP + 端口 0 + 临时目录 + stub pi runner。
- `e2e.test.ts`（4 个，opt-in）— 真实 pi + 廉价模型 + 隔离会话目录（`PI_CODING_AGENT_SESSION_DIR`），`npm run test:e2e`。
- `web/index.html` `web/app.js` `web/style.css` — 纯手写零依赖前端（无 CDN/框架/构建），三区：会话 / Agents / 设置。

## 核心数据流

1. 浏览器 `fetch` JSON → `server.ts` 路由（GET 读一律无副作用，POST 会话扇出到 `core.ts`、agents 扇出到 `AgentRunner`）→ JSON 回浏览器；静态资源按白名单从 `web/` 直读。
2. 会话面：`core.listSessions/searchSessions/previewSession` 读 `--sessions <dir>` 下 JSONL；写面 `renameSession/deleteSession/restoreSession` 只经 `confirm:true` 落盘。
3. Agents 面：`AgentRunner.start` 按 `AgentStartSpec`（cwd/prompt/model/kind/sessionRef）spawn `pi --mode json -p`，逐行 JSON 事件归约成状态与环形输出缓冲；`stop` 杀进程树。
4. 页面轮询：Agents 列表 2s、详情 1s 增量（页面隐藏暂停）；会话/设置按需拉取。

## 不变量

- **会话写两段式**：rename/delete/restore 缺省 `confirm:false` 只返回计划（appendLine / trashName / meta），零写副作用；`confirm:true` 才落盘。
- **rename = 追加宿主语义 `session_info` entry**（来源宿主 `dist/core/session-manager.js` `appendSessionInfo`，已只读核实）：name 清洗 `[\r\n]+`→空格 + trim、id = `randomUUID` 前 8 位且对文件内已有 id 防碰撞、parentId = 文件最后一条 entry 的 id、timestamp = 注入时钟 ISO；不改文件名/header、不写 sidecar。
- **trash 语义**：delete = 移入 `<home>/.pi/agent/agent-manager/trash/`（`<epochMs>-<原文件名>` + `<同名>.meta.json` 记录原路径/mtime）；restore 据此还原；`renameSync` 跨盘失败时 `copyFileSync + unlinkSync` 兜底；trash 不自动清空。
- **读不写 + 单坏点不扩散**：list/search/preview 绝不写；单文件读失败/坏 JSON 行跳过，目录缺失才 `SESSION_DIR_MISSING`；无 header 的文件不是会话。
- **进程归属**：runner 内存态注册表只含本进程启动的 agent；重启工具后不认领旧进程。
- **设置生效边界**：sessionDir/piPath 保存后即时生效（有运行中 agent 时 piPath 需重启）；port 改动下次启动生效（health 回显实际监听端口，settings 回显配置值）。

## 已知坑

- **win32 `pi.cmd` 引号陷阱**：piPath 走 PATH 的 `pi.cmd`（cmd.exe 包装）时，提示词含 `"`/`&`/`|`/`>` 会被 cmd 解析破坏，子进程静默退出无输出；`--pi` 推荐指向 `dist/cli.js`（Node 直启）。README 与设置页均有提示。
- **停止 = 树杀**：win32 `taskkill /T /F`、posix 进程组 `-pid`（pwr/loop 只 kill 单进程，本工具是新能力）；`/F` 强杀丢进行中回合（会话 append-only 落盘，已写入不丢）。
- **`--session <id>` + `-p` 已实证可用**（W3 e2e #3：同一会话 append-only 增长）；接续无需降级路径。
- **`openBrowser` 失败不致命**：catch + stderr 打印手动 URL；win32 `start` 分支未经真机验证（冒烟用 `--no-open`）。
- **大目录同步扫描**：list/search 读全量 JSONL（真实 173 会话/100MB ≈ 0.6s），无索引/分页，超预算再上流式/worker。
- **rename 与运行中 pi 并发写同一 JSONL**：与宿主自身行为一致（宿主无锁）；行级 JSON 独立可解析，最坏交错仍可读。

## 改动清单

- 必跑：`cd agent-manager && npm install && npm test`（37 个）+ `npm run typecheck`；真机 `npm run test:e2e`（opt-in，需 `AGENT_MANAGER_E2E_MODEL` + 鉴权 + 网络）；根 `npm run test:contract` / `test:smoke` / `test:todo` + `node tools/install-smoke.mjs`（12/12，注销后仍证明清单与期望表一致）。
- 改端口/路由/错误码/静态错误模板：同步本卡 + `agent-manager/README.md` + 根 README「agent-manager」章节；不改根 `EXTENSION_EXPECTATIONS`（非扩展，无命令面）。
- 改写语义（rename/trash/restore）：先与宿主 `dist/core/session-manager.js` 复核 `session_info` 形状，再改 core + core.test + 本卡「不变量」。
- 改设置优先级/配置文件位置：同步 `settings.ts` 头注释 + `agent-manager/README.md` 设置表 + 本卡。
