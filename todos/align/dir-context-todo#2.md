# 对齐：dir-context-todo#2 — codemode 下的目录作用域上下文（v1.1）

- 条目：`dir-context-todo#2`（tags: `enhancement`, `codemode`，priority 6）· 分支引用：待定
- 日期：2026-10-10（UTC）· 参与：用户（提出需求 + 指示先补齐文档）+ agent（事实核查与方案）
- 状态：**已对齐**（用户 2026-10-10 确认 A 档与三项默认值）；**按用户要求暂不实现**（只跑 `align`，不二次 `claim`）

## 意图

v1.0.0 交付后已知的缺口：**模型在 codemode 脚本里读文件拿不到目录局部约定**。

`dir-context` 在 `tool_result` 第一行就 `if (event.parentToolCallId) return undefined;` —— 因为宿主明文规定嵌套调用（codemode 脚本通过 `tools.read(...)` 发起的调用）**结果只回到调用方工具，不进 transcript**（`docs/extensions.md`：*"Nested calls do not add transcript entries: their results only reach the calling tool"*，`types.d.ts:273-280`）。往 `tools.read()` 的返回值里塞上下文，模型看不到（只有脚本主动 `text()` 才会到模型），还会污染脚本逻辑。所以 v1.0.0 是**有意跳过**，不是遗漏。

结果：模型一旦用 codemode 干活（`defaultTools: ["+codemode"]` 打开时），`src/components/AGENTS.md` 这类局部约定就断了——这正是 v1.0.0 要补的那一格，在 codemode 路径上又漏回去了。

已核实的事实（宿主 `@earendil-works/pi-coding-agent`，路径相对该包根）：

1. `codemode` 是**内置扩展**（`dist/extensions/index.js:9`：`{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true }`），默认不开；`~/.pi/agent/settings.json` 的 `defaultTools: ["+codemode"]` 或 `--tools` 打开（`docs/cli.md` 的 Enable codemode）。
2. codemode 工具结果带结构化明细：`CodemodeToolDetails { calls: CodemodeNestedCall[]; fullOutputPath? }`，`CodemodeNestedCall { id; name; args: string; status: "running"|"ok"|"error"|"cancelled"; durationMs?; error?; cost? }`（`dist/extensions/codemode/tool.d.ts:68-83`）；`args` 是**紧凑 JSON 且截断**（`execute.js:26-35` 的 `previewArgs`，`JSON.stringify` 后 `truncateText`）。
3. codemode 工具结果本身是**顶层**调用（`parentToolCallId` 为空）⇒ 扩展的 `tool_result` handler 能看到它、能改它的 `content` ⇒ 模型会读到。
4. 宿主导出 `isCodemodeTool(tool)` 用于判别「是本包的 codemode 而非同名工具」（`tool.d.ts:66`）。
5. `docs/extensions.md` 另有一条与注入相关的契约：工具若设置 `structuredContent`，codemode 脚本**收到的是 structuredContent 而不是文本**（`types.d.ts:469`）——即文本注入不会污染脚本侧的结构化路径（但 C 档那种「放开嵌套注入」仍会改变脚本拿到的 `content`）。

## 范围

**做什么（方案 A，推荐）**

1. `tool_result` 上区分两类事件：
   - `parentToolCallId` 为空 → 走现有顶层路径（`event.input`）。
   - 事件是 codemode 工具结果（用 `isCodemodeTool` 判真伪）→ 从 `details.calls` 里提取每个嵌套调用的「触碰」：只认与顶层同一套工具（`read` / `write` / `edit` / `ls` / bash 白名单单文件读），`args` 按紧凑 JSON 解析后复用现有 `detectTouch` 语义。
2. 多个触碰 → 取目录链**并集**（同一目录只取一次），仍按由外向内排序；注入文本作为该 codemode 结果的追加 text block，一次写入。
3. 去重与预算沿用**同一份会话缓存**：已注入过的文件不再注入；单文件 32 KiB、单次 128 KiB 上限不变。
4. `status` 为 `error` / `cancelled` 的嵌套调用**照算**（文件可能已经被读过或写过）——注入与脚本成败无关。
5. `args` 截断/解析失败、非触碰工具（`grep`/`find`/`models.*` 等）、`codemode` 自身嵌套（宿主不允许脚本再起脚本）→ 该条目跳过（降级，不报错）。
6. 文档四面同步：卡片（`docs/extensions/dir-context.md` 的 v1.0 缺口语义）、规格（`docs/specs/dir-context.md`）、根 README 的 dir-context 小节、插件 README；ADR 见 `docs/adr/0012-dir-context-codemode.md`；`CONTEXT.md` 补术语；`docs/INDEX.md` 路由行挂上新 ADR。

**明确不做什么**

- **不做 B 档**（正则扫脚本源码里的路径字符串）：A 档已给出精确的 `name + args`，扫源码只会更脆更模糊。
- **不做 C 档**（放开 `parentToolCallId` 跳过、直接把上下文塞进嵌套 read 结果）：那会改变**脚本**拿到的返回值（`JSON.parse` / 行数计数 / 拼接都会受影响），而模型仍要等脚本主动 `text()` 才可能看到 ⇒ 风险明确、收益不确定。
- 不为 codemode 另开一套去重/预算/上限（复用现有实现，避免两套语义漂移）。
- 不改宿主、不 import 宿主内部路径（只用公开导出 `isCodemodeTool` 与事件类型）。
- 不把 codemode 的脚本输出/结构化明细写进上下文（只读 `details.calls` 的 `name`/`args` 用于定位）。

## 验收标准

1. **触发**：一次 codemode 调用里 `tools.read({path:"src/components/Button.tsx"})` ⇒ 该 codemode 结果末尾出现 `Loaded src/components/AGENTS.md`；`tools.write` 新文件、`tools.ls`、`tools.bash("cat src/index.ts")` 同样触发。
2. **不误触发**：`tools.grep` / `tools.find` / 非路径工具 / 脚本里只调用 `models.*` ⇒ 零注入。
3. **并集与顺序**：一次脚本触碰 `src/a.ts` 与 `src/components/b.tsx` ⇒ 一次注入、目录链合并去重、由外向内。
4. **去重**：同一文件在顶层已注入过，codemode 里再触碰不再注入（同一份会话缓存）；`/compact` 后两者一起解禁。
5. **降级**：`args` 被截断/非 JSON、嵌套调用 `status` 为 error/cancelled（后者照算，前者跳过）、结果无文本内容、`isError` 的 codemode 结果 ⇒ 不注入且不改坏原结果。
6. **原结果保真**：注入后原 `content` 逐字保留、`structuredContent` 原样回传（v1.0 的 B1 契约不回归）。
7. **测试**：宿主事件路径测试（真实 `ExtensionRunner.emitToolResult` + 真实 codemode 形状的 `details`）覆盖上面 1-6；纯逻辑（args 解析容错、并集排序）单测全覆盖。
8. `npm test` + `npm run typecheck` 全绿；全仓 `test:all` 22/22；四面文档同步完成（卡片 + 规格 + 根 README + 插件 README）。
9. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理直到某轮无新意见。
10. **真机验收**：开着 codemode 的真实会话里让模型用脚本读一个深层文件（或脚本内 `text()` 局部约定），确认它答得出只在嵌套 AGENTS.md 里的标记，且 transcript 的 codemode 结果里出现 `Loaded` 标记。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：对话内确认（agent 先出 4 项调研 + 推荐值，用户回复「A 确认」）
- **逐条决策（全部按 agent 推荐值落定）**：
  1. **档位 = A**：在 codemode **自身的顶层 `tool_result`** 上读 `details.calls`（`isCodemodeTool` 判真伪 → 取 `name` + `args` 紧凑 JSON → 复用现有触碰语义 → 目录链并集 → 注入一次）；B（扫脚本源码）/ C（放开嵌套注入）/ D（维持现状）否决，理由见 ADR-0012。
  2. **`status: error` / `cancelled` 的嵌套调用 = 照算**（文件可能已经被读写；注入与脚本成败无关）。
  3. **去重与预算 = 复用同一份会话缓存与同一套上限**（单文件 32 KiB / 单次 128 KiB），不为 codemode 另开语义。
  4. **覆盖范围 = 只认五个触碰工具**（`read`/`write`/`edit`/`ls` + bash 白名单单文件读）；MCP 等命名空间下的同名工具不特殊处理（不匹配就不触发）。
- **已知风险（显式接受）**：① 一次脚本可能触碰很多目录 ⇒ 一次带进多份上下文（128 KiB 上限兜住，仍可能吃掉可观 token）；② `args` 是截断预览，极大参数下会漏判（降级为不注入，不误注入）；③ 脚本内路径若是运行时算出来的（拼接/循环），`args` 里看到的仍是实际入参 ⇒ 这条无损失。
- **开工放行边界（用户明确要求）**：**先对齐、暂不实现**。因此本轮只跑 `align`（→ `aligned`），**不二次 `claim`**、不进 `processing`、不开 worktree；实现等用户另行放行。
