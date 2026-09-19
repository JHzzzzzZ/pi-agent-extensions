# provider-quota-todo#7 对齐文档 — Kimi Coding Plan 限额查询

## 意图

provider-quota-todo#7：为 provider-quota 插件新增 Kimi Coding Plan（kimi-coding provider）的限额查询适配器，让 footer 状态行在使用 kimi-coding 模型时显示订阅用量。

探测结论（2026-09-19 真机实测，HTTP 200）：

- 端点 `GET https://api.kimi.com/coding/v1/usages`，鉴权 `Authorization: Bearer sk-kimi-…`（Kimi Code 控制台 key，与开放平台 sk- key 不互通；用户 auth.json 已有 `kimi-coding` 条目）。
- 真实响应含两类数据：`limits[]`（5 小时请求计数窗，`window.duration=300` + `timeUnit=TIME_UNIT_MINUTE`，`detail.limit/used/remaining` 为**字符串数字**，`resetTime` 为**纳秒 ISO**）与 `usages`（`limit_5h` / `limit_month_total` / `limit_month_code`，各为 `{used_ratio, reset_time}`）。

## 范围

provider-quota-todo#7 只做：

- `QUOTA_ENDPOINTS` 新增 `kimi-coding` 适配器：固定 URL `https://api.kimi.com/coding/v1/usages`，默认 Bearer 头，key 只读 auth.json（沿用插件「凭据不读环境变量」不变量）。
- `PROVIDER_ALIASES` 加 `kimi → kimi-coding`；`AUTH_ID_FALLBACK` 加 `kimi-coding → ["kimi"]`。
- 新增导出纯函数 `parseKimiCodingUsage(body, now)`，只支持实测响应形态（不做旧形态 `usage` 单对象 / `data[]` 数组的防御兼容）。
- 输出格式：`7/100 5h7% m0%(19:03)` —— 请求计数（used/limit，来自 limits[] 5h 窗）+ 5h 用量百分比（优先 `usages.limit_5h.used_ratio`，缺失回退计数窗百分比）+ 月度百分比（`limit_month_total`，缺失回退 `limit_month_code`）+ 重置时间后缀（限额窗口优先、默认 5h，规则同 zhipu/opencode-go：同日 `HH:mm`、跨日 `MM-dd HH:mm`、早于 now-24h 不加括号）。
- index.test.ts 补解析用例；同步 docs 卡、根 README、CONTEXT.md 术语。

不做：月度额度进度条/倒计时、membership 等级显示、WebBridge 月度 credits、环境变量读 key、自定义基址。

## 验收标准

provider-quota-todo#7 满足以下全部条件方可收口：

1. `node --experimental-strip-types --test src/extensions/provider-quota/index.test.ts` 全绿（含新增 kimi 用例：实测形态解析、字符串数字、纳秒时间戳、缺 usages 回退计数窗、缺 limits 只显比例、过期/跨日重置后缀、限额窗口后缀优先、空 body 返回 null）。
2. `npm run typecheck` 零错误（provider-quota 无 package.json，走根/适用的类型检查面）。
3. 真机 `/quota` 在 kimi-coding 模型下显示 `7/100 5h7% m0%(HH:mm)` 形态文本（数值随真实用量）。
4. docs/extensions/provider-quota.md、根 README（内置支持列表）、CONTEXT.md（如需新术语）同变更同步。

## 人工确认

provider-quota-todo#7 已经人类逐条确认（2026-09-19，会话内）：

1. 请求计数窗也要显示（格式 `7/100 5h7% m0%(19:03)`）——用户：「请求次数也要看」。
2. 只支持实测响应形态，不兼容旧形态——用户：「只支持实测」。
3. provider 归一方案（adapter `kimi-coding`、别名 `kimi`、key 只读 auth.json、固定官方 URL）——用户：「OK」。
