/**
 * loop — Pi 定时任务扩展（精简版 /loop，参考 Claude Code scheduled tasks）：
 *   /loop 5m <任务>        固定间隔循环
 *   /loop in 30m <任务>    一次性提醒（相对时间）
 *   /loop at 15:00 <任务>  一次性提醒（本地时刻）
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
 * 计时器生命周期：session_start 启动（无论有无 UI——调度不能依赖界面）、
 * session_shutdown 清理；模块级 dispose 防 /reload 双实例叠加（同 run-timer）。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseLoopCommand, formatInterval, type CreateSpec } from "./parse.ts";
import { registerLoopTools } from "./tools.ts";
import {
  clearTasks,
  createTask,
  deleteTask,
  formatClock,
  formatCountdown,
  formatTaskLines,
  hydrateTasks,
  pauseTask,
  pollDue,
  resumeTask,
  serializeTasks,
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
  "  /loop list             查看全部任务",
  "  /loop pause <id>       暂停任务",
  "  /loop resume <id>      恢复任务",
  "  /loop delete <id>      删除任务",
  "  /loop clear            删除全部任务",
].join("\n");

let dispose: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
  dispose?.();

  const ownDispose = () => stopSession();

  const tasks: LoopTask[] = [];
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

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // 通知失败不影响任务状态
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

  function describeSpec(spec: CreateSpec): string {
    return spec.recurring ? `每 ${formatInterval(spec.intervalMs ?? 0)}` : "一次性";
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
        const result = createTask(
          tasks,
          {
            task: spec.task,
            recurring: spec.recurring,
            intervalMs: spec.intervalMs,
            fireAtMs: spec.recurring ? Date.now() + (spec.intervalMs ?? 0) : (spec.fireAtMs ?? Date.now()),
            nowMs: Date.now(),
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
        notify(ctx, `已创建 loop ${t.id}：${describeSpec(spec)} · 下次 ${formatClock(t.nextDueAt)} · ${t.task}`);
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
    description: "定时循环任务：固定间隔循环 + 一次性提醒（list/pause/resume/delete/clear 管理）",
    getArgumentCompletions: (prefix) => {
      const items = ["list", "pause ", "resume ", "delete ", "clear", "in ", "at "];
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
