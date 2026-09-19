# provider-quota-todo#8 对齐文档 — 移除 Kimi footer 计数段冗余显示

## 意图

provider-quota-todo#8：#7 交付后用户真机查看 footer（`40/100 5h40% m1%(...)`），指出计数段 `40/100` 与 `5h40%` 是同一 5h 窗的两种计量（#7 已说明同窗），并排显示冗余，要求删除计数段的显示。

## 范围

provider-quota-todo#8 只做：

- `parseKimiCodingUsage` 输出去掉计数段：`7/100 5h7% m0%(14:00)` → `5h7% m0%(14:00)`。
- 计数窗解析**保留为内部兜底**，不外显：`usages.limit_5h` 缺失时反推 5h 百分比、`limits[].detail.resetTime` 作 5h 重置时间兜底、计数打满（used>=limit）仍参与达限窗口判定（后缀顺位不变）。
- index.test.ts 更新计数段相关断言与用例名；README / docs 卡 / 规格 `docs/specs/provider-quota-kimi-coding.md` 同变更同步；根版本 2.56.0→2.57.0。

不做：删除计数窗解析逻辑本身；opencode-go/zhipu 等其它适配器的格式调整。

## 验收标准

provider-quota-todo#8 满足以下全部条件方可收口：

1. `node --experimental-strip-types --test src/extensions/provider-quota/index.test.ts` 全绿（断言更新为无计数段形态）。
2. 实测响应完整解析输出 `5h7% m0%(14:00)`；缺 usages 时计数窗兜底输出 `5h7%(14:00)`；计数打满仍驱动达限后缀（`5h100% m100%(14:00)`）。
3. `npm run test:all` 全绿；docs 卡 / README / 规格 / 根版本同步；`todo lint` 通过。

## 人工确认

provider-quota-todo#8 由用户直接指令确认（2026-09-19，真机查看 footer 后）：「把最下面的 40/100 给删除掉，因为 5h40% 已经显示过了，这个冗余了」。同窗两种计量并存显示的信息损失（计数/token 可能背离）已在 #7 对齐时说明，用户知情后仍要求删除显示。
