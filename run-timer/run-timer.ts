import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "run-timer";
const TICK_MS = 1000;

export interface TimerState {
  sessionTotalMs: number;
  currentTask?: { id: string; startedAt: number };
  currentTurn?: { startedAt: number };
  lastTask?: { durationMs: number };
  accountedTaskIds: Set<string>;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 0) return "00:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x2E80 && cp <= 0x2EFF) ||
    (cp >= 0x3000 && cp <= 0x303F) ||
    cp === 0x3000
  );
}

export function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += isCJK(ch) ? 2 : 1;
  return n;
}

export function truncateVisual(text: string, maxVisual: number): string {
  if (visualLen(text) <= maxVisual) return text;
  let result = "";
  let w = 0;
  for (const ch of text) {
    const cw = isCJK(ch) ? 2 : 1;
    if (w + cw > maxVisual - 1) break;
    result += ch;
    w += cw;
  }
  return result + "…";
}

export function buildDisplayLine(state: TimerState, nowMs: number, maxWidth: number): string {
  const parts: string[] = [];

  const activeTaskMs = state.currentTask ? nowMs - state.currentTask.startedAt : 0;

  if (state.currentTask) {
    parts.push(`任务 ${formatDuration(activeTaskMs)}`);
  } else if (state.lastTask) {
    parts.push(`上次任务 ${formatDuration(state.lastTask.durationMs)}（已结束）`);
  }

  if (state.currentTurn) {
    const turnElapsed = nowMs - state.currentTurn.startedAt;
    parts.push(`本轮 ${formatDuration(turnElapsed)}`);
  } else {
    parts.push("本轮 00:00");
  }

  const displaySessionMs = state.sessionTotalMs + (state.currentTask ? activeTaskMs : 0);
  parts.push(`本会话 ${formatDuration(displaySessionMs)}`);

  let line = parts.join(" · ");

  if (visualLen(line) > maxWidth) {
    const sessionPart = `本会话 ${formatDuration(displaySessionMs)}`;
    const otherParts = parts.slice(0, -1);
    const prefix = otherParts.join(" · ") + " · ";
    const avail = maxWidth - visualLen(sessionPart) - 3;
    if (avail <= 0) {
      return truncateVisual(sessionPart, maxWidth);
    }
    const truncatedPrefix = truncateVisual(prefix, avail - 1) + "…";
    line = truncatedPrefix + " · " + sessionPart;
  }

  return line;
}

function now(): number {
  return performance.now();
}

let dispose: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
  dispose?.();

  const ownDispose = () => stopWidget();

  const state: TimerState = {
    sessionTotalMs: 0,
    accountedTaskIds: new Set(),
  };

  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let savedCtx: ExtensionContext | undefined;

  function flushWidget(): void {
    if (!savedCtx || !savedCtx.hasUI) return;
    try {
      const maxWidth = process.stdout.columns ?? 80;
      const line = buildDisplayLine(state, now(), maxWidth);
      savedCtx.ui.setWidget(WIDGET_ID, [savedCtx.ui.theme.fg("dim", line)]);
    } catch {
      stopWidget();
    }
  }

  function stopWidget(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    if (savedCtx?.hasUI) {
      try {
        savedCtx.ui.setWidget(WIDGET_ID);
      } catch {
      }
    }
    savedCtx = undefined;
  }

  function settleTask(): void {
    if (!state.currentTask) return;
    const id = state.currentTask.id;
    if (state.accountedTaskIds.has(id)) return;

    const elapsed = now() - state.currentTask.startedAt;
    state.lastTask = { durationMs: elapsed };
    state.sessionTotalMs += elapsed;
    state.accountedTaskIds.add(id);
    state.currentTask = undefined;
  }

  pi.on("session_start", async (_e, ctx) => {
    stopWidget();

    state.sessionTotalMs = 0;
    state.currentTask = undefined;
    state.currentTurn = undefined;
    state.lastTask = undefined;
    state.accountedTaskIds.clear();

    savedCtx = ctx;

    if (ctx.hasUI) {
      flushWidget();
      tickTimer = setInterval(() => flushWidget(), TICK_MS);
    }
  });

  pi.on("agent_start", async (_e, _ctx) => {
    if (!state.currentTask) {
      state.currentTask = { id: crypto.randomUUID(), startedAt: now() };
    }
    flushWidget();
  });

  pi.on("turn_start", async (_e, _ctx) => {
    state.currentTurn = { startedAt: now() };
    flushWidget();
  });

  pi.on("turn_end", async (_e, _ctx) => {
    state.currentTurn = undefined;
    flushWidget();
  });

  pi.on("agent_settled", async (_e, _ctx) => {
    settleTask();
    flushWidget();
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    if (state.currentTask) {
      settleTask();
    }
    stopWidget();
    if (dispose === ownDispose) dispose = undefined;
  });

  dispose = ownDispose;
}
