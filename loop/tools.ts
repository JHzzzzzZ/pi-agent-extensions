/**
 * loop — agent 可调用的工具（对齐 Claude Code 的 CronCreate/CronList/CronDelete）：
 *   loop_create  创建定时任务（循环或一次性提醒）
 *   loop_list    列出当前会话的全部任务
 *   loop_delete  删除任务（id 支持前缀匹配）
 *
 * 工具直接操作 index.ts 注入的任务状态：变更后由 deps.persist() 落盘、
 * deps.refreshWidget() 刷新 widget；结果以文本返回给模型，失败置 isError。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSchedule, formatInterval } from "./parse.ts";
import { createTask, deleteTask, formatClock, formatTaskLines, MAX_TASK_LEN, type LoopTask } from "./tasks.ts";

export interface LoopToolDeps {
  tasks: LoopTask[];
  genId: () => string;
  persist: () => void;
  refreshWidget: () => void;
}

const SCHEDULE_HINT =
  '调度描述："every 5m" / "5m" / "2 hours"（循环，最小 1 分钟）或 "in 30m"（延时一次性）或 "at 15:00"（本地时刻一次性，已过则排到明天）';

export function registerLoopTools(pi: ExtensionAPI, deps: LoopToolDeps): void {
  pi.registerTool({
    name: "loop_create",
    label: "Loop Create",
    description: [
      "创建一个定时任务（本会话内有效）：到时把任务内容作为消息注入当前会话，由主 agent 执行。",
      `task 为到期后要执行的内容；schedule 描述触发时机。${SCHEDULE_HINT}。`,
      "适合\"每 N 分钟检查一次 X\"、\"30 分钟后提醒我\"、\"明天 9 点做 X\"这类请求。",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ description: "到期后要执行的任务描述", minLength: 1, maxLength: MAX_TASK_LEN }),
      schedule: Type.String({ description: SCHEDULE_HINT }),
    }),
    async execute(_toolCallId, params) {
      const schedule = parseSchedule(params.schedule, Date.now());
      if (!schedule.ok) {
        return { content: [{ type: "text", text: schedule.message }], details: undefined, isError: true };
      }
      const spec = schedule.value;
      const result = createTask(
        deps.tasks,
        {
          task: params.task,
          recurring: spec.recurring,
          intervalMs: spec.recurring ? spec.intervalMs : undefined,
          fireAtMs: spec.recurring ? Date.now() + spec.intervalMs : spec.fireAtMs,
          nowMs: Date.now(),
        },
        deps.genId,
      );
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], details: undefined, isError: true };
      }
      deps.persist();
      deps.refreshWidget();
      const t = result.task;
      const when = t.recurring ? `每 ${formatInterval(t.intervalMs ?? 0)}` : "一次性";
      return {
        content: [{ type: "text", text: `已创建 loop ${t.id}：${when} · 下次 ${formatClock(t.nextDueAt)} · ${t.task}` }],
        details: { loopId: t.id, recurring: t.recurring, nextDueAt: t.nextDueAt },
      };
    },
  });

  pi.registerTool({
    name: "loop_list",
    label: "Loop List",
    description: "列出当前会话的全部定时任务（id、类型、下次触发时刻、任务内容）。",
    parameters: Type.Object({}),
    async execute() {
      if (deps.tasks.length === 0) {
        return { content: [{ type: "text", text: "没有定时任务。" }], details: { count: 0 } };
      }
      const lines = formatTaskLines(deps.tasks, Date.now());
      return {
        content: [{ type: "text", text: `当前 ${deps.tasks.length} 个任务：\n${lines.join("\n")}` }],
        details: { count: deps.tasks.length },
      };
    },
  });

  pi.registerTool({
    name: "loop_delete",
    label: "Loop Delete",
    description: "删除一个定时任务。id 可以是完整 id 或唯一前缀；用 loop_list 查看现有任务。",
    parameters: Type.Object({
      id: Type.String({ description: "任务 id 或唯一前缀", minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      const result = deleteTask(deps.tasks, params.id);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], details: undefined, isError: true };
      }
      deps.persist();
      deps.refreshWidget();
      return {
        content: [{ type: "text", text: `已删除 loop ${result.task.id}：${result.task.task}` }],
        details: { loopId: result.task.id },
      };
    },
  });
}
