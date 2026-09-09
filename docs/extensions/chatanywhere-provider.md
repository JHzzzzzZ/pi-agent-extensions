# chatanywhere-provider — 双 provider 运行时自动发现（OpenAI 兼容 + Anthropic Messages）

> last verified @ 851a938

## 职责与边界

- 运行时自动发现插件：加载时探测 `GET {base}/models`（OpenAI 兼容 data 列表），按“家族线 + 档位”归并去重后注册 `chatanywhere`（openai-completions）与 `chatanywhere-claude`（anthropic-messages）两个 provider。
- **不做**：任何 UI / 命令 / 工具 / 事件钩子。只发一次探测请求；对话期 API 调用与 `$VAR` 解析全由宿主完成。
- 探测失败 fail-closed：两个 provider 均注册空 models，绝不回退静态目录（`ENGINE_UNAVAILABLE` 式硬失败哲学）。
- 目录外新模型自动注册为“未定价”（默认规格 + 接口窗口值），**无需改代码**。

## 文件地图

- `catalog.ts` — 模型目录（定价/元数据）13 组全启用（v1.1.0 恢复此前注释的 gpt5/documentedOpenAI/gpt5CA/gpt4/gpt4CA/qwen 六组 + 清理删除残留空行）+ `MODEL_LINES` 家族线表（19 条线：prefix/版本语法 dot|dash|none/tiers/cap=3）。
- `discover.ts` — 纯函数层：`probeModels`（Bearer + `AbortSignal.timeout(10s)`）→ `parseProbeResponse`（防御性读 context_window/max_tokens，snake/camel 皆可）→ `classifyId`（最长前缀命中线；版本解析；尾部日期剥离；档位整词匹配；`-ca` 渠道后缀）→ `collapse`（同种取最新、每线 ≤3 档、元数据解析、未知兜底）→ `selectForRegistration`。
- `auth.ts` — key 解析：`CHATANYWHERE_API_KEY` 环境变量 → `~/.pi/agent/auth.json`（chatanywhere → chatanywhere-claude 条目），读取/解析失败返回 undefined 不阻断加载。
- `index.ts` — async 工厂入口（约 40 行）：解析 key → 探测 → 注册。
- `test/discover.test.ts`（24）+ `test/auth.test.ts`（4）— fake fetch 隔离进程边界。

## 核心数据流

1. 加载：`resolveApiKey` → `probeModels` → `parseProbeResponse` → `classifyId` 逐 id 分类 → `collapse`（每线赢家排序 std→版本→价格取前 3，未知不占位按线/其他归桶）→ 两次 `registerProvider`。
2. 元数据解析优先级：探测 id 精确命中目录 → 借同线同版本定义（名称补日期/`(CA)` 标注）→ 未知兜底“（未定价）”。**绝不借跨版本定价**（claude-fable-5-1 实测落未知兜底，属设计而非 bug）。
3. 推理模型才带 thinkingLevelMap：openai 侧 minimal/low→low、xhigh/max→null；claude 侧仅 medium/high→"default" + `compat.forceAdaptiveThinking: true`。未知模型 reasoning=false → 无映射。
4. `apiKey: "$CHATANYWHERE_API_KEY"` 是宿主端引用语法；插件自身探测用的 key 走 auth.ts 解析（不依赖该语法）。
5. claude 分派：id 以 `claude-` 开头 → `chatanywhere-claude`；baseUrl 经 `claudeApiRoot` 自动去 `/v1`（anthropic-messages 宿主会自己拼 `/v1/messages`，且现在跟随 `CHATANYWHERE_BASE_URL`，不再硬编码根地址）。

## 不变量

- cost 字段单位是 CA币/**1M**；文档标价是 /1K——目录必须走 `per1M()` 助手，混用单位 = 成本显示错 1000 倍。
- cacheRead / cacheWrite 恒为 0：ChatAnywhere 不回传缓存计费。
- 目录与 `MODEL_LINES` 必须自洽：每个目录 id 都要能被 classifyId 解析（有测试锁死）；新增线/档位两处同步改。
- `-ca` 是低价渠道版不是独立模型：同种内 std 优先，仅当该档位只有 ca 被探测时才用 ca 注册。
- 同种（同线同档）只留最新：别名（无日期）视为最新、胜日期快照；快照 id 独占时可注册但用别名价（名称带日期）。
- 索引规则：环境变量 → auth.json，两者皆无 → 探测无 key 401 → fail-closed 空模型（可接受，不阻断加载）。

## 已知坑

- 真实响应形状（2026-09-09 实测）：`{ object, data: [{id, object:"model", created:0, owned_by:"ca"}] }`，**无** context_window/max_tokens 字段——窗口全靠目录兜底。当时服务 13 个模型：gpt-5.6-sol/terra、gpt-5.5、gpt-5.4、claude-opus-4-8/4-6/4-7/5、claude-sonnet-4-6/5、claude-fable-5/5-1、gpt-6-astra。
- 实测注册结果（2026-09-09）：openai = [gpt-5.6-sol, gpt-5.6-terra, gpt-5.5, gpt-6-astra（未定价）]（5.4 被 cap 3 截掉）；claude = [claude-opus-5, claude-sonnet-5, claude-fable-5-1（未定价）]（旧 opus 快照被同种去重吃掉）。模型回归/消失先查服务端列表，再查归并规则。
- a6dfa5f 曾删掉 253 行（Gemini 图像模型、Claude Opus 4.8 等）——删除的模型**未恢复**进目录；探测到才注册，未定价也照存。
- 探测超时 10s 会拖慢扩展加载（无 key 时 401 立即返回，不受超时影响）。
- 文档同一模型同时挂“最新”与“快照”两列表且定价偶有出入；目录价格以 doc-2694962 为准。

## 改动清单

- 必跑：`node --experimental-strip-types --test chatanywhere-provider/test/*.test.ts`（28 个）；真机 `/reload` 后 `/model` 目检。
- 改 catalog/MODEL_LINES：两处同步 + 跑发现类测试（目录自洽测试会抓不一致）。
- 改归并规则：先写锁定行为的失败测试再实现（纯函数，直接测）。
- 真实探测验证（手头无 key 时不可行）：readAuthJson 解析 auth.json 的 chatanywhere 条目 → probeModels → selectForRegistration 打印清单。