/**
 * 度量层：本轮流式输出的 TTFT / 瞬时速度 / 平均速度计算。
 *
 * 契约见 JHL-10-Design-v4.md §3（状态与计算契约，v4 口径）：
 * - 瞬时速度：当前时刻向前最多 1,000ms 的可计量增量总数 / 实际观察窗口秒数
 *   （1s 滑动窗口原始值），再经 EMA 平滑（α=0.3）输出，渲染节流仍为 250ms；
 *   EMA 仅在合格渲染点更新，无增量期间保持上次值。
 * - 热身期（v4）：首个可计量增量后的前 1,000ms（首个 1s 窗口未填满）内，
 *   瞬时速度保持显示 `—` 不更新（避免未满窗口把首波突发放大成峰值）；
 *   满 1s 后以首个完整 1s 窗口值作为 EMA 种子开始更新。
 * - 渲染节流：距上次渲染至少 250ms 才算合格刷新点。
 * - 平均速度：总增量 / 有效流式时长。有效流式时长 =（最后一个可计量增量
 *   时刻 − 首个可计量增量时刻），即「首 token → message_end」区间扣除
 *   末端无输出/工具执行间隙；消息间的工具执行本就不计入消息时长。
 * - 结束汇总：末尾 1s 窗口无输出（瞬时原始值为 0）时，「最后」沿用最近
 *   一次渲染的非零平滑值并以 ~ 前缀标注（热身期未完成且无种子时退回
 *   有效时长平均，恒非零）；有输出时按末尾原始值更新/播种 EMA。
 *
 * 本模块为纯函数/纯数据结构，不依赖 pi API，便于注入时钟做单元测试。
 * 所有时间必须来自同一单调时钟（默认 performance.now）。
 */

export type ClockMs = number;
export type EligibleSource = "text" | "thinking" | "tool_call";

export interface Sample {
  at: ClockMs;
  count: 1;
  source: EligibleSource;
}

export interface MetricRun {
  messageId: string;
  startAt: ClockMs;
  firstEligibleDeltaAt?: ClockMs;
  lastEligibleDeltaAt?: ClockMs;
  totalEligibleTokens: number;
  /** 仅保留过去 1,000ms 的样本，保证长回复内存有界。 */
  samples: Sample[];
  lastRenderAt?: ClockMs;
  /** 最近一次渲染的 EMA 平滑瞬时值（渲染仅在增量到达时发生，恒非零）。 */
  lastInstantTps?: number;
  /** EMA 平滑状态（α=0.3），未渲染前为 undefined。 */
  emaTps?: number;
}

export interface CompletedSummary {
  ttftMs: number;
  lastInstantTps: number;
  averageTps: number;
  hasStreamingData: boolean;
  /** 末尾 1s 窗口无输出，「最后」沿用了最近非零值（显示时以 ~ 标注）。 */
  lastInstantCarried: boolean;
}

export const WINDOW_MS = 1000;
export const THROTTLE_MS = 250;
/** EMA 平滑系数（α≈0.3，口径见 PRD/Design v4）。 */
export const EMA_ALPHA = 0.3;
/** 热身期时长：首个可计量增量后的前 1s 内瞬时速度保持 `—`（v4）。 */
export const WARMUP_MS = 1000;
/** 最小时间分母（秒），防止除零 / NaN / Infinity。 */
const MIN_SECONDS = 0.001;

export function createRun(messageId: string, startAt: ClockMs): MetricRun {
  return {
    messageId,
    startAt,
    totalEligibleTokens: 0,
    samples: [],
  };
}

/** 计入一个可计量流增量（text / thinking / tool_call）。首次到达同时确定 TTFT 起点。 */
export function addEligibleDelta(
  run: MetricRun,
  source: EligibleSource,
  at: ClockMs,
): void {
  if (run.firstEligibleDeltaAt === undefined) {
    run.firstEligibleDeltaAt = at;
  }
  run.lastEligibleDeltaAt = at;
  run.totalEligibleTokens += 1;
  run.samples.push({ at, count: 1, source });
  // 清理窗口外样本：samples 按时间单调追加，从头部弹出即可，均摊 O(1)。
  const cutoff = at - WINDOW_MS;
  while (run.samples.length > 0 && run.samples[0].at < cutoff) {
    run.samples.shift();
  }
}

/** 滑动窗口瞬时速度原始值（tok/s）。无可计量增量时返回 0。 */
export function instantTps(run: MetricRun, now: ClockMs): number {
  if (run.firstEligibleDeltaAt === undefined) return 0;
  const windowStart = Math.max(run.firstEligibleDeltaAt, now - WINDOW_MS);
  const windowSeconds = Math.max((now - windowStart) / 1000, MIN_SECONDS);
  let count = 0;
  for (const s of run.samples) {
    if (s.at >= windowStart) count += s.count;
  }
  return count / windowSeconds;
}

/**
 * EMA 平滑更新（α=0.3）：新值 = α×原始值 + (1−α)×旧值；首个原始值直接作为种子。
 * 仅在合格渲染点调用；无增量期间不调用，平滑值保持，避免跌到 0。
 */
export function updateEma(run: MetricRun, rawTps: number): number {
  run.emaTps = run.emaTps === undefined ? rawTps : EMA_ALPHA * rawTps + (1 - EMA_ALPHA) * run.emaTps;
  return run.emaTps;
}

/**
 * 有效流式时长（秒，v3）：最后一个可计量增量 − 首个可计量增量，
 * 最小分母 1ms。末尾的无输出/工具执行间隙（message_end 前）不占用该时长。
 */
export function effectiveStreamingSeconds(run: MetricRun): number {
  if (run.firstEligibleDeltaAt === undefined || run.lastEligibleDeltaAt === undefined) {
    return MIN_SECONDS;
  }
  return Math.max((run.lastEligibleDeltaAt - run.firstEligibleDeltaAt) / 1000, MIN_SECONDS);
}

/**
 * 是否处于热身期（v4）：首个可计量增量后的前 WARMUP_MS 内，瞬时速度
 * 保持 `—` 不更新，满 1s 后才以首个完整窗口值播种 EMA。
 */
export function isWarmingUp(run: MetricRun, now: ClockMs): boolean {
  return (
    run.firstEligibleDeltaAt !== undefined &&
    now >= run.firstEligibleDeltaAt &&
    now - run.firstEligibleDeltaAt < WARMUP_MS
  );
}

/** 是否到达 250ms 节流的合格刷新点。 */
export function shouldRender(run: MetricRun, now: ClockMs): boolean {
  return run.lastRenderAt === undefined || now - run.lastRenderAt >= THROTTLE_MS;
}

/**
 * 结束汇总：有样本时补算最后瞬时与平均速度；无样本时返回 hasStreamingData=false，
 * 由渲染层输出“无流式速度数据”，绝不输出 0 tok/s。
 * 末尾 1s 窗口无输出时，「最后」沿用最近渲染的非零平滑值并置 lastInstantCarried
 * （显示层以 ~ 前缀标注）；热身期未完成（EMA 无种子）时退回有效时长平均，
 * 保证恒非零。
 */
export function computeSummary(run: MetricRun, endAt: ClockMs): CompletedSummary {
  if (run.firstEligibleDeltaAt === undefined || run.totalEligibleTokens === 0) {
    return {
      ttftMs: 0,
      lastInstantTps: 0,
      averageTps: 0,
      hasStreamingData: false,
      lastInstantCarried: false,
    };
  }
  const ttftMs = Math.round(run.firstEligibleDeltaAt - run.startAt);
  const averageTps = run.totalEligibleTokens / effectiveStreamingSeconds(run);
  const endRawTps = instantTps(run, endAt);
  let lastInstantTps: number;
  let lastInstantCarried: boolean;
  if (endRawTps > 0) {
    lastInstantTps = updateEma(run, endRawTps);
    lastInstantCarried = false;
  } else {
    lastInstantTps = run.emaTps ?? run.lastInstantTps ?? averageTps;
    lastInstantCarried = true;
  }
  return { ttftMs, lastInstantTps, averageTps, hasStreamingData: true, lastInstantCarried };
}

/** 速率显示：一位小数。 */
export function formatTps(tps: number): string {
  return `${tps.toFixed(1)} tok/s`;
}

/** 生成中（TTFT 未确定）。 */
export function formatWaitingStatus(): string {
  return "生成中：TTFT 等待中｜速度 —";
}

/** 生成中（TTFT 已确定）。 */
export function formatStreamingStatus(ttftMs: number, instantTps: number): string {
  return `生成中：TTFT ${ttftMs} ms｜速度 ${formatTps(instantTps)}`;
}

/** 生成中（TTFT 已确定，热身期：速度保持 `—` 不更新，v4）。 */
export function formatWarmupStatus(ttftMs: number): string {
  return `生成中：TTFT ${ttftMs} ms｜速度 —`;
}

/** 结束汇总。末尾瞬时为沿用值时以 ~ 标注（v3）。 */
export function formatSummary(s: CompletedSummary): string {
  const last = s.lastInstantCarried
    ? `最后 ~${formatTps(s.lastInstantTps)}`
    : `最后 ${formatTps(s.lastInstantTps)}`;
  return `TTFT ${s.ttftMs} ms｜${last}｜平均 ${formatTps(s.averageTps)}`;
}

export const NO_DATA_STATUS = "无流式速度数据";
