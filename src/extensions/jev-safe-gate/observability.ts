/**
 * jev-safe-gate — fail-open 放行的可观测性（对齐文档的不可协商要求）
 *
 * 用户明确选了 fail-open（分类器一挂就放行）。代价必须付得起：**门不允许静默失效**。
 * 所以每一次放行都要留下三样东西：
 *   ① 状态条计数 + 最近一次原因（`60:jev-safe-gate` 段，只在有放行时出现，遵循
 *      docs/cross/status-bar.md：带序键、经 status-band 协调前缀）；
 *   ② 本会话首次放行时的一次性 notify（用户不一定盯着 footer）；
 *   ③ 一行日志——**无 UI（headless）时这是唯一通道**（状态条/notify 都无处可写）。
 *
 * 全部 UI/输出调用异常隔离："观测失败也不破坏会话"。
 */
import { FAIL_OPEN_LABELS, type FailOpenReason } from "./gate.ts";

/** footer 键（`60:` 排序带；前缀由 status-band 协调，见 docs/cross/status-bar.md）。 */
export const STATUS_KEY = "60:jev-safe-gate";

export interface ReleaseSink {
  /** 写状态条（undefined = 清段）。 */
  setStatus(text: string | undefined): void;
  notify(text: string): void;
  log(line: string): void;
}

export interface ReleaseObserver {
  count(): number;
  lastReason(): FailOpenReason | undefined;
  record(reason: FailOpenReason, sink: ReleaseSink): void;
  /** 换会话：清零并清掉状态条残留段。 */
  reset(sink: ReleaseSink): void;
}

/** 状态条段文本：计数 + 最近原因（短标签）。 */
export function statusText(count: number, reason: FailOpenReason | undefined): string {
  const label = reason === undefined ? "" : FAIL_OPEN_LABELS[reason];
  return label === "" ? `⚠ jev 放行${count}` : `⚠ jev 放行${count}（${label}）`;
}

/** 首次放行的提示：静态模板，只带原因码与计数。 */
export function notifyText(reason: FailOpenReason, count: number): string {
  return `jev-safe-gate：Jev 判断不可用（${reason}），命令已放行；本会话累计放行 ${count} 次（状态条与日志持续记录）。`;
}

/** 日志行（headless 下的证据）：静态模板，不含命令原文。 */
export function logLine(reason: FailOpenReason, count: number): string {
  return `[jev-safe-gate] fail-open #${count} reason=${reason}: Jev judgement unavailable, command released unjudged.`;
}

export function createReleaseObserver(): ReleaseObserver {
  let count = 0;
  let last: FailOpenReason | undefined;
  let notified = false;
  return {
    count: () => count,
    lastReason: () => last,
    record(reason: FailOpenReason, sink: ReleaseSink): void {
      count += 1;
      last = reason;
      safe(() => sink.setStatus(statusText(count, reason)));
      if (!notified) {
        notified = true;
        safe(() => sink.notify(notifyText(reason, count)));
      }
      safe(() => sink.log(logLine(reason, count)));
    },
    reset(sink: ReleaseSink): void {
      count = 0;
      last = undefined;
      notified = false;
      safe(() => sink.setStatus(undefined));
    },
  };
}

function safe(run: () => void): void {
  try {
    run();
  } catch {
    /* 观测失败不破坏会话 */
  }
}
