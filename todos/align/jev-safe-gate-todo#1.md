# jev-safe-gate-todo#1 jev-safe-gate 新扩展

## 意图

需求原文：**tool_call 前置的 Jev 风险判断，只能加摩擦（可疑 → 弹确认），绝不因判定安全而放行。**

要解决的问题：模型（或被注入的模型）可以静默执行不可逆操作，人只在事后发现。本扩展在调用**发生前**插一道便宜的、结构化的判断——命中候选就问人一句；判断结果**不授予任何权限**，它只能增加摩擦，不能减少任何既有门。

**可行性已核实（pi 1.0.1 typings，本机实查）**

- `ModelRegistry.classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?): Promise<ClassifierResult>` 是公开 API（`@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:47`，且被 codemode 的 `CodemodeModelRuntime` 以 `Pick<ModelRegistry, …, "classify", …>` 引用）。
- `ClassifierContext = { state: JsonObject; questions: Record<string, ClassifierQuestion> }`；答案是 `choice` / `score` / `bool`，各带 `probabilities` 与 `confidence`（`@earendil-works/pi-ai/dist/types.d.ts:467` 起）。
- 分类器模型走**内置** `typesafe/jev-latest`：typesafe 扩展已退休（`typesafe-todo#2`），改成内置目录 + `classify()` 通道，不需要新 provider 或 API key 录入。

**生态位**：仓库里已有伏笔——`src/extensions/loop/tools.ts:14` 注释写明工具面 `annotations` 是「供权限门（jev-safe-gate）读」的。本扩展就是那道门。

## 范围

**做什么**

1. 新扩展目录 `src/extensions/jev-safe-gate/`（与其余扩展同形态：`index.ts` 入口 + 就地测试 + README + 独立 package.json + tsconfig）。
2. 挂 `pi.on("tool_call")`，**只拦 `bash`**（用户选项）：先过便宜的正则/字面量候选筛（`rm -rf`、`git reset --hard`、force push、`dd`/格式化类、管道到 shell 等），**只有候选才进 Jev 判断**——非候选零额外延迟、零分类调用。
3. 判断：构造 `ClassifierContext`（`state` = 工具名 + 命令原文 + cwd + 来源工具注解等必要上下文；`questions` = 一条 bool/choice 问题，如「这条命令是否可能造成不可逆破坏？」）→ `ctx.modelRegistry.classify()` → 可疑（或置信度低于阈值）时用宿主对话框弹**一次**确认。
4. **fail-open（用户选项）**：`classify()` 抛错 / 超时 / 无 UI（headless）→ 放行、不阻塞。**但必须可观测**（本对齐新增的硬要求）：放行次数与最近一次原因要出现在状态条（footprint 遵循 `docs/cross/status-bar.md`：秒对齐、写入前指纹、排序带）或至少一次性 `notify`——不允许「门静默失效」。
5. 用户拒绝 → 按宿主的 tool_call 拦截语义阻止这次调用；用户同意 → 原命令**原样**执行（不修改命令文本、不追加参数）。
6. **solo 豁免（用户选项）**：solo 免审批模式开启时，本门**完全不介入**——不筛候选、不调 `classify()`、不弹框（solo 的语义就是「本会话不要摩擦」）。solo 状态经既有跳扩展契约 `docs/cross/solo-approval-gate.md` 读取，不新造状态读取逻辑；该契约的 fail-closed 口径原样跟随。
7. 随动面：`docs/extensions/jev-safe-gate.md` 卡、`docs/INDEX.md` 登记、根 `package.json` `pi.extensions`（14 → 15）、`tools/install-smoke.mjs` 期望表、`tools/test-all.mjs` 套件表、`docs/tools/test-all.md` 套件数、根 README（插件表 + 实测测试数）、AGENTS.md 计数与命令清单、真机清单。

**不做什么（第一版）**

- **不拦 bash 以外的工具**（`write` / `edit` 覆盖文件、其它工具的调用一概不看）——用户明确选了最窄档。
- 不做持久白名单 / 「记住本次选择」/ 按命令前缀放行（YAGNI；真需要另立条目）。
- 不改宿主既有危险操作审批、不改 `solo-mode`、不做 Jev 之外的第二套风险模型。
- 不因「Jev 判定安全」而跳过或弱化任何既有门（这条是本扩展的存在理由，写进代码注释与卡）。

## 验收标准

1. **零成本基线**：非候选命令（如 `ls`、`npm test`）**零次** `classify()` 调用——用可观察桩/计数断言；这是「不拖慢日常」的硬指标。
2. **候选路径**：候选命令触发一次 `classify()`；判定可疑 → 弹出确认；用户拒绝 → 调用被阻止（走真实宿主事件路径的测试，不是纸面替身）。
3. **fail-open 三路径**：分类器抛错 / 超时 / 无 UI 时都放行，且**可观测**（计数或提示真实出现，专门断言）。
4. **solo 豁免**（用户选项）：solo 开启时对候选命令**零 `classify()` 调用、不弹框**；关闭 solo 后同一条候选命令恢复拦截（走真实宿主事件路径测试）。
5. **只加摩擦**：Jev 判定「安全」时不跳过宿主的既有审批、不修改命令文本（用一条真实审批场景对照，证明既有门仍生效）。
6. **扩展交付面**：新卡 + INDEX + `pi.extensions` 15 项 + install-smoke 期望表 + test-all 套件表 + 根 README（实测测试数）+ AGENTS.md 计数/命令清单；`npm run test:all` 全绿、新扩展 typecheck 0 错误、`todo.mjs lint` exit 0。
7. **真机清单**（pi 1.0.1，交用户执行）：一条候选危险命令走完「弹确认 → 拒绝 → 被拦」与「弹确认 → 同意 → 执行」两条路径；另验非候选命令无感、分类器不可用时可观测地放行。

## 人工确认

用户 2026-10-04 本会话确认（三问三答）：

- **第一版拦截面 → 只拦 bash 危险命令**。用户否掉「bash + 文件写操作」与「全部 tool_call」两档（后者的延迟与成本不可接受）。
- **Jev 判定不可用 / 超时 → fail-open 放行**。用户在选项说明里已看到该选择的代价（「等于分类器一挂就静默失效」）仍选择放行；本次对齐据此补上**不可协商的补偿要求**：放行必须可观测（计数/提示），否则本条不予验收。
- **solo 免审批模式 → 豁免**（第三答）：solo 开启时本门完全不介入（不筛候选、不调 classify、不弹框）；读 solo 状态只走既有跳扩展契约 `docs/cross/solo-approval-gate.md`，不自己解析状态文件。用户据此否掉了另两档：「不豁免」（solo 下 rm -rf 依旧弹窗）与「默认豁免 + 可配置」（多一个旋钮）。
