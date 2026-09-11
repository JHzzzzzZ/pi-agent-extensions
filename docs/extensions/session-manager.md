# session-manager — 落盘会话只读浏览/检索（agent 工具 + 冒号命令）

> last verified @ b93d85c

## 职责与边界

把 `~/.pi/agent/sessions/` 里落盘的 Pi 会话（v3 JSONL，按 cwd 编码目录组织）变成可查询的资产：agent 工具 `session`（`action="list|search|preview"`）+ 人类冒号命令 `/session-manager`、`/session-manager:list|search|preview`。

**不做**：不写任何会话文件（只读增量）；不做「第二个主界面」（单进程单 TuiMainScreen，见 agent-team todo 路径裁决）；不自己实现接续/分支——只输出宿主命令 `pi --session <id>` / `pi --fork <id>`（宿主接受 id 前缀），不 spawn；没有 TUI 状态条/widget（无 status 键）。

**边界契约**：删除/重命名/标签/归档属后续写增量，默认 dry-run + 确认；检索只覆盖用户/助手文本与会话名，工具输出（toolResult）不参与。

## 文件地图

- `core.ts` — 唯一实现源，零运行时依赖：`parseSessionText(text, facts)`（header/session_info/model_change/message 汇总；坏行与未知 entry 跳过）、`listSessions`（按 mtime 倒序、cwd 过滤、缺目录报错）、`searchSessions`（大小写不敏感、每会话 ≤2 条摘要、命中数排序）、`previewSession`（id 前缀/文件名前缀唯一定位；歧义列出候选；尾 6 条消息 + 接续命令）、三个 `format*` 确定性文本、`sessionRootOf`（会话根推断）、`SessionFsDeps` 注入缝。
- `index.ts` — 扩展接线：工具参数 → `runAction` → core；`SessionManagerOverrides.rootDir` 注入测试根目录；裸 `/session-manager` = 当前项目列表 + 旧空格写法改名提示；`sessionRootOf(ctx.sessionManager.getSessionDir())` 全 try/catch 兜底（宿主差异不崩）。
- `core.test.ts`（6 个）+ `index.test.ts`（4 个）— 真实临时 JSONL 目录；fake fs 只覆盖「读失败/坏文件」进程边界；fake ExtensionAPI 只捕获注册面。
- `package.json` — 带 `pi.extensions: ["./index.ts"]` 清单（typebox 仅 devDependency）。
- 安装冒烟期望在根 `tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS["session-manager"]`（4 条命令、无 uiKeys）。

## 核心数据流

1. agent 工具 `session` → `runAction(params, root, cwd)`：`list`/`search` 的 `scope="current"` 用 `ctx.sessionManager.getCwd()` 过滤；`preview` 用 id/文件名前缀定位。
2. 人类命令 → 同一 `runAction` 通道 → `ctx.ui.notify`（失败 warning；headless 经 hasUI 守卫跳过）。
3. 读取路径：`jsonlFilesOf` 同时认默认形态（`<root>/--<encoded-cwd>--/x.jsonl`）与自定义会话目录（`<root>/x.jsonl`）；每份文件读全文 → `parseSessionText`；无 header（无 id）的文件不是会话，跳过。
4. preview 文本末尾给出 `pi --session/--fork <8 位 id>`：把「找到会话」与「接续它」的交接面留给宿主。

## 不变量

- **只读**：任何 action 都不写会话目录；没有删除/改名/移动代码路径（写增量落地前这条是安全保证）。
- **单坏点不扩散**：文件读取失败、`stat` 竞态、坏 JSON 行一律跳过（宿主 discovery 同口径）；目录缺失才返回 `SESSION_DIR_MISSING`。
- **检索口径固定**：用户 + 助手文本 + 会话名；大小写不敏感；空检索词 `SESSION_BAD_QUERY`；默认上限 20 个会话。
- **确定性文本**：`format*` 输出不依赖随机/当前时间（只用文件 mtime），测试直接断言格式。
- **工具不抛异常**：所有失败转 `isError` 文本；宿主 `sessionManager` API 缺失时回退 `process.cwd()` / `~/.pi/agent/sessions`。

## 已知坑

- **id 前缀歧义**：`preview` 用 8 位片段；多条命中会给候选清单（`SESSION_AMBIGUOUS`），不会猜第一条。
- **`sessionRootOf` 是启发式**：默认会话目录名 `--x--` 取父目录；自定义 `--session-dir` 非该形态时原样使用（此时列的是该目录内的 jsonl）。
- **工具输出搜不到**：bash/read 的输出不进检索（避免「命令回显」噪音）；要找相关内容搜对话文本里的关键词。
- **性能**：list/search 会读全部 jsonl 全文（真实 173 个会话/100MB ≈ 0.6s）；超大目录的索引化留给需要时再做。
- **无 typecheck 门**：本目录只有 `npm test`（10 个），无 tsconfig（与 todo-cli/goal 等一致）。

## 改动清单

- 必跑：`cd session-manager && npm test`（10 个）；根 `npm run test:contract`、`npm run test:smoke` 不受影响但改集成面后应跑。
- 改命令面：同步 `EXTENSION_EXPECTATIONS`（tools/install-smoke.mjs）+ 根 README + 本卡 + `docs/INDEX.md` 摘要行。
- 加写操作（rename/tag/cleanup）：先补 `core.test.ts` 的 dry-run/确认用例，再在 core 加显式写函数（不碰宿主格式：rename 走 `session_info` 追加语义需与宿主核对）。
- 改检索口径/根目录推断：更新本卡「不变量」「已知坑」与 `todos/session-manager-todo.md` 进展。
