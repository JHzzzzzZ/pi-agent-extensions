# stream-token-speed — pi TUI 扩展（JHL-10）

在 pi TUI 流式回复期间显示 **TTFT（首 token 延迟）** 与 **瞬时 tokens/s**，
结束后保留本轮 **TTFT / 最后瞬时值 / 平均速度**。

计量范围：文本（`text_delta`）、thinking（`thinking_delta`）、tool call
（`toolcall_delta`）的流式增量，每个统一流事件计 1 个 token；
**tool result 与工具执行进度一律排除**，不改变任何计数与速率。

## 安装

将本目录复制到 pi 的扩展目录：

```text
~/.pi/agent/extensions/stream-token-speed/     # 全局
# 或项目级：.pi/extensions/stream-token-speed/
```

重启 pi，或在会话内执行 `/reload`。卸载 = 删除该目录。
无任何运行时依赖（`import type` 在加载时被擦除），**无需 npm install**。

## 使用效果

| 阶段 | 状态区显示（键：`stream-token-speed`） |
| --- | --- |
| assistant 消息开始 | `生成中：TTFT 等待中｜速度 —` |
| 流式生成中（v4 热身期：前 1s） | `生成中：TTFT 420 ms｜速度 —` |
| 流式生成中（满 1s 后，每 250ms 节流刷新） | `生成中：TTFT 420 ms｜速度 18.0 tok/s` |
| 结束（有流式数据） | `TTFT 420 ms｜最后 18.0 tok/s｜平均 18.0 tok/s` |
| 结束（末尾无输出，最后瞬时沿用） | `TTFT 420 ms｜最后 ~18.0 tok/s｜平均 18.0 tok/s` |
| 结束（无流式数据） | `无流式速度数据` |

> 状态文本在 TUI 模式下以 `ctx.ui.theme.fg("dim", text)` 渲染为灰色
> （`setStatus` 仅接受字符串，颜色由 theme 样式函数包装；RPC 模式保持纯文本）。

指标口径（详见仓库内 `docs/` 的 PRD/Design v4）：

- **TTFT**：首个可计量增量到达时刻 - 消息开始时刻，整数毫秒。
- **瞬时速度（热身期 + EMA 平滑）**：当前时刻向前最多 1000ms 的可计量
  增量数 ÷ 实际观察窗口秒数得到原始值，再经 **EMA（α=0.3）** 平滑后显示；
  渲染节流 250ms。**v4 热身期**：首个增量后的前 1s（窗口未填满）速度保持
  `—` 不更新，避免未满窗口把首波突发放大成峰值；满 1s 后以首个完整
  1s 窗口值作为 EMA 种子开始更新；无增量（工具执行/流间隙）期间平滑值保持。
- **平均速度（有效流式时长）**：本轮总增量 ÷（最后增量时刻 - 首增量时刻），
  即「首 token → message_end」区间扣除末端无输出/工具执行间隙；
  消息间的工具执行本就不计入消息时长。
- **最后瞬时值**：末尾 1s 窗口有样本时取末尾 EMA；无样本时沿用最近一次
  渲染的非零平滑值（热身期未完成则退回有效时长平均，恒非零），以 `~`
  前缀标注。
- 所有速率四舍五入到一位小数；时间为同一单调时钟（`performance.now`）。

## 行为边界

- 非流式回复 / 无可计量增量 → `无流式速度数据`（不显示 0 tok/s）。
- 生成中取消 / 报错 → 按已收到的增量与结束时间生成汇总，之后停止刷新。
- print / json 模式（无 UI）→ 静默降级，不调用 `setStatus`。
- `setStatus` 与样式函数的异常均在端口内部隔离，不影响 pi 的消息流与工具调用。
- 不读取、不记录、不发送任何消息内容（text/thinking/tool 参数），
  仅消费 pi 统一 assistant 流事件；无新增网络请求与持久化。
- 轮次归属对 responseId 采用“未知即通配”：真实 provider 的 `message_start`
  通常尚无 responseId（响应 id 在流开始后才可知），`message_update` /
  `message_end` 才携带——空 id 不参与不匹配判定，首个真实 id 被收编进当前轮
  （修复 JHL-10 验收问题 2 的根因）。

## 结构

```text
stream-token-speed/
├── index.ts        # 扩展入口：订阅 message_start/update/end，装配各层
├── adapter.ts      # 事件适配层：pi 事件 -> 内部度量契约（过滤三类 delta）
├── metrics.ts      # 度量层：TTFT / 1s 滑动窗口瞬时速度 / 平均速度（纯函数）
├── controller.ts   # 编排层：轮次状态机 + 250ms 节流渲染
├── status-port.ts  # TUI 状态端口：可用性判定 + 样式 + setStatus 异常隔离
└── test/           # node:test 单元/集成测试（AC-01 ~ AC-09 + 修复回归）
```

## 自测

```bash
# 单元 + 集成测试（43 条，覆盖 PRD AC-01 ~ AC-09 + 修复#1/#2 回归 + v3/v4 口径）
node --experimental-strip-types --test \
  test/metrics.test.ts test/adapter.test.ts test/integration.test.ts

# 真实 pi 进程端到端自测（RPC 模式 + 内置 fake 流式 provider；
# fake provider 模拟真实 provider 的 responseId 时序：start 无 id、增量后有；
# 流时长 > 1.2s，覆盖 v4 热身期与正式计量）
# 场景 1：流式回复（thinking/text/toolcall 增量 + 工具执行）-> 汇总正确
# 场景 2：非流式回复 -> 无流式速度数据
node e2e/run-e2e.mjs
```

> e2e/fake-provider.ts 是测试专用伪 provider，仅用于自测，不随扩展分发。
