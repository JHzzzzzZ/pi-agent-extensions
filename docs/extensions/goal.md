# goal — 会话目标自动循环推进

> last verified @ 9db7983

## 职责与边界

`/goal <条件>` 设定完成条件，agent 跨回合自动推进：每个 agent_settled 后由独立 LLM 评估器（当前会话模型的一次 maxTokens=512 小调用）判定 {met, reason}，未达成则以评估原因为指导经 `pi.sendMessage({triggerTurn, deliverAs:"followUp"})` 开下一回合，达成后清目标并写结果条目。footer 状态行（键 `10:goal`，格式 `◎ <目标≤20列> · <N>轮 · <时长>`，暂停为 `⏸ <目标≤20列> · 已暂停 · <时长>`；目标按显示列截断、CJK 双宽）在 active/paused 期间按对齐秒节拍刷新「已运行」时长（`aligned-ticker.ts`，契约见 `docs/cross/status-bar.md`）。段前缀由本地 `status-band.ts` 统一决定（最前段无前缀、行首定格；非最前段加 `│ `）；idle 清状态。**不做**：轮次上限（靠目标文本自限，如 "or stop after 20 turns"）、工具执行监控（评估器只看 assistant 文本输出）、独立持久化（只写会话条目）。

## 文件地图

- `index.ts` — 单文件全量：常量/纯函数/真实评估器/扩展工厂。头部注释是权威用法说明。
- 常量区（index.ts 顶部）— 全部上限值：`MAX_GOAL_LENGTH=4000`、`MAX_EVIDENCE_CHARS=12000`、`MAX_REASON_CHARS=500`、`MAX_EVALUATOR_TOKENS=512`、`MAX_EVALUATOR_FAILURES=3`。**改上限只动这里。**
- `index.ts` 纯函数段 — parseGoalArgs / buildEvaluatorPrompt / parseVerdict / extractJsonObject / extractAssistantText / buildStatusLine，可独立单测。
- `aligned-ticker.ts` / `status-band.ts` — 对齐秒边界节拍器与 footer 段前缀登记（均为每插件一份拷贝）；仅 active/paused 期间节拍存活，idle/无 UI/shutdown 停止。
- `createModelEvaluator` — 真实评估器：`ctx.modelRegistry` 取 provider + auth → pi-ai `provider.stream` 单条消息调用。
- `GoalDeps` — 注入口：`evaluate`（评估器）+ `nowMs`（时钟），测试从这里替换边界。

## 核心数据流

1. `/goal <条件>` → `ctx.waitForIdle()` → 状态置 active + `persistState` → `pi.sendUserMessage(条件本身)` 立即开第一回合；裸 `/goal` 空参=状态。
2. `agent_end` → `extractAssistantText` 截最近回合 assistant 文本（忽略 thinking/toolResult）存 `evidenceTail`（超限取尾部）。
3. `agent_settled` → 评估器小调用（goal + evidence + lastReason）→ 严格判定：部分进展/未验证声明不算 met。
4. 未达成 → `goal-continue` 自定义消息（含评估器反馈）followUp 续回合；达成 → 写 `goal-result-v1` 条目 + 清状态。
5. 状态以 `goal-state-v1` 条目持久化（末条生效，null = 已清除）；`session_start` 水合。
6. 状态行：每次 `updateStatus` 记录 ctx 并保证节拍器存活；节拍回调每秒重算时长，经 `writeBand` 写入（逻辑文本 + 写 UI 回调，前缀含入指纹）——文本相同则跳过 `setStatus`；转 idle 或 shutdown 时停节拍并清登记。

## 不变量

- 无轮次硬上限是设计决策（对齐 Claude Code /goal）——不要"顺手"加 cap，要加先改头部注释的契约说明。
- `evaluating` 布尔防 agent_settled 重入；评估期间若 `state !== snapshot`（目标被替换/清除）本轮作废——评估结果绝不写回旧目标。
- 评估器瞬时失败按未达成继续（不杀循环）；连续 `MAX_EVALUATOR_FAILURES=3` 次才 paused。`evaluatorFailures` 仅在成功判定后清零。
- 检测到手动中断（`ctx.signal.aborted`，turn_end/agent_end 记 `userInterrupted`）→ 转 paused 而非续跑，只能 `/goal:resume`。
- 水合恢复目标但轮数与计时归零（对齐 `/goal:resume` 语义）；已清除（null）不恢复。
- 命令面（v1.3.0）：裸 `/goal` 空参=状态、其余=目标文本（`/goal status` 也是目标文本，不是子命令）；`/goal:status` 状态副本；`/goal:clear|:stop|:off|:reset|:none|:cancel` 共享同一清除动作；`/goal:resume` 恢复。旧空格管理词经裸入口只提示改名、绝不执行。
- 所有 notify/setStatus/appendEntry 调用均 try/catch——持久化或 UI 失败绝不破坏会话、绝不中断循环链。
- 状态条目幂等可重放：恢复只信最后一条 `goal-state-v1`，结果条目 `goal-result-v1` 仅记录、不参与水合。
- 状态行键 `10:goal` 带排序带前缀（宿主按 key localeCompare 拼接 footer，不可改回 `goal`）；段前缀由 `status-band.ts` 的进程共享登记表统一决定（最前段无前缀，其余段 `│ `，低带出现/消失会重渲染本段），写入边界不再自己拼前缀；目标文本按**显示列**截到 20 列（`truncateText`/`visualLen`，CJK 双宽）；节拍器随 idle/无 UI/shutdown 停止，不留残留定时器。

## 已知坑

- index.ts `onSettled` 里 snapshot 已被收窄为 "active"，不能原地改 `snapshot.phase`（TS 拒绝），必须整体替换 state 对象——改状态机时保持这个写法，别"简化"成原地改。
- 评估器看不见工具输出：evidence 只含 assistant 文本块。要求"测试通过"类目标时，续跑消息明确指示 agent 在回复中呈现可验证证据（buildContinueMessage 已内置此要求）——删掉这句指示会导致评估器永远判 not met。
- `parseVerdict` 只截第一个括号平衡的 JSON 对象（容忍 code fence/前后废话）；模型若输出多个 JSON 对象且第一个不是判定，会 `bad-verdict`（message 仅前 200 字符，排查时看这个）。
- 中断后 elapsed/turns 不跨会话保留：水合把 startedAtMs 重置为 now、turns=0，/goal 显示的时长与轮数在 reload/resume 后不连续，属预期而非 bug。
- 目录无 package.json，测试用 `node --experimental-strip-types --test` 直跑；缩进 2 空格（同多数扩展，与 pwr 的 tab 不同）。
- 评估器直调 `provider.stream(...)`，绕过宿主 streamFn 的请求头合并（`mergeProviderAttributionHeaders`）：opencode 系模型（provider `opencode`/`opencode-go` 或 baseUrl host `opencode.ai`）必须自注入 `x-opencode-session`/`x-opencode-client` 会话头（Console Go 缺失返回 400 `MissingSessionID`，评估器连败 3 次后 goal 被暂停）。`isOpencodeModel`/`buildOpencodeSessionHeaders` 已复刻宿主判定；仅注入会话头，不注入归因遥测头（HTTP-Referer 等）。若宿主 provider-attribution 判定逻辑变更，需同步这两处。
- 仅一个 commit（c5e167e）无历史坑可挖；后续踩坑在此追加。

## 改动清单

- 必跑：`node --experimental-strip-types --test goal/index.test.ts goal/aligned-ticker.test.ts`（63 个，goal/ 目录下执行，无 package.json 无 typecheck 脚本）。
- 必看测试：`index.test.ts` — `makeFakePi` 手写 fake pi 宿主（记录 sendMessage/sendUserMessage/entries/statuses/statusKeys）+ fake 评估器 + 注入 `nowMs`，全离线；节拍用全局 `setTimeout` mock + `fireTick()`；评估器小调用边界只 fake 不真连。
- fake 模式：沿 `GoalDeps` 注入口（评估器 + 时钟），对应 docs/cross/deps-ports.md 的 goal 行；新增进程/IO 边界才立新口，别加策略层。
- 改上限值/消息文案/条目键 ⇒ 同步 README 的 goal 段与头部注释；改条目键 ⇒ 同步 docs/cross/messages-entries.md。
