# provider-quota — 余额/额度状态行 + /quota 手动刷新

> last verified @ 8bee163

## 职责与边界

footer 状态行显示当前 provider 的余额/额度：session 启动即查、每 5 分钟轮询、切换 model 自动刷新、`/quota` 手动刷新。内置适配 openrouter/deepseek/chatanywhere/zhipu/opencode-go。**不做**：内置列表外 provider（anthropic/openai 直连等）静默不显示；**不读环境变量取 API key**（凭据只认 auth.json）。

## 文件地图

- `index.ts` — 全部实现（单文件约 600 行，无 package.json）。`QUOTA_ENDPOINTS` 是加新 provider 的唯一入口（url / method / auth / parse 四件套）。
- `index.test.ts` — 25 个测试；纯解析函数 `parseZhipuQuotaLimit` / `parseOpencodeGoUsage` 显式导出且 now 由参数注入——固定时钟测试的关键设计。`STATUS_ID` 也导出供键带断言。
- provider id 经 `PROVIDER_ALIASES` 归一（glm/zai/bigmodel→zhipu，zen/opencode→opencode-go），key 读取带 `AUTH_ID_FALLBACK` 回退链。

## 核心数据流

1. `session_start` 新建 session 级 AbortController → refresh + 5 分钟 setInterval；`model_select` 与 `/quota` 各触发一次 refresh。
2. refresh：provider id 归一 → 查 adapter → 读 auth.json key（按 id，含回退链）→ fetch（10s 超时）→ adapter.parse → `theme.fg("dim", …)` 写入状态键 `20:provider-quota`（排序带，见 `docs/cross/status-bar.md`）。
3. 同一 provider 的并发刷新经 in-flight Map 去重复用；解析失败/HTTP 错显示 `<provider>: <label>`，parse 返回 null 显示 `<provider>: -`。

## 不变量

- 凭据只来自 `~/.pi/agent/auth.json` 按 provider id 取 `key` 字段，明确不用环境变量（index.ts `AUTH_FILE`/`readApiKeyFor`）；zhipu 基址是唯一用到环境变量的地方——`ANTHROPIC_BASE_URL` 只选基址、不参与鉴权。
- fail-closed 白名单：zhipu 自定义基址必须 https + 无显式端口 + `ZHIPU_ALLOWED_HOSTS`（open.bigmodel.cn / dev.bigmodel.cn / api.z.ai），非法或未设置一律回退默认地址，绝不发往其它主机（index.ts `resolveZhipuBase`）。
- zhipu 鉴权 Authorization 是原始 token，**不加 Bearer 前缀**；quota-limit 请求不附时间窗 query 参数（参考实现契约）。
- `session_shutdown` 后未完成请求不得回写 footer：每次 setStatus 前检查 `sessionSignal.aborted`，shutdown 后保留已中止的 controller 引用让残留链路立即短路（index.ts `write` 与 `session_shutdown`）。
- 节奏常量：5 分钟轮询、10s 超时、重试 3 次、500ms 基础指数退避（`REFRESH_MS`/`FETCH_TIMEOUT_MS`/`MAX_RETRIES`/`BASE_BACKOFF_MS`）。低频刷新**不接对齐秒节拍**（非时间显示类，跨插件状态条契约只约束时间类状态）。
- 状态键 `20:provider-quota` 带排序带前缀，不可改回 `provider-quota`（宿主按 key localeCompare 拼接 footer）。
- 可重试分类：5xx / timeout / net err 可重试，parse err 不可（`FetchResult.retryable`）。

## 已知坑

- `ctx.signal` 是 turn 级信号，在 session_start / session_shutdown / 空闲命令等上下文常为 undefined，**不能当 session 取消依据**——为此单独维护 session 级 AbortController（index.ts 顶部注释有完整论述）。
- 新加触发刷新的钩子必须走 `refresh()`（内含 in-flight 去重），绕过它直接调 `doRefresh` 会并发撞 footer（index.ts）。
- chatanywhere 接口要求 `User-Agent: cc-switch/1.0` 头（`QUOTA_ENDPOINTS.chatanywhere.auth`），漏掉会被服务端拒绝。
- zhipu nextResetTime 有毫秒/秒 epoch + ISO 字符串三种格式、5 个字段名变体；<1e9 的时间戳按垃圾值丢弃，早于 now-24h 的刷新时间不追加后缀（index.ts `EPOCH_*`/`STALE_WINDOW_MS`），都是对真实响应的防御。
- opencode-go 重置后缀跟随**命中限额的窗口**（status != "ok"，多窗口同时限额取 rolling > weekly > monthly 顺位），不是最早的 resetsAt——index.test.ts 有"rolling 已限额但重置更晚仍取 rolling"的专项用例（54e5e80 引入）。
- index.ts 顶部只允许 `import type`（类型擦除后零外部依赖），这是能用 `node --experimental-strip-types` 直接单测的前提；加任何运行时 import 都会破坏它。

## 改动清单

- 必跑：node --experimental-strip-types --test provider-quota/index.test.ts（25 个测试；此目录无 package.json，npm test 跑不了）。
- 必看测试：index.test.ts 头注释——时钟约定全部用本地时间 Date 构造固定 now，断言不依赖运行机器时区，新增时间相关用例必须沿用。
- fake 模式：按 docs/cross/deps-ports.md 规则 3——纯逻辑不 fake，直接测导出的解析函数、now 参数注入；fetch 链路在测试里未覆盖，网络行为只能真机 /quota 验证。
- 加新 provider：只动 `QUOTA_ENDPOINTS`（必要时补 `PROVIDER_ALIASES`/`AUTH_ID_FALLBACK`）+ index.test.ts 补 parse 用例，勿散落到别处。
