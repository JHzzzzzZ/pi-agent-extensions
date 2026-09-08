/**
 * loop — Pi 定时任务扩展（精简版 /loop，参考 Claude Code scheduled tasks）：
 *   /loop 5m <任务>        固定间隔循环
 *   /loop in 30m <任务>    一次性提醒（相对时间）
 *   /loop at 15:00 <任务>  一次性提醒（本地时刻）
 *   /loop daily at 09:00 <任务>                每天固定时刻循环
 *   /loop every 1h from 00:00 to 09:00 <任务>  每日时间窗口内按间隔循环（闭区间）
 *   /loop --bg <上述任意创建形态>  v1.3：后台模式
 *   /loop list | pause <id> | resume <id> | delete <id> | clear
 *
 * agent 工具（tools.ts）：loop_create / loop_list / loop_delete，
 * 供模型用自然语言创建与管理定时任务。
 *
 * 到期任务经 pi.sendMessage(deliverAs: "followUp") 在回合间送达：
 * agent 空闲则开新 turn，正在响应则排队到当前 turn 结束。
 * 任务以全量快照持久化为自定义会话条目（loop-tasks-v1），随会话恢复；
 * 自定义条目不进入 LLM 上下文。
 *
 * v1.3 后台模式（--bg / loop_create mode="background"）：到期不注入当前会话，
 * 而是拉起独立子 pi 进程执行（runner.ts：pi --mode json -p --name loop-<id>，
 * 不带 --no-session，会话落盘）；会话 id 从 JSON 输出头部捕获记入任务状态，
 * 用 pi --session <id> 可恢复后台对话记录。同一任务上一轮未跑完则本次跳过；
 * 会话关闭/重载时终止在途子进程并标记 interrupted。
 *
 * 计时器生命周期：session_start 启动（无论有无 UI——调度不能依赖界面）、
 * session_shutdown 清理；模块级 dispose 防 /reload 双实例叠加（同 run-timer）。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoopCommand } from "./parse.ts";
import { runBgAgent, type BgRunOutcome } from "./runner.ts";
import { registerLoopTools } from "./tools.ts";
import {
  clearTasks,
  createTask,
  deleteTask,
  describeRecurrence,
  formatClock,
  formatCountdown,
  formatTaskLines,
  hydrateTasks,
  pauseTask,
  pollDue,
  resumeTask,
  serializeTasks,
  MAX_BG_SUMMARY_LEN,
  type LoopTask,
} from "./tasks.ts";

const WIDGET_ID = "loop";
const TICK_MS = 1000;
const LOOP_TASKS_ENTRY = "loop-tasks-v1";
const LOOP_DUE_CUSTOM_TYPE = "loop-task-due";

const USAGE = [
  "用法：",
  "  /loop 5m <任务>        固定间隔循环（单位 s/m/h/d，最小 1m）",
  "  /loop in 30m <任务>    一次性提醒（相对时间）",
  "  /loop at 15:00 <任务>  一次性提醒（本地时刻，已过则排到明天）",
  "  /loop daily at 09:00 <任务>  每天固定时刻循环",
  "  /loop every 1h from 00:00 to 09:00 <任务>  每日窗口内按间隔循环（闭区间）",
  "  /loop --bg 5m <任务>   后台模式：拉起独立 pi 进程执行，会话可用 pi --session <id> 恢复",
  "  /loop list             查看全部任务",
  "  /loop pause <id>       暂停任务",
  "  /loop resume <id>      恢复任务",
  "  /loop delete <id>      删除任务",
  "  /loop clear            删除全部任务",
].join("\n");

/** 后台运行注入点：测试替换为假实现；默认拉起真实子 pi 进程（runner.ts） */
export interface LoopBgOverrides {
  runBg?: (opts: { taskId: string; prompt: string; cwd?: string; signal?: AbortSignal }) => Promise<BgRunOutcome>;
}

interface BgEntry {
  controller: AbortController;
  startedAt: number;
  aborted: boolean;
}

let dispose: (() => void) | undefined;

export default function (pi: ExtensionAPI, overrides?: LoopBgOverrides) {
  dispose?.();

  const ownDispose = () => stopSession();

  const tasks: LoopTask[] = [];
  const bgEntries = new Map<string, BgEntry>();
  const runBg = overrides?.runBg ?? ((opts: { taskId: string; prompt: string; cwd?: string; signal?: AbortSignal }) => runBgAgent(opts));
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let savedCtx: ExtensionContext | undefined;

  const genId = () => crypto.randomUUID().slice(0, 8);

  function persist(): void {
    try {
      pi.appendEntry(LOOP_TASKS_ENTRY, serializeTasks(tasks));
    } catch {
      // 持久化失败绝不破坏会话
    }
  }

  function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // 通知失败不影响任务状态
    }
  }

  /** 宿主会话工作目录：后台子 pi 的 cwd，保证会话落在该项目、pi -r 选择器可见 */
  function safeCwd(): string | undefined {
    try {
      return savedCtx?.sessionManager.getCwd();
    } catch {
      return undefined;
    }
  }

  function refreshWidget(): void {
    if (!savedCtx?.hasUI) return;
    try {
      if (tasks.length === 0) {
        savedCtx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
      const active = tasks.filter((t) => !t.paused);
      const paused = tasks.length - active.length;
      let line = `⏰ loop ${tasks.length} 个任务`;
      if (paused > 0) line += `（${paused} 个已暂停）`;
      if (active.length > 0) {
        const nextAt = Math.min(...active.map((t) => t.nextDueAt));
        line += ` · 下次 ${formatCountdown(nextAt - Date.now())}`;
      }
      if (bgEntries.size > 0) line += ` · 后台运行 ${bgEntries.size}`;
      savedCtx.ui.setWidget(WIDGET_ID, [line]);
    } catch {
      // widget 失败不影响调度
    }
  }

  function stopSession(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    // v1.3：终止在途后台子进程，任务标记 interrupted（子进程的会话文件仍在，可 resume 查看）
    if (bgEntries.size > 0) {
      for (const [id, entry] of bgEntries) {
        entry.aborted = true;
        const live = tasks.find((t) => t.id === id);
        if (live) {
          live.lastRun = {
            startedAt: entry.startedAt,
            finishedAt: Date.now(),
            status: "interrupted",
            ...(live.lastRun?.sessionId ? { sessionId: live.lastRun.sessionId } : {}),
            ...(live.lastRun?.sessionPath ? { sessionPath: live.lastRun.sessionPath } : {}),
            summary: "会话结束，后台任务被终止",
          };
        }
        entry.controller.abort();
      }
      bgEntries.clear();
      persist();
    }
    if (savedCtx?.hasUI) {
      try {
        savedCtx.ui.setWidget(WIDGET_ID, undefined);
      } catch {
      }
    }
    savedCtx = undefined;
  }

  function deliver(due: LoopTask[]): void {
    for (const t of due) {
      try {
        if (t.background) {
          startBgRun(t);
          continue;
        }
        pi.sendMessage(
          {
            customType: LOOP_DUE_CUSTOM_TYPE,
            content: `[loop ${t.id}] 定时任务触发，请执行：\n\n${t.task}`,
            display: true,
            details: { loopId: t.id, recurring: t.recurring },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // 单条送达失败不影响其余任务
      }
    }
  }

  function bgDoneMessage(id: string, outcome: BgRunOutcome): string {
    const session = outcome.sessionId
      ? `会话 ${outcome.sessionId}（pi --session ${outcome.sessionId} 恢复查看）`
      : "（未捕获会话 id）";
    const summary = outcome.summary.length > 200 ? `${outcome.summary.slice(0, 199)}…` : outcome.summary;
    if (outcome.status === "done") return `loop ${id} 后台完成 · ${session}\n结果：${summary}`;
    if (outcome.status === "timeout") return `loop ${id} 后台运行超时被终止 · ${session}\n部分结果：${summary}`;
    return `loop ${id} 后台运行失败（退出码 ${outcome.exitCode ?? "?"}）· ${session}\n输出：${summary}`;
  }

  function startBgRun(t: LoopTask): void {
    if (bgEntries.has(t.id)) {
      notify(savedCtx, `loop ${t.id} 上一轮后台仍在运行，本次触发跳过`, "warning");
      return;
    }
    const startedAt = Date.now();
    t.lastRun = { startedAt, status: "running" };
    persist();
    const entry: BgEntry = { controller: new AbortController(), startedAt, aborted: false };
    bgEntries.set(t.id, entry);
    refreshWidget();
    notify(savedCtx, `loop ${t.id} 已转后台执行，完成后通知（会话可用 pi --session 恢复查看）`);
    runBg({ taskId: t.id, prompt: t.task, cwd: safeCwd(), signal: entry.controller.signal })
      .then((outcome) => finishBgRun(t.id, entry, outcome))
      .catch((err) => {
        bgEntries.delete(t.id);
        const live = tasks.find((x) => x.id === t.id);
        if (live && !entry.aborted) {
          live.lastRun = {
            startedAt: entry.startedAt,
            finishedAt: Date.now(),
            status: "failed",
            summary: String(err).slice(0, MAX_BG_SUMMARY_LEN),
          };
          persist();
        }
        if (!entry.aborted) {
          notify(savedCtx, `loop ${t.id} 后台运行异常：${err instanceof Error ? err.message : String(err)}`, "error");
        }
      });
  }

  function finishBgRun(id: string, entry: BgEntry, outcome: BgRunOutcome): void {
    bgEntries.delete(id);
    const live = tasks.find((x) => x.id === id);
    // aborted 的记录已由 stopSession 写为 interrupted；被删除/过期清除的任务只剩通知
    if (live && !entry.aborted) {
      live.lastRun = {
        startedAt: entry.startedAt,
        finishedAt: Date.now(),
        status: outcome.status,
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.sessionPath ? { sessionPath: outcome.sessionPath } : {}),
        summary: outcome.summary,
      };
      persist();
      refreshWidget();
    }
    if (entry.aborted) return;
    notify(savedCtx, bgDoneMessage(id, outcome), outcome.status === "done" ? "info" : "warning");
  }

  function tick(): void {
    const now = Date.now();
    const { due, changed } = pollDue(tasks, now);
    if (changed) {
      // 触发/过期都会改变 nextDueAt 或任务集合，先落盘再送达
      persist();
      deliver(due);
    }
    refreshWidget();
  }

  function runCommand(args: string, ctx: ExtensionCommandContext): void {
    const parsed = parseLoopCommand(args, Date.now());
    if (!parsed.ok) {
      notify(ctx, parsed.message, "warning");
      return;
    }
    const cmd = parsed.value;
    switch (cmd.kind) {
      case "usage": {
        const lines = formatTaskLines(tasks, Date.now());
        notify(ctx, lines.length > 0 ? `${USAGE}\n\n当前任务：\n${lines.join("\n")}` : USAGE);
        return;
      }
      case "list": {
        const lines = formatTaskLines(tasks, Date.now());
        notify(ctx, lines.length > 0 ? `当前 ${tasks.length} 个任务：\n${lines.join("\n")}` : "没有定时任务。用 /loop 5m <任务> 创建。");
        return;
      }
      case "create": {
        const spec = cmd.spec;
        const now = Date.now();
        const result = createTask(
          tasks,
          {
            task: spec.task,
            recurring: spec.recurring,
            intervalMs: spec.intervalMs,
            schedule: spec.schedule,
            background: spec.background,
            fireAtMs: spec.fireAtMs ?? (spec.recurring ? now + (spec.intervalMs ?? 0) : now),
            nowMs: now,
          },
          genId,
        );
        if (!result.ok) {
          notify(ctx, result.message, "warning");
          return;
        }
        persist();
        refreshWidget();
        const t = result.task;
        notify(
          ctx,
          `已创建 loop ${t.id}：${describeRecurrence(spec)}${spec.background ? " · 后台执行" : ""} · 下次 ${formatClock(t.nextDueAt)} · ${t.task}`,
        );
        return;
      }
      case "pause": {
        const result = pauseTask(tasks, cmd.id);
        if (!result.ok) {
          notify(ctx, result.message, "warning");
          return;
        }
        persist();
        refreshWidget();
        notify(ctx, `已暂停 loop ${result.task.id}：${result.task.task}`);
        return;
      }
      case "resume": {
        const result = resumeTask(tasks, cmd.id, Date.now());
        if (!result.ok) {
          notify(ctx, result.message, "warning");
          return;
        }
        persist();
        refreshWidget();
        notify(ctx, `已恢复 loop ${result.task.id}：下次 ${formatClock(result.task.nextDueAt)} · ${result.task.task}`);
        return;
      }
      case "delete": {
        const result = deleteTask(tasks, cmd.id);
        if (!result.ok) {
          notify(ctx, result.message, "warning");
          return;
        }
        persist();
        refreshWidget();
        notify(ctx, `已删除 loop ${result.task.id}：${result.task.task}`);
        return;
      }
      case "clear": {
        const n = clearTasks(tasks);
        persist();
        refreshWidget();
        notify(ctx, n > 0 ? `已删除全部 ${n} 个任务` : "没有可删除的任务。");
        return;
      }
    }
  }

  pi.registerCommand("loop", {
    description: "定时循环任务：固定间隔 / 每天定时 / 每日窗口循环 + 一次性提醒；--bg 后台模式拉起独立 pi 进程（list/pause/resume/delete/clear 管理）",
    getArgumentCompletions: (prefix) => {
      const items = ["list", "pause ", "resume ", "delete ", "clear", "in ", "at ", "daily ", "every day ", "every 1h from ", "--bg "];
      return items
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s.trim() }));
    },
    handler: async (args, ctx) => {
      try {
        runCommand(args, ctx);
      } catch (e) {
        notify(ctx, `执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  registerLoopTools(pi, { tasks, genId, persist, refreshWidget });

  pi.on("session_start", async (_event, ctx) => {
    stopSession();
    savedCtx = ctx;

    // 恢复会话条目：取最后一条快照（旧快照被新快照覆盖）
    let snapshot: unknown;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const e = entry as { type?: string; customType?: string; data?: unknown };
        if (e.type === "custom" && e.customType === LOOP_TASKS_ENTRY) snapshot = e.data;
      }
    } catch {
      snapshot = undefined;
    }
    tasks.length = 0;
    tasks.push(...hydrateTasks(snapshot, Date.now()));

    // hydrate 剔除了过期/失效任务时，把清洗后的快照写回
    if (snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(serializeTasks(tasks))) {
      persist();
    }

    refreshWidget();
    tickTimer = setInterval(tick, TICK_MS);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopSession();
    if (dispose === ownDispose) dispose = undefined;
  });

  dispose = ownDispose;
}
