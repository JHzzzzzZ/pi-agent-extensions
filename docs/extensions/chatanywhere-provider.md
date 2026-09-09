# chatanywhere-provider — 双 provider 适配器（OpenAI 兼容 + Anthropic Messages）

> last verified @ 0142e14

## 职责与边界

- 纯静态模型目录插件：注册 `chatanywhere`（openai-completions）与 `chatanywhere-claude`（anthropic-messages）两个 provider，把 ChatAnywhere 转发站的 16 个模型暴露进 `/model` 选择器。
- **不做**：任何 UI / 命令 / 工具 / 事件钩子；自己不发请求（API 调用与 `$VAR` 解析全由宿主完成）；无任何运行时逻辑，加载即定型。
- Todo 遗留（todos/chatanywhere-provider-todo.md）：想按关键词给模型分组并限制每供应商最多 3 个模型，尚未实现；README 效果图因无 UI 搁置。

## 文件地图

- `index.ts`（1080 行）— 全部内容：ModelDef 定义 + `per1M()` 换算助手 + 各系列模型表 + 入口里两次 `pi.registerProvider`。没有别的模块。
- `package.json` — `pi.extensions: ["./index.ts"]` 声明入口；目录复制进 `extensions/` 后 pi 据此加载。

## 核心数据流

1. 加载时一次性执行：拼合各系列数组 → Map 按 id 去重 → 拆成两个 provider 注册，之后插件再无活动。
2. 非推理模型不带 thinkingLevelMap（条件展开）；推理模型把 minimal/low 映射为 low，xhigh/max 映射为 null——null 是"该渠道不支持"的宿主契约。
3. Claude provider 全系列强制 `compat.forceAdaptiveThinking: true`，只有 medium/high 映射到 "default"，其余全 null。
4. `apiKey: "$CHATANYWHERE_API_KEY"` 是宿主端引用语法，插件自己从不读环境变量。

## 不变量

- cost 字段单位是 CA币/**1M**；ChatAnywhere 文档（doc-2694962）标价是 /1K——新增模型必须走 `model()` 助手（自动 ×1000），手写对象字面量必须逐字段乘 1000。混用单位 = 成本显示错 1000 倍。
- cacheRead / cacheWrite 恒为 0：ChatAnywhere 不回传缓存计费，不要"顺手补上"。
- 两个 baseUrl 的 /v1 差异：`chatanywhere` 默认 `https://api.chatanywhere.tech/v1`（含 /v1，可经 `CHATANYWHERE_BASE_URL` 覆盖）；`chatanywhere-claude` 是硬编码根地址（不含 /v1）——anthropic-messages 宿主实现会自己拼 `/v1/messages`，且**不走**环境变量。改 baseUrl 必须保住这个含/不含差异。
- `allModels` 里大量系列数组被注释掉（gpt5 / documentedOpenAI / gpt5CA / gpt4 / gpt4CA / qwen）——刻意裁剪，不是漏写；恢复一个系列 = 模型数翻倍，先确认渠道仍在售。
- Map 去重保留后者：调整数组合并顺序会悄悄改变"最新 vs 快照"同名模型的最终定价。

## 已知坑

- 零测试覆盖（AGENTS.md「覆盖缺口」明记），改动验证只能靠语法检查 + 真机 `/reload` 后 `/model` 目检成本与模型出现。
- a6dfa5f 一次删掉 253 行：Gemini 图像模型（按张计费无法折算 token 成本）与 Claude Opus 4.8 被移除；用户报"模型不见了"先查这个 commit。
- ChatAnywhere 文档同一模型同时挂在"最新"与"快照"两列表且定价偶有出入；卡内价格一律以 doc-2694962 为准，疑似标价错误先对文档再怀疑代码。
- `-ca` 后缀（如 gpt-5.4-ca）是 ChatAnywhere 低价渠道版，不是独立模型：与无后缀版上下文一致、价格不同，勿当重复项合并。
- 模型 id 必须与服务端字面 id 完全一致（如 `claude-haiku-4-5-20251001` 带日期快照后缀）；凭印象编 id 会 404。

## 改动清单

- 必跑：`node --experimental-strip-types --check chatanywhere-provider/index.ts`（0 个测试可跑，只查语法）；真机 `/reload` + `/model` 目检。
- 新增/调整模型：核对 docs.chatanywhere.tech 定价（/1K）→ 走 `model()` 助手 → 同步本卡 last verified 行。
- fake 模式：按 docs/cross/deps-ports.md 规则 3——纯数据、无 IO 边界，不立 fake；将来实现 todo 的"每供应商限 3 个"过滤时是纯逻辑，直接测纯函数即可。
