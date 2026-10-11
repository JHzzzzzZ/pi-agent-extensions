# ADR-0012：codemode 下的目录作用域上下文走「顶层结果 + 嵌套调用明细」提取

- 状态：已实现（dir-context v1.1；确认记录见 `todos/align/dir-context-todo#2.md` 的 `## 人工确认`）
- 日期：2026-10-10（UTC）
- 相关：`docs/adr/0011-dir-context-scoped-injection.md`、`docs/extensions/dir-context.md`、`docs/specs/dir-context.md`、工单 `dir-context-todo#2`

## 背景

`dir-context` v1.0.0 在模型触碰目录时把该目录的 `AGENTS.md` 等注入工具结果。它对**嵌套工具调用**（`event.parentToolCallId` 非空，即 codemode 脚本通过 `tools.read(...)` 发起的调用）一律跳过——宿主明文规定这类调用的结果**只回到调用方工具、不进 transcript**（`docs/extensions.md`、`types.d.ts:273-280`），注入进去模型看不到，还会污染脚本拿到的返回值。

代价是：模型一旦改用 codemode 干活，v1.0.0 刚补上的那一格又漏了回去（脚本里读 `src/components/Button.tsx` 拿不到 `src/components/AGENTS.md`）。

关键事实：codemode 的**工具结果本身是顶层调用**，而且它带着每个嵌套调用的明细——`CodemodeToolDetails.calls: CodemodeNestedCall[]`（`{ id, name, args, status }`，`args` 是紧凑 JSON 的截断预览，`dist/extensions/codemode/tool.d.ts:68-83`）。也就是说「脚本碰了哪些路径」这件事，宿主已经替我们记好了，不需要去猜。

## 决策

**在 codemode 自身的顶层 `tool_result` 上，从 `details.calls` 提取触碰并注入一次。**

1. 判真伪：用宿主导出的 `isCodemodeTool(tool)`，避免误伤同名工具。
2. 提取：对每个 `call` 取 `name` + `args`（紧凑 JSON，按 `JSON.parse` 容错解析），只认与顶层同一套触碰语义——`read` / `write` / `edit` / `ls` 的 `path`、bash 的 `cat`/`head`/`tail` 单文件读白名单。
3. 合并：多个触碰取目录链**并集**（同目录只取一次），仍由外向内排序，作为该 codemode 结果的**一个追加 text block**。
4. 去重与预算：**沿用顶层同一份会话缓存与同一套上限**（单文件 32 KiB / 单次 128 KiB），不为 codemode 另立语义。
5. 成败无关：`status` 为 `error` / `cancelled` 的嵌套调用照算（文件可能已被读写）；`args` 截断或解析失败、非触碰工具、脚本内再起脚本（宿主不允许）→ 该条跳过。
6. 保真：与顶层一致——原 `content` 逐字保留、`structuredContent` 原样回传。

## 备选与否决理由

- **扫脚本源码里的路径字符串**（正则找 `tools.read({ path: "…" })`）：`details.calls` 已经给出精确的 `name + args`，扫源码只会更脆（拼接、变量、模板串、注释里的假路径）。
- **放开嵌套注入**（让 `tools.read()` 的返回值带上下文）：改变的是**脚本**看到的数据——`JSON.parse`、行数计数、字符串拼接都会被污染；而模型要等脚本主动 `text()` 才可能看到。风险明确、收益不确定。
- **维持现状**（codemode 里不注入，靠模型自己读 AGENTS.md）：缺口明确、可复现，且 codemode 正是「批量读写文件」的场景，恰恰最需要局部约定。
- **改成往 codemode 结果里塞一份「脚本触碰到的路径清单」**（不发内容、只提示模型去读）：多一次模型往返，且上下文进入时机晚于脚本决策——不如直接把内容给上。

## 落地偏差（实现时发现，已按红线 8 就地解决）

1. **`isCodemodeTool` 不可用**：决策第 1 条要求用它判真伪，但 pi 1.1.0 的包入口（`exports["."]` → `dist/index.d.ts`）只导出 `CodemodeToolDetails` / `CodemodeStoreEntryData` 类型与 `createCodemodeExtension`，**`isCodemodeTool` 只存在于内部模块**（`dist/extensions/codemode/tool.d.ts`），而包的 `exports` 没有子路径入口。不带兜底就只剩两条违规路：import 宿主内部路径，或改宿主（红线 8 禁止）。落地方案：**「工具名 `codemode` + `details.calls` 是数组」双重结构守卫**（`codemode.ts` 的 `detectCodemodeTouches`）——内置 codemode 的工具名是固定字面量（`CODEMODE_TOOL_NAME`），同名第三方工具不带这个 `details` 结构就不会被误伤；代价是工具被改名/包装时补偿路径静默失效（顶层行为不受影响）。
2. **`args` 截断比预期更“贵”**：`previewArgs` 上限 200 字符。实测 `read` 的 `args` 是 `{"path":"…","offset":null,"limit":null}`（可解析），而 `write`（带 `content`）与 `edit`（带 `edits`）极易超限 ⇒ 解析失败、该条跳过。即：**codemode 路径对「脚本里新建/编辑深层文件」的覆盖弱于顶层**。这是「少注入不误注入」既定口径的必然结果，已在卡片与规格的「已知边界」中写明；拿完整入参需要宿主开口子，同期不做。

## 后果

- codemode 路径重新拿到与顶层一致的局部上下文；两条路径共用同一份去重/预算/顺序实现，不会语义漂移。
- 新增成本面：一次脚本可能触碰很多目录，一次结果里就可能带进多份上下文（受 128 KiB 上限约束）。若实测在长会话里偏贵，后续可加「每次 codemode 结果的目录数上限」——本轮不做（YAGNI，先看真实用量）。
- 依赖宿主 `details.calls` 的形状：它属于**公开的类型面**（`CodemodeToolDetails`），但仍是宿主实现细节的投影；本 ADR 记录形状快照，出现漂移时按卡片「坑」一节的降级策略处理（解析不出就跳过，不误注入）。
- 真机验收（2026-10-11，临时 agent 目录 + 真实 `pi --mode json -p --tools +codemode`，模型 `opencode-go/deepseek-v4-flash`）：提示要求用脚本 `tools.read` 读 `src/components/Button.tsx`——codemode 工具结果尾部出现 `Loaded src/AGENTS.md` 与 `Loaded src/components/AGENTS.md`，且模型答出只写在嵌套 `AGENTS.md` 里的暗号；脚本输出与 `details` 均未被改坏。

## v1.2 补充：主来源换成嵌套事件的完整入参（工单 `dir-context-todo#3`）

v1.1 落地后暴露的问题：`details.calls[].args` 是宿主的 **200 字符截断预览**（`previewArgs`），带大载荷的 `tools.write`（含文件内容）与 `tools.edit` 必然截断 ⇒ `JSON.parse` 失败 ⇒ 那条跳过 ⇒ 那一轮不注入。真机 A/B 实测：脚本里 `tools.write` 写 300 字符内容时，v1.1 零注入、模型答「看不到任何相关内容」。

**更好的数据来源**（真机探针实测，2026-10-11）：codemode 脚本里的嵌套调用**也会触发扩展的 `tool_result` 事件**，且该事件的 `input` 是**完整入参**（宿主 `_afterToolCall({…, args}, parentToolCallId)`，嵌套路与直接调用同管线）。探针输出：嵌套 `write` 事件 `inputKeys=["path","content"]`、`path` 完整、`content` 长 300，而同一次调用的 `details.calls[].args` 长度恰为 200 且以 `...` 结尾。

**补充决策**

1. **主来源 = 嵌套事件的完整 `input`**：按发起它的顶层调用 id（嵌套事件的 `parentToolCallId` == 顶层事件的 `toolCallId`）缓冲，顶层 codemode 结果到达时取走并注入。不改宿主、不猜 JSON（「前缀抽取截断 JSON」这条备选仍被否决：最坏情况会按误读的 path 注入错误目录）。
2. **`details.calls` 降级为兜底**，与缓冲**取并集去重**：宿主某个版本不发嵌套事件时不会退化成零注入。
3. **缓冲不看嵌套调用的 `isError`**：文件可能已被读写，注入与这次嵌套调用的成败无关（与 v1.1 对 `status: error/cancelled` 的决策同向）。顶层 codemode 结果 `isError` 仍不注入，但缓冲照样消费（取走即删，不跨结果残留）。
4. **缓冲有界**：单组 64 条、同时最多 8 组（超出淘汰最旧）、顶层结果到达即删该组、`session_start`/`session_compact`/`session_shutdown` 清空。
5. **嵌套调用自身仍零注入**（v1.0 语义不变）——缓冲只是「读它的入参」，不改它的结果。

无冲突面：顶层的 5 个触发工具、去重键、预算、排序、状态条契约全部沿用；`dedupeTouches` 是并集与 v1.1 明细共用的那一个去重函数。
