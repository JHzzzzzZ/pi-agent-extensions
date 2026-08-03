/**
 * 编排层：将适配器输出的事件驱动度量状态机，并负责 250ms 节流渲染。
 *
 * 交互流程（JHL-10-Design-v2.md §5）：
 *   assistant message_start  -> 创建 Run，显示“生成中：TTFT 等待中｜速度 —”
 *   message_update(eligible) -> 计入 1 个 token，到达合格刷新点时原位更新状态
 *   tool result / 工具执行   -> 不订阅、不计数、不影响任何指标
 *   assistant message_end    -> 有样本：汇总；无样本：无流式速度数据
 *
 * 轮次隔离：pi 的消息流按 message_start -> message_end 严格串行，同一时刻只
 * 存在一个进行中的 assistant 消息；控制器只保留“当前轮”。新 assistant
 * message_start 立即替换上一轮展示（AC-08），随后的 tool result 不会改变新轮
 * 指标。
 *
 * responseId 匹配（JHL-10-修复#2 根因）：真实 provider 的 message_start
 * partial 通常没有 responseId（响应 id 在流开始后才可知），而 message_update /
 * message_end 携带真实 responseId。因此空串 id 视为“未知/通配”——仅当两侧 id
 * 均非空且不一致时才判定为跨轮事件并丢弃；同时把首个到达的真实 responseId
 * 收编进当前 Run，使后续事件得以精确匹配。
 */

import type { PiEventAdapter } from "./adapter.ts";
import {
  addEligibleDelta,
  computeSummary,
  createRun,
  formatStreamingStatus,
  formatSummary,
  formatWaitingStatus,
  formatWarmupStatus,
  instantTps,
  isWarmingUp,
  shouldRender,
  updateEma,
  NO_DATA_STATUS,
  type ClockMs,
  type MetricRun,
} from "./metrics.ts";
import type { StatusPort } from "./status-port.ts";

export class TokenSpeedController {
  private readonly adapter: PiEventAdapter;
  private run: MetricRun | null = null;

  constructor(adapter: PiEventAdapter) {
    this.adapter = adapter;
  }

  /**
   * 轮次归属判定：两侧 id 均为空（未知）或任一为空视为同一轮；
   * 仅当两侧都是真实 id 且不同才判定为跨轮（pi 串行流下不应发生）。
   */
  private matches(runId: string, eventId: string): boolean {
    return runId === "" || eventId === "" || runId === eventId;
  }

  /** 收编事件携带的真实 responseId，让后续事件能精确匹配本 Run。 */
  private adoptId(run: MetricRun, eventId: string): void {
    if (run.messageId === "" && eventId !== "") {
      run.messageId = eventId;
    }
  }

  /** message_start：仅 assistant 消息创建轮次；立即替换上一轮展示。 */
  onMessageStart(event: unknown, status: StatusPort): void {
    if (!status.available()) return;
    const start = this.adapter.onAssistantStart(event);
    if (start === null) return;
    this.run = createRun(start.messageId, start.at);
    status.setStatus("stream-token-speed", formatWaitingStatus());
  }

  /** message_update：仅可计量 delta 计数；250ms 节流刷新（v4：热身期后 EMA 平滑）。 */
  onMessageUpdate(event: unknown, status: StatusPort): void {
    const delta = this.adapter.onEligibleTokenDelta(event);
    if (delta === null) return;
    const run = this.run;
    if (run === null) return;
    // 兜底轮次隔离：真实 provider 的 responseId 稳定时可精确匹配，
    // 未出现 responseId 时视为同轮（见文件头注释）。
    if (!this.matches(run.messageId, delta.messageId)) return;
    this.adoptId(run, delta.messageId);
    addEligibleDelta(run, delta.source, delta.at);
    if (!shouldRender(run, delta.at)) return;
    // v4 热身期：首个可计量增量后的前 1s，瞬时速度保持 `—` 不更新（首个
    // 刷新点把 TTFT 从“等待中”推进到确定值后不再重复渲染），也暂不播种
    // EMA，避免未满窗口把首波突发放大成峰值。
    if (isWarmingUp(run, delta.at)) {
      if (run.lastRenderAt === undefined) {
        run.lastRenderAt = delta.at;
        this.renderStreaming(run, status, delta.at);
      }
      return;
    }
    // 满 1s 后：以首个完整 1s 窗口值为 EMA 种子，之后每次刷新点平滑更新。
    run.lastRenderAt = delta.at;
    run.lastInstantTps = updateEma(run, instantTps(run, delta.at));
    this.renderStreaming(run, status, delta.at);
  }

  /** message_end：有样本 -> 汇总；无样本 -> 无流式速度数据；随后停止刷新。 */
  onMessageEnd(event: unknown, status: StatusPort): void {
    const end = this.adapter.onAssistantEnd(event);
    if (end === null) return;
    const run = this.run;
    if (run === null) return;
    if (!this.matches(run.messageId, end.messageId)) return;
    this.adoptId(run, end.messageId);
    const summary = computeSummary(run, end.at);
    this.run = null;
    if (!status.available()) return;
    if (summary.hasStreamingData) {
      status.setStatus("stream-token-speed", formatSummary(summary));
    } else {
      status.setStatus("stream-token-speed", NO_DATA_STATUS);
    }
  }

  private renderStreaming(run: MetricRun, status: StatusPort, now: ClockMs): void {
    if (!status.available()) return;
    const first = run.firstEligibleDeltaAt;
    if (first === undefined) {
      status.setStatus("stream-token-speed", formatWaitingStatus());
      return;
    }
    const ttft = Math.round(first - run.startAt);
    if (isWarmingUp(run, now)) {
      // v4 热身期：TTFT 已确定，瞬时速度保持 `—`。
      status.setStatus("stream-token-speed", formatWarmupStatus(ttft));
      return;
    }
    status.setStatus(
      "stream-token-speed",
      formatStreamingStatus(ttft, run.lastInstantTps ?? 0),
    );
  }
}
