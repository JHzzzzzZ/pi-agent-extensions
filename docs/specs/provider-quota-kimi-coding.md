# provider-quota 支持 Kimi Coding Plan 限额查询 — 规格

> 来源：todos/provider-quota-todo#7（对齐文档 `todos/align/provider-quota-todo#7.md`，2026-09-19 人工确认）。

## 问题陈述

provider-quota 插件内置 openrouter/deepseek/chatanywhere/zhipu/opencode-go 五个适配器，用户日常使用 Kimi Coding Plan（pi 内置 `kimi-coding` provider，auth.json 已有 `sk-kimi-` key）时 footer 无额度显示。

## 方案

真机探测（2026-09-19，HTTP 200）锁定契约：

- `GET https://api.kimi.com/coding/v1/usages`，`Authorization: Bearer sk-kimi-…`（Kimi Code 控制台 key，与开放平台 key 不互通）。
- 响应实测形态：
  - `limits[]` — 5 小时请求计数窗：`window.{duration:300, timeUnit:"TIME_UNIT_MINUTE"}`，`detail.{limit,used,remaining}` 为**字符串数字**，`detail.resetTime` 为**纳秒 ISO**。
  - `usages` — 用量比例：`limit_5h` / `limit_month_total` / `limit_month_code`，各 `{used_ratio:number, reset_time:ISO}`。
- 参考实现（Golden0Voyager/kimi-code-usage、LaneSun/kimi-code-usage、xy200303/spec-kimi-code）一致指出字段跨版本漂移；但按对齐结论**只支持实测形态**，不做旧形态（`usage` 单对象 / `data[]` 数组）兼容。

footer 输出（沿用插件紧凑风格，后缀规则同 zhipu/opencode-go）：

```
7/100 5h7% m0%(19:03)
└─┬─┘ └┬┘ └┬┘ └──┬──┘
  │    │   │     └ 重置时间：限额窗口优先（5h>month），默认 5h；同日 HH:mm、跨日 MM-dd HH:mm、早于 now-24h 省略
  │    │   └ 月度用量百分比：usages.limit_month_total.used_ratio（缺失回退 limit_month_code）
  │    └ 5h 用量百分比：usages.limit_5h.used_ratio（缺失回退计数窗 used/limit 百分比）
  └ 5h 请求计数：limits[] 中 300 分钟窗的 detail.used/detail.limit（窗缺失且 limits 仅一条时取该条；否则省略此段）
```

## 用户故事

- 使用 kimi-coding 模型时，session 启动 / 每 5 分钟 / 切换模型 / `/quota` 后，footer 显示 `7/100 5h7% m0%(19:03)` 形态的实时用量。
- 无 key / 网络错误 / 解析失败时显示 `kimi-coding: no key|net err|timeout|HTTP <code>|-`（沿用插件既有错误态）。

## 实现决策

1. `QUOTA_ENDPOINTS["kimi-coding"]`：固定 URL、默认 Bearer（不写 `auth`，复用默认头）、`parse` 调 `parseKimiCodingUsage(body, new Date())`。
2. `PROVIDER_ALIASES` 加 `kimi: "kimi-coding"`；`AUTH_ID_FALLBACK` 加 `"kimi-coding": ["kimi"]`（双向覆盖 provider id 写法）。
3. `parseKimiCodingUsage(body, now)` 纯函数导出（now 注入，固定时钟测试），返回 `string | null`：
   - 数字解析接受 number 与数字字符串（`detail` 字段实测为字符串）。
   - ISO 时间戳解析前把毫秒后多余位数截断到 3 位（纳秒防御），复用既有 `toZhipuRefreshDate`/`formatZhipuRefreshSuffix`。
   - 5h 计数窗匹配：`timeUnit` 含 `MINUTE` 且 `duration===300`，或含 `HOUR` 且 `duration===5`；无匹配时 limits 仅一条则取该条，否则省略计数段。
   - `used_ratio` 为小数比例（0..1，超限可 >1，如实显示 >100%），百分比四舍五入取整。
   - 所有段缺失时返回 null（footer 显示 `kimi-coding: -`）。
4. 无自定义基址、无环境变量、无新运行时 import（保持 `node --experimental-strip-types` 直接可测）。

## 测试决策

- 全部走 `parseKimiCodingUsage` 纯函数 + 固定本地时钟 Date（沿用 index.test.ts 头部注释的时钟约定，断言不依赖运行机器时区）。
- 用例：实测响应完整解析 / 纳秒 resetTime / 字符串数字 / 缺 usages 回退计数窗百分比 / 缺 limits 只显比例 / 计数窗仅一条无 window 匹配仍取 / 过期重置（早于 now-24h）省略后缀 / 跨日重置 `MM-dd HH:mm` / 月度限额时后缀取月度 reset_time / 空 body 与全缺字段返回 null / used_ratio 超 1 显示 >100%。
- fetch 链路不覆盖（同插件既有口径：网络行为真机 `/quota` 验证）。

## 范围外

旧响应形态（`usage` 单对象 / `data[]`）兼容；membership 等级、parallel 上限、boosterWallet 显示；`/me` 端点；环境变量读 key；自定义基址与主机白名单。
