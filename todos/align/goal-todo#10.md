# goal-todo#10 评估器改用 ctx.modelRegistry.streamSimple()

## 意图

goal 的评估器**绕过宿主路由层直调 provider**（`index.ts:328-349`）：

```ts
provider = ctx.modelRegistry.getProvider(model.provider);
auth     = await ctx.modelRegistry.getApiKeyAndHeaders(model);
provider.stream(model, { messages: [message] }, { ... });   // 直调
```

原动机写在代码注释里：**绕过宿主 `streamFn` 的请求头合并**——opencode 系（Console Go）强制要求某些请求头。

这个绕过带来一个**具体的失效路径**（pi 1.0 新暴露的）：**虚拟模型**的 `api` 是 `pi-virtual`，pi 文档明写「Requests for it fail unless routed first」。直调跳过了路由步骤，所以：

> 用户一旦把会话模型切成虚拟模型，评估器请求必失败 → 评估器连续失败到 `MAX_EVALUATOR_FAILURES = 3` → **目标循环静默卡住**（footer 还显示目标 active）。

pi 0.86 起提供了 `ctx.modelRegistry.streamSimple()`（「for extension model calls through configured providers with resolved authentication」），它走宿主的路由与鉴权解析。本条把评估器改到这条路径。

## 范围

**做什么**

1. 评估器改用 `ctx.modelRegistry.streamSimple()`（或 `stream()`，按实测选择 provider-neutral 选项更合适的一个），替换 `getProvider` + `getApiKeyAndHeaders` + `provider.stream` 三件套。
2. **必须验证 opencode 系请求头**：这是原直调的动机。若 `streamSimple` 路径下 opencode-go 模型仍能正常请求 → 直接替换；若不能 → 必须写明**保留直调的判据**，并单独处理虚拟模型场景（例如：`model.api === "pi-virtual"` 时走 `streamSimple`，否则保留直调）。
3. **用 `model.api === "pi-virtual"` 识别虚拟模型**（`isVirtualModel` 与 `VIRTUAL_MODEL_API` **未从包根导出**，index.d.ts 只导出 `ModelRoute`/`ModelRouteReason`/`ModelRouteRequest`/`VirtualModelDefinition`/`VirtualModelStateData`/`VIRTUAL_MODEL_STATE_ENTRY`）。
4. **保留现有评估器作回退路径**：切换失败（streamSimple 抛错/超时）时按既有失败计数语义处理，不新增无界等待。
5. 补测试：至少一个用例锁定「虚拟模型会话下评估器仍产出判定」，可用 fake registry 注入。

**不做什么**

- **不做 `goal-todo#8`**（评估器换 Jev）：那是另一条，本条只动调用路径，不动判定逻辑与提示词
- 不改 `MAX_EVALUATOR_TOKENS` / `MAX_EVIDENCE_CHARS` / 失败计数等上限（常量区不动）
- 不改 goal 的 `agent_settled` → `sendMessage(followUp)` 循环结构
- 不动 footer 状态行与节拍器

## 验收标准

1. `node --experimental-strip-types --test src/extensions/goal/index.test.ts src/extensions/goal/aligned-ticker.test.ts` 全绿（现有 63 个 + 本条新增），`typecheck` 零错误（如该扩展有 tsconfig）。
2. **真机验收（关键）**：`/goal` 设定一个可达成的目标，在**虚拟模型被选中**的会话下跑通一轮达成判定（评估器产出 `{met, reason}`，目标正常清除）。这是本条的核心价值，必须真机证据，不能只靠单测。
3. **opencode-go 回归验证**：用户默认 provider 是 `opencode-go`（`deepseek-v4.1-flash`），评估器在该 provider 下仍正常工作（这是原直调动机，必须证明没退化）。
4. 失败路径：评估器连续失败到上限时的既有行为不变（不新增提示或错误码）。
5. 文档同步：`docs/extensions/goal.md` 卡 + 文件头注释（说明为什么最终走了哪条路径）+ 根 README 测试数。

## 人工确认

用户 2026-10-04 本会话确认：

- **承接关系**：本条是 `goal-todo#9`（评估器手写 provider 调用路径重估）的**作废重登记**——#9 已 `complete`，补入虚拟模型失效场景后在新条目下重走对齐门（先例：`skills#12`）。CLI 无 `edit`，`open` 条目 `reopen` 是 no-op，这是唯一受支持的通道。
- **三项范围**：① 修虚拟模型失效；② 同时评估能否保住 opencode 系强制请求头；③ 保留现有评估器作回退路径。用户对列表「没问题」。
- **Q5**：并行开 worktree + subagent 实现，主会话仅追踪。

### 真机验收证据（pi 1.0.1，2026-10-04；临时配置目录，未动用户配置）

**复现做法**（三组对照与请求头对照共用同一套装置）：

1. 临时配置目录 `<conf>/`：把 `~/.pi/agent/auth.json` 拷进去（跑完删除）。`PI_CODING_AGENT_DIR` 必须传**绝对路径**——相对路径下凭据解析不到，症状是模型目录正常但请求报 `Provider is not configured: opencode-go`。
2. 虚拟模型探针 = 一个最小扩展（`session_start` 注册 route，无 UI）：
   ```ts
   export default function virtualProbe(pi: any): void {
     pi.on("session_start", (_e: any, ctx: any) => {
       ctx.modelRegistry.registerVirtualModel({
         provider: "opencode-go", id: "router-v1", name: "Probe Router", thinkingLevels: ["off"],
         route: () => ({ model: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, thinkingLevel: "off" }),
       });
     });
   }
   ```
3. 驱动 = RPC 模式、脚本自带超时兜底：
   `pi --mode rpc --session-dir <临时 sessions> --provider opencode-go --model deepseek-v4.1-flash -e <goal 扩展目录> -e <virtual.ts>`；
   启动后 `set_model`（虚拟会话传 `router-v1`）→ `prompt "/goal 在回复里只说一句话:DONE"` → 出现 `entry_appended:goal-result-v1` 即判达成退出。
4. dev-laptop 基线对照：把扩展目录换成 dev-laptop 同版 goal 扩展（`base-check/` 检出），其余不变重跑。

**三组对照（实测输出）**

| 场景 | 代码 | 结果 |
| --- | --- | --- |
| 虚拟模型会话（`opencode-go/router-v1` 路由到 `deepseek-v4.1-flash`） | 本分支 | ✅ 第 1 轮达成：`{"goal":"在回复里只说一句话:DONE","turns":1,"elapsedMs":4294,"reason":"代理输出仅为“DONE”，符合目标要求。"}`，无暂停通知 |
| 物理 `opencode-go/deepseek-v4.1-flash` | 本分支 | ✅ 第 1 轮达成：`{"turns":1,"elapsedMs":4309,"reason":"回复内容为“DONE”，恰好是一句话，完全符合目标要求。"}` |
| 虚拟模型会话 | dev-laptop 基线 | ❌ 无 `goal-result-v1`；通知 `goal 已暂停:评估器连续 3 次失败:Virtual model opencode-go/router-v1 must be routed before streaming。使用 /goal:resume 重试。` |

**请求头对照（同装置直呼 `ModelRegistry.streamSimple`，2026-10-04 复跑）**

| 路 | 请求 | 输出 |
| --- | --- | --- |
| A | `streamSimple` + `sessionId` | `{ok:true,text:"P"}` |
| B | `streamSimple` 不带 `sessionId`（对照） | `{ok:false,error:"400: {\"type\":\"MissingSessionID\",\"message\":\"Request is missing x-opencode-session…\"}"}` |
| C | 旧直调 + 自拼 `x-opencode-session`/`x-opencode-client`（对照） | `{ok:true,text:"P"}` |
| D | 注册虚拟模型后 `streamSimple`（含路由） | `{ok:true,text:"PONG"}`，`D_calls:1` |

（`maxTokens:16` 把回复截断成 `P`/`PONG`，判据是 ok/error 而非文本。B 的 400 证明 A 的会话头确实来自 `sessionId` 链路；D 证明虚拟模型在 `streamSimple` 下经路由出流，而旧基线在同一场景死于 `must be routed before streaming`。）

**留痕**：原始输出在 `%TEMP%/pi-goal-probe/`（`out-A-virtual.json` / `out-B-physical.json` / `out-C-baseline-virtual.json`，驱动临时区易失所以关键输出已摘录于上）。

**判据结论**：

- **不需要**「虚拟模型走 `streamSimple`、其余保留直调」的分叉：A/D 两路在 `streamSimple` 下均正常，直接替换即可（对齐文档验收标准 3 的 opencode-go 回归已由对照 A/B 与物理会话场景证明）。
- `x-opencode-client` 被移除属**知情决策**：A/D 路不带该头仍成功 ⇒ 服务端不要求该头（C 路带它成功说明发送无害）；若将来 opencode 收紧，在 `options.headers` 补回一处即可。
