# virtual-model-router 真机验收清单（general-todo#22 验收 2–7）

> 本清单是**给人跑的**：每条都有操作 / 期望 / 失败判据 / 证据要求。纯函数与宿主目录接缝已由
> `src/extensions/virtual-model-router/` 的 20 个测试覆盖（`npm test`），本文件只列**只能真机验**的部分。
> 交付时这些**尚未在真机跑过**，通过与否以你跑出来的证据为准。

默认档位（`config.ts`）：`strong` = `opencode-go/deepseek-v4-pro`、`fast` = `opencode-go/deepseek-v4.1-flash`、
`longContext` = `opencode-go/mimo-v2.5-pro`、`direct` = `opencode-go/deepseek-v4.1-flash`。

## Step 0 · 让改动真的生效（包形态）

1. 本仓库在 pi 里是 **git 包**（`~/.pi/agent/settings.json` 的 `packages`）：改动必须 ① push 到 `dev-laptop`，
   再 ② `pi update`（或重启会话）刷新 `~/.pi/agent/git/github.com/...` 缓存。**未 push 的本地 commit 在 pi 里跑的还是旧代码。**
2. 想跳过步骤 1 做本地验证：`pi -e ./src/extensions/virtual-model-router --model opencode-go/router`（直接挂载本目录）。

- **期望**：启动后 `/model` 列表里出现 `opencode-go/router`（名字 `Router (按请求自动选模型)`）。
- **失败判据**：列表里没有它 → 改动没生效（先查 push/缓存），或扩展加载抛错（看启动 stderr）。
- **证据**：`/model` 列表截图或复制出的那一行。

## 验收 2 · 选中它 + footer 显示「选中 → 物理」

1. `/model` 选 `opencode-go/router`，随便发一句话（比如「列出当前目录名」）。
2. 看 footer。

- **期望**：footer 形如 `router • <选中级别> → deepseek-v4-pro • <实际级别>`——左边是本扩展注册的虚拟模型，箭头右边是**这次请求实际发出去的物理模型**。
- **失败判据**：箭头右边仍是 `router`（说明没路由，请求直接打给虚拟模型）；或整个段不出现。
- **证据**：footer 文本。

## 验收 3 · 一次会话里至少两类物理模型被实际使用

1. 在同一个会话里发一句需要工具的消息（如「读一下 AGENTS.md 前 20 行并说一句感想」），让 agent 至少跑一轮工具。
2. 再发一轮。
3. `/session` 看成本分列。

- **期望**：用户消息后的**首请求**落在 `deepseek-v4-pro`（强档）；工具结果之后的**续跑**落在 `deepseek-v4.1-flash`（快档）。`/session` 里两个物理模型各有一行成本。
- **失败判据**：整段会话只用了一个物理模型；或只用 `fast`（说明 `reason` 判断没吃到 `user`）。
- **证据**：`/session` 的按模型成本列表 + 下面这条从会话文件里导出的轨迹（`<session.jsonl>` = `ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1`）：

```bash
node -e 'const fs=require("fs");for(const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")){let e;try{e=JSON.parse(l)}catch{continue}if(e.type==="model_change")console.log("选择",e.provider+"/"+e.modelId);if(e.type==="custom"&&e.customType==="pi.virtual-model-state")console.log("  state",JSON.stringify(e.data.state));if(e.type==="message"&&e.message.role==="assistant")console.log("  实际",e.message.provider+"/"+e.message.model,e.message.stopReason)}' <session.jsonl>
```

期望输出形如：`选择 opencode-go/router` → `实际 opencode-go/deepseek-v4-pro stopReason` → `state {"tier":"strong"}` → `实际 opencode-go/deepseek-v4.1-flash` → `state {"tier":"fast"}`。

## 验收 4 · `retry` 路径（本条最容易写错，必须有证据）

**4a · 普通失败后的升档**：选 `opencode-go/router`，关掉代理/断网发一句（让首个请求失败并触发宿主自动重试），随后恢复网络。

- **期望**：重试这一次落在**强档** `deepseek-v4-pro`（不是 `fast`）。
- **失败判据**：重试仍停在 `fast`（`retry` 没被识别，或升档表没生效）。
- **证据**：轨迹里看到失败那条之后的 `实际 opencode-go/deepseek-v4-pro`；失败请求本身在轨迹里可能只留 `stopReason error`。

**4b · 上下文溢出后的换档**：把 `config.ts` 的 `strong` 临时指到一个窗口小的模型（或往会话里灌一段超大文本把窗口顶爆），触发宿主的溢出压缩 + 重试。

- **期望**：重试这一次落在 `longContext` 档 = `mimo-v2.5-pro`，state 变成 `{"tier":"longContext"}`。
- **失败判据**：重试落到 `strong`（溢出信号没被判出来——`CONTEXT_OVERFLOW_PATTERNS` 需要按实际 provider 的错误措辞补一条）。
- **证据**：轨迹里的 `state {"tier":"longContext"}` + 该档位的实际模型名；同时留下**原始错误文本**（`stopReason` / `errorMessage`），它是判断"该加哪条模式"的唯一依据。

## 验收 5 · `direct` 请求不受路由策略打扰

1. 选 `opencode-go/router`，在会话里跑 `/compact`（compaction summary 走 `reason: "direct"`）。
   （扩展直调同一路径：goal 评估器的 `ctx.modelRegistry.streamSimple()`，见 goal-todo#10。）

- **期望**：summary 落在 `direct` 档 = `deepseek-v4.1-flash`，**且不产生/不改变** `state` 条目。
- **失败判据**：summary 被打到强档/长上下文档（说明 `direct` 分支没生效）；或 `/compact` 后多出一条 `pi.virtual-model-state` 条目。
- **证据**：`/compact` 前后的轨迹（对比 state 条目数量）。

## 验收 6 · 恢复语义：`/resume` 与 `/tree` 分支各存各的

1. 会话 A：用 `router` 跑几轮（产生 `state`），退出。
2. `/resume` 回到会话 A → 再发一句，确认策略与恢复前一致（首请求 → 强档）。
3. `/tree` 切到更早的一个分支点，在那里发一句，再切回来。

- **期望**：`/resume` 后虚拟选择从最新 `model_change` 恢复（footer 仍显示箭头关系）；`/tree` 每个分支自己的 `pi.virtual-model-state` 互不影响——切到旧分支时用的是**该分支**的档位历史。
- **失败判据**：恢复后 footer 不回箭头（回退成了物理模型 = 虚拟模型没注册上）；或切分支后档位沿用了另一分支的历史。
- **证据**：轨迹里 state 条目的 `parentId` 链（同一条链上的 state 才是该分支的）。

## 验收 7 · agent-team preflight 不再吃「无鉴权」warning

1. 建一个 `model: opencode-go/router` 的团队文件，跑 `/team:doctor`，再 `team_run` 一次。

- **期望**：model 预检**不出现**「未配置鉴权」warning（`router` 注册在 `opencode-go` 下，用户已有该 provider 凭据 → `hasConfiguredAuth` 为真）。
- **失败判据**：出现「`opencode-go/router` 未配置鉴权」→ 说明注册没落在有凭据的 provider 下（检查 `config.ts` 的 `VIRTUAL_MODEL.provider`）。
- **证据**：`/team:doctor` 输出（preflight 行）+ `team_run` 启动时无该 warning。

## 备注（不在本期）

- **Jev 增强版**：`reason` 纯规则之外再叠分类器（任务难度/类型）。评估结论：本期纯规则版已吃掉免费信号；只有当纯规则版的**模型选择质量**被证明是瓶颈（而不是"有没有路由"）时，多一次调用 + 首 token 延迟才值得——继续挂账。
- 已知上游导出缺口：`isVirtualModel` / `VIRTUAL_MODEL_API` 未从包根导出，本扩展硬编码 `model.api === "pi-virtual"`；`isContextOverflow` 只在 `@earendil-works/pi-ai/compat`，本扩展只做四类措辞粗判。
