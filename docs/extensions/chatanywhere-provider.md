# chatanywhere-provider — 双 provider 运行时自动发现（OpenAI 兼容 + Anthropic Messages）

> last verified @ 775638d

## 职责与边界

- 运行时自动发现插件：加载时探测 `GET {base}/models`（OpenAI 兼容 data 列表），按“家族线 + 档位”归并去重后注册 `chatanywhere`（openai-completions）与 `chatanywhere-claude`（anthropic-messages）两个 provider。
- **不做**：任何 UI / 命令 / 工具 / 事件钩子。只发一次探测请求；对话期 API 调用与 `$VAR` 解析全由宿主完成。
- 探测失败 fail-closed：两个 provider 均注册空 models，绝不回退静态目录（`ENGINE_UNAVAILABLE` 式硬失败哲学）。
- 目录外新模型自动注册为“未定价”（默认规格 + 接口窗口值），**无需改代码**；但受准入过滤约束（见下）。

## 文件地图

- `catalog.ts` — 模型目录（定价/元数据）13 组全启用（v1.1.0 恢复此前注释的 gpt5/documentedOpenAI/gpt5CA/gpt4/gpt4CA/qwen 六组 + 清理删除残留空行）+ `MODEL_LINES` 家族线表（19 条）+ 注册策略表：`NON_CHAT_ID_PATTERNS`（非 chat 过滤）、`GENERATION_FLOORS`（旧代整代删除，每家族仅保留最新代）。
- `discover.ts` — 纯函数层：`probeModels`（Bearer + `AbortSignal.timeout(10s)`）→ `parseProbeResponse`（防御性读 context_window/max_tokens，snake/camel 皆可）→ `classifyId`（最长前缀命中线；版本解析；日期与 -thinking/-nothinking 变体尾缀交替剥除；档位整词匹配；`-ca` 渠道后缀）→ `collapse`（准入过滤→同种取最新→每线 ≤3 档→元数据解析→未知兜底）→ `selectForRegistration`。
- `auth.ts` — key 解析：`CHATANYWHERE_API_KEY` 环境变量 → `~/.pi/agent/auth.json`（chatanywhere → chatanywhere-claude 条目），读取/解析失败返回 undefined 不阻断加载。
- `index.ts` — async 工厂入口（约 40 行）：解析 key → 探测 → 注册。
- `test/discover.test.ts`（28）+ `test/auth.test.ts`（4）— fake fetch 隔离进程边界。

## 核心数据流

1. 加载：`resolveApiKey` → `probeModels` → `parseProbeResponse` → **准入过滤**（非 chat 模式匹配 / 家族版本低于代际下限 → 丢弃；未知模型按去变体尾缀基名去重、thinking 优先）→ `classifyId` 逐 id 分类 → `collapse`（每线赢家排序 std→版本→价格取前 3，未知不占位按线/其他归桶）→ 两次 `registerProvider`。
2. 元数据解析优先级：探测 id 精确命中目录 → 借同线同版本定义（名称补日期/`(CA)`/`(thinking)` 标注）→ 未知兜底“（未定价）”。**绝不借跨版本定价**（claude-fable-5-1 实测落未知兜底，属设计而非 bug）。
3. 同种（同线同档）取最新：版本 → 别名胜快照 → 日期新 → 标准渠道 → 变体（thinking > plain > nothinking）→ id；同系列同版本最多注册 1 个。
4. 推理模型才带 thinkingLevelMap：openai 侧 minimal/low→low、xhigh/max→null；claude 侧仅 medium/high→"default" + `compat.forceAdaptiveThinking: true`。未知模型 reasoning=false → 无映射。
5. `apiKey: "$CHATANYWHERE_API_KEY"` 是宿主端引用语法；插件自身探测用的 key 走 auth.ts 解析（不依赖该语法）。
6. claude 分派：id 以 `claude-` 开头 → `chatanywhere-claude`；baseUrl 经 `claudeApiRoot` 自动去 `/v1`（anthropic-messages 宿主会自己拼 `/v1/messages`，且现在跟随 `CHATANYWHERE_BASE_URL`，不再硬编码根地址）。

## 不变量

- cost 字段单位是 CA币/**1M**；文档标价是 /1K——目录必须走 `per1M()` 助手，混用单位 = 成本显示错 1000 倍。
- cacheRead / cacheWrite 恒为 0：ChatAnywhere 不回传缓存计费。
- 目录与 `MODEL_LINES` 必须自洽：每个目录 id 都要能被 classifyId 解析（有测试锁死）；新增线/档位两处同步改。
- `-ca` 是低价渠道版不是独立模型：同种内 std 优先，仅当该档位只有 ca 被探测时才用 ca 注册。
- 代际下限（GENERATION_FLOORS）：家族前缀版本低于 min 一律删除——gpt≥5.6、o≥4、gemini≥3、deepseek-v≥4、qwen≥3.5、kimi-k≥3、glm≥5、minimax-m≥3；`bare` 规则把无版本号的家族命名（deepseek-chat、gpt-oss-*）也按旧代处理。claude 无下限（版本收敛靠同种去重：opus/sonnet 只留 5、haiku 4.5 无更新换代）。
- 变体规则：`-thinking`/`-nothinking` 只是渠道商的思考模式后缀，不是独立模型；变体可出现在日期前后（…-thinking-2507 或 …-20251101-thinking）。
- 索引规则：环境变量 → auth.json，两者皆无 → 探测无 key 401 → fail-closed 空模型（可接受，不阻断加载）。

## 已知坑

- 真实响应形状（2026-09-09 实测，分组切换后）：`{ object, data: [{id, object:"model", created:0, owned_by:"ca"}] }`，**无** context_window/max_tokens 字段——窗口全靠目录兜底。默认分组只返回 13 个模型（gpt-5.6-sol/terra、gpt-5.5、gpt-5.4、claude 全系、gpt-6-astra）；切到更高分组返回 146 个。
- 实测注册结果（2026-09-09，146 模型）：非 chat 过滤 20 个（tts/embedding/whisper/gpt-image/transcribe/斜杠/davinci）；最终 openai 23 + claude 4。openai 含：gpt-5.6 sol/terra/luna、o4-mini、deepseek-v4 pro/flash（+flash-xd 未定价）、qwen3.5 397b/plus（+3.8-max 未定价）、glm-5.3（未定价——5.2 目录价存在但被同种取最新让位）、minimax-m3、gemini 3.x 全家（3.5-flash 有价，其余 preview/lite 未定价）、gpt-6-astra、kimi-k3（未定价）；claude：opus-5、sonnet-5、haiku-4-5（-thinking 变体胜出，名称带 (thinking)）、fable-5-1（未定价）。模型回归/消失先查服务端列表，再查归并规则。
- a6dfa5f 曾删掉 253 行（Gemini 图像模型、Claude Opus 4.8 等）——删除的模型**未恢复**进目录；探测到才注册，未定价也照存。
- 探测超时 10s 会拖慢扩展加载（无 key 时 401 立即返回，不受超时影响）。
- 文档同一模型同时挂“最新”与“快照”两列表且定价偶有出入；目录价格以 doc-2694962 为准。

## 改动清单

- 必跑：`node --experimental-strip-types --test src/extensions/chatanywhere-provider/test/*.test.ts`（32 个）；真机 `/reload` 后 `/model` 目检。
- 改 catalog/MODEL_LINES/策略表（NON_CHAT / GENERATION_FLOORS）：同步 + 跑发现类测试（目录自洽测试会抓不一致）。
- 改归并规则：先写锁定行为的失败测试再实现（纯函数，直接测）。
- 真实探测验证（需要 auth.json 的 chatanywhere key）：probeModels → selectForRegistration 打印清单。