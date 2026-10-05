# jev-safe-gate — tool_call 前置的 Jev 风险判断门

> last verified @ 20acc24

一句话：`pi.on("tool_call")` 上只拦 `bash`，先过便宜正则候选筛，候选才交给内置 `typesafe/jev-latest` 分类器判断；可疑（或拿不准）弹**一次**宿主确认，用户拒绝则阻止这次调用。

## 为什么这么做

模型（或被注入的模型）可以静默执行不可逆操作，人只在事后发现。宿主 pi 1.0 **没有**内置的危险命令审批（`isToolCallEventType` 只是按名字收窄事件），所以这道门只能由扩展提供。可行性来自两处公开面：`ModelRegistry.classify()`（pi-coding-agent dist/core/model-registry.d.ts，codemode 的 `CodemodeModelRuntime` 同样以 `Pick<ModelRegistry, …, "classify">` 引用它）+ 内置分类器目录 `typesafe/jev-latest`（`pi-ai/dist/providers/data/typesafe.json`，`type: "classifier"`）——**不需要新 provider、不需要 API key 录入**（typesafe 扩展已退休）。

## 不变量（改代码前必须知道）

- **只加摩擦**：判定「安全」只意味着「本扩展不弹框」，**不授予任何权限**——handler 返回 `undefined`，宿主 `emitToolCall` 继续把事件交给其它 `tool_call` 处理器（既有审批门照常 block）。反过来，本扩展也**绝不修改命令文本**（`event.input` 只读，同意 = 原样执行）。这是本扩展的存在理由，写在 `index.ts` 头部。
- **判定读不懂 ≠ 安全**：`stopReason: "stop"` 但答案不是 choice（或该问题无答案）⇒ 弹确认（交给人）。只有「分类器不可用」这一类才 fail-open。
- **fail-open 必须可观测**（用户口径，不可协商）：`classify` 抛错 / 超时 / `getModelOfType` 返回 undefined / 无 UI / 弹框崩溃 / handler 自身异常，六种情形一律放行，但每次经 `observability.ts` 记一次：footer 段 `⚠ jev 放行N（原因）`（带序键 `60:jev-safe-gate`，只在有放行时出现）+ 本会话首次 notify + 一行日志（**无 UI 时日志是唯一通道**，走 `deps.log`，默认 stderr）。
- **顺序即成本**（`judgeToolCall`）：非 bash → solo → 无 UI → 候选筛 → classify → 弹框。**无 UI 时连 classify 都不调**（问不了人就没有判断的意义）。
- **超时计时器不能 unref**：它是「到点放行」的唯一推动力；unref 后进程若没有别的待办（headless 收尾）会先退出，`await classify` 永不返回，工具调用直接挂住。
- **classify 契约是「不抛错」**：失败走 `stopReason: "error" | "aborted"` + `errorMessage`；实现按 `stopReason` 分流（`classifyCommand`），另加 try/catch 兜住违约实现。超时只能用 `signal`（`ModelsClassifierOptions` 没有 timeoutMs）。
- **solo 豁免是「完全不介入」**：solo 开启时不筛候选、不调 classify、不弹框（solo 的语义就是本会话不要摩擦）；状态只经契约读（同构 `solo-gate.ts`，`pid === process.pid`，其余 fail-closed 为未开启 ⇒ 门照常工作）。与其它采纳方**方向相反**：别人是「solo ⇒ 自动批准」，这里是「solo ⇒ 本门不存在」。
- **候选筛宁宽勿窄**：多命中 = 多花一次分类调用（延迟 + 钱），漏命中 = 少一道门。模式表在 `candidates.ts` 顶部，判据是「不可逆」而非「看起来凶」；正则**不加 `g` flag**（`lastIndex` 状态会漏判）。
- **注解惰性读**：`pi.getAllTools()` 只在候选路径被调一次（非候选零宿主调用）；`loop` 工具面的 `annotations` 就是喂给这类门的。
- **命令原文只进两处**：分类器上下文（截断 2000 字）与确认框正文（用户必须看见自己批准的是什么）。阻止理由（模型可见）与日志行是**静态模板**，不回显命令内容。

## 文件地图

- `index.ts` — 接线：`tool_call` / `session_start` / `session_shutdown` + 端口装配（`JevSafeGateDeps`）
- `candidates.ts` — 候选模式表 + `findCandidates`
- `gate.ts` — `judgeToolCall` / `readJudgement` / `buildClassifierContext` / `classifyCommand` / 原因码与阈值
- `observability.ts` — 放行计数、状态条文本、一次性 notify、日志行
- `solo-gate.ts` / `status-band.ts` — 两份契约同构拷贝（solo 状态、footer 段前缀）

## 坑

- **确认框在 agent 流式过程中弹**：`ctx.ui.confirm` 经宿主 `withUIPrompt` 包一层 `ui_prompt_start/end`（human-notify 会因此发一条「等待确认」Toast）——预期行为。
- **`emitToolCall` 不吞 handler 异常**：`tool_call` 处理器抛错会打断整个工具批次，所以 handler 全程 try/catch（异常也按 fail-open 记一次 `internal-error`）。
- **测试里的超时用例必须让桩实现遵守 abort**：真实 `classify` 在 signal abort 后 resolve `{stopReason:"aborted"}`；桩若忽略 signal，`await` 会一直挂着（真机走的是真实实现，无此问题）。
- **`discoverAndLoadExtensions` 会扫 `cwd/.pi/extensions` 与 `agentDir/extensions`**：测试用它加载真实 `index.ts` 时必须传**临时** agentDir，否则会读到用户真实配置（红线 8）。
- **真实文件加载 = 默认 deps**：从磁盘加载的实例拿不到测试注入的 deps（`log` / `classifyTimeoutMs`），所以 headless 用例捕获的是 `console.error`（真实默认通道），超时用例放在 `classifyCommand` 单测（真实文件路径下默认 4s，不适合当测试时长）。

## 测试与验证

- `cd src/extensions/jev-safe-gate && npm install && npm test && npm run typecheck`（50 个：候选筛 5 / 判定层 26 / 可观测 6 / solo-gate 2 / 宿主事件路径 11）
- 宿主事件路径测试走**真实发现+加载（jiti 走 index.ts）+ 真实 `ExtensionRunner.emitToolCall`**，只 fake `modelRegistry`（网络边界）与 `sessionManager`/actions（本扩展不读）；「只加摩擦」用同 runner 里的第二个独立扩展（既有审批门）对照。
- 红→绿证据（临时变异）：去掉候选筛 ⇒「非候选零 classify」红；去掉 solo 豁免 ⇒ 3 条（含宿主路径 solo）红；还原即绿。
- 真机验收步骤见 `docs/jev-safe-gate-checklist.md`（候选命令两条路径 / 非候选无感 / 分类器不可用可观测放行 / solo 豁免）。
