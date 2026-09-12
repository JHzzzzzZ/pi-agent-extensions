/**
 * run-timer — 对齐墙钟秒边界的节拍器（跨插件契约 docs/cross/status-bar.md）。
 *
 * 各扩展的状态条刷新源此前各跑各的 `setInterval`，相位互不相关：
 * 同一秒内多个 widget/footer 段分先后重绘，顺序与挤占看起来"每秒在变"。
 * 统一改为对齐同一墙钟节拍（默认 1s）后，同一帧内各段一起刷新。
 *
 * 实现要点：首跳延迟 `intervalMs - (now() % intervalMs)`，此后每次回调
 * 都按实际时钟重算下一跳（自校正，不累积漂移）；回调异常必须吞掉——
 * 定时器回调抛错会冒泡成宿主未捕获异常。各插件各持一份，保持单目录
 * 可复制安装（不跨插件共享）。
 */

export interface AlignedTickerOptions {
  /** 节拍间隔，默认 1000ms。 */
  intervalMs?: number;
  /** 墙钟源（测试注入）；默认 Date.now。 */
  now?: () => number;
}

/**
 * 启动对齐节拍器，返回幂等的停止函数。
 * 回调只在下一跳到期时执行；`stop()` 后不再有任何排跳。
 */
export function startAlignedTicker(fn: () => void, options: AlignedTickerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? Date.now;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const remainder = now() % intervalMs;
    const delay = remainder === 0 ? intervalMs : intervalMs - remainder;
    handle = setTimeout(() => {
      // 先排下一跳再执行回调：回调内调用 stop() 也能把已排的下一跳清掉；
      // 回调抛错不落入宿主，更不中断节拍。
      schedule();
      try {
        fn();
      } catch {
        /* 回调异常只影响本跳 */
      }
    }, delay);
    // 不阻止宿主进程退出（保留 agent-team 原 setInterval().unref() 语义）。
    if (handle !== undefined && typeof (handle as { unref?: unknown }).unref === "function") {
      (handle as unknown as { unref: () => void }).unref();
    }
  };

  schedule();

  return (): void => {
    stopped = true;
    if (handle !== undefined) {
      clearTimeout(handle);
      handle = undefined;
    }
  };
}
