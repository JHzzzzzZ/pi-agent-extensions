/**
 * loop — agent 可调用的工具（对齐 Claude Code 的 CronCreate/CronList/CronDelete）：
 *   loop_create  创建定时任务（循环或一次性提醒；mode="background" 走后台 agent）
 *   loop_list    列出当前会话的全部任务
 *   loop_delete  删除任务（id 支持前缀匹配）
 *
 * 工具直接操作 index.ts 注入的任务状态：变更后由 deps.persist() 落盘、
 * deps.refreshWidget() 刷新 widget；结果以文本返回给模型，失败置 isError。
 *
 * v1.10（pi 1.0 工具面契约）：loop_create / loop_delete 标 `exposure: "model-only"`
 * （建/删定时任务会排期或删掉别人的任务，是典型的风险路径，不给 codemode 脚本调用）；
 * loop_list 保持缺省的 `direct`（脚本最该用的是查询口径），并声明 `outputSchema` +
 * `structuredContent` 作为稳定契约（LoopTaskView，不镜像内部 details）；三个工具同属
 * `namespace: loop`，annotations 供权限门（jev-safe-gate）读。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSchedule } from "./parse.ts";
import {
  BG_HISTORY_DISPLAY,
  createTask,
  deleteTask,
  describeRecurrence,
  formatClock,
  formatTaskLines,
  MAX_TASK_LEN,
  type BgRunRecord,
  type BgRunStatus,
  type LoopTask,
} from "./tasks.ts";

export interface LoopToolDeps {
  tasks: LoopTask[];
  genId: () => string;
  persist: () => void;
  refreshWidget: () => void;
}

/** codemode 按 namespace 分组工具，并可用 describeNamespace("loop") 读它（general-todo#20） */
const NAMESPACE = { name: "loop", description: "会话内定时任务" };

const SCHEDULE_HINT =
  '调度描述："every 5m" / "5m" / "2 hours"（固定间隔循环，最小 1 分钟）、"daily at 09:00"（每天固定时刻循环）、"every 1h from 00:00 to 09:00"（每日时间窗口 [start, end] 闭区间内按间隔循环）、"in 30m"（延时一次性）或 "at 15:00"（本地时刻一次性，已过则排到明天）';

const MODE_HINT =
  '执行方式："foreground"（默认）到期把任务注入当前会话由主 agent 执行；"background"（v1.3，v1.8 起同一任务多轮可重叠运行）到期拉起独立后台 pi 进程执行，会话落盘，可用 pi --session <id> 恢复对话记录';

/** 机器可判别的调度类型（widget 文案由 describeRecurrence 给，两种口径同源：parse.ts 的 RecurringSchedule） */
type LoopTaskKind = "interval" | "daily" | "window" | "once";

/** 后台轮次视图：字段取自 BgRunRecord，不新造字段与上限 */
type LoopRunView = {
  runId: string;
  status: BgRunStatus;
  startedAt: number;
  finishedAt?: number;
  sessionId?: string;
  summary?: string;
};

/** loop_list 的结构化契约（脚本读它做聚合：按预算重排定时任务这类） */
type LoopTaskView = {
  id: string;
  kind: LoopTaskKind;
  schedule: string;
  task: string;
  nextAt?: number;
  background: boolean;
  running?: LoopRunView[];
  recentRuns?: LoopRunView[];
};

function taskKind(t: LoopTask): LoopTaskKind {
  if (!t.recurring) return "once";
  return t.schedule?.kind ?? "interval";
}

function toRunView(r: BgRunRecord): LoopRunView {
  return {
    runId: r.runId,
    status: r.status,
    startedAt: r.startedAt,
    ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
  };
}

/**
 * 任务视图：口径与 widget 一致——schedule 用 describeRecurrence；暂停任务不给 nextAt
 * （widget 显示 —）；运行中的轮次全部列出，已完成只给最近 BG_HISTORY_DISPLAY 条。
 */
function toTaskView(t: LoopTask): LoopTaskView {
  const runs = t.runs ?? [];
  const running = runs.filter((r) => r.status === "running").map(toRunView);
  const recentRuns = runs.filter((r) => r.status !== "running").slice(-BG_HISTORY_DISPLAY).map(toRunView);
  return {
    id: t.id,
    kind: taskKind(t),
    schedule: describeRecurrence(t),
    task: t.task,
    ...(t.paused ? {} : { nextAt: t.nextDueAt }),
    background: t.background === true,
    ...(running.length > 0 ? { running } : {}),
    ...(recentRuns.length > 0 ? { recentRuns } : {}),
  };
}

/** 排序口径与 widget 的 formatTaskLines 一致：按触发先后 */
function viewTasks(tasks: LoopTask[]): LoopTaskView[] {
  return [...tasks].sort((a, b) => a.nextDueAt - b.nextDueAt).map(toTaskView);
}

const LOOP_RUN_VIEW_SCHEMA = Type.Object({
  runId: Type.String({ description: "轮次标识" }),
  status: Type.Union(
    [
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("timeout"),
      Type.Literal("interrupted"),
    ],
    { description: "轮次状态" },
  ),
  startedAt: Type.Number({ description: "本轮启动时刻（epoch ms）" }),
  finishedAt: Type.Optional(Type.Number({ description: "本轮结束时刻（epoch ms）" })),
  sessionId: Type.Optional(Type.String({ description: "子 pi 会话 id（pi --session <id> 可恢复）" })),
  summary: Type.Optional(Type.String({ description: "结果摘要（最后一条 assistant 文本，截断）" })),
});

const LOOP_LIST_OUTPUT_SCHEMA = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String({ description: "任务 id" }),
      kind: Type.Union(
        [Type.Literal("interval"), Type.Literal("daily"), Type.Literal("window"), Type.Literal("once")],
        { description: '调度类型："interval" 固定间隔 / "daily" 每天定时 / "window" 每日窗口 / "once" 一次性' },
      ),
      schedule: Type.String({ description: '调度描述（与 /loop:list 同口径，如 "每 5m"）' }),
      task: Type.String({ description: "到期后执行的任务内容" }),
      nextAt: Type.Optional(Type.Number({ description: "下次触发时刻（epoch ms）；暂停的任务不给" })),
      background: Type.Boolean({ description: "true = 到期拉起独立子 pi 进程执行" }),
      running: Type.Optional(Type.Array(LOOP_RUN_VIEW_SCHEMA, { description: "运行中的后台轮次（全部）" })),
      recentRuns: Type.Optional(
        Type.Array(LOOP_RUN_VIEW_SCHEMA, { description: `最近完成的后台轮次（最多 ${BG_HISTORY_DISPLAY} 条）` }),
      ),
    }),
    { description: "当前会话全部任务（按触发先后排序）" },
  ),
});

export function registerLoopTools(pi: ExtensionAPI, deps: LoopToolDeps): void {
  pi.registerTool({
    name: "loop_create",
    label: "Loop Create",
    description: [
      "创建一个定时任务（本会话内有效）：默认到时把任务内容作为消息注入当前会话，由主 agent 执行；mode='background' 则到期拉起独立后台 pi 进程。",
      `task 为到期后要执行的内容；schedule 描述触发时机。${SCHEDULE_HINT}。`,
      '适合"每 N 分钟检查一次 X"、"每天早上 9 点做 X"、"每天 0 点到 9 点每小时巡检"、"30 分钟后提醒我"这类请求。',
    ].join(" "),
    exposure: "model-only",
    namespace: NAMESPACE,
    annotations: { destructiveHint: true, openWorldHint: true },
    parameters: Type.Object({
      task: Type.String({ description: "到期后要执行的任务描述", minLength: 1, maxLength: MAX_TASK_LEN }),
      schedule: Type.String({ description: SCHEDULE_HINT }),
      mode: Type.Optional(
        Type.Union([Type.Literal("foreground"), Type.Literal("background")], { description: MODE_HINT }),
      ),
      model: Type.Optional(
        Type.String({
          description: "后台模式专用：模型指定（provider/id 格式，如 opencode-go/deepseek-v4-flash），透传子 pi 进程的 --model；不传用 pi 默认模型",
          minLength: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const schedule = parseSchedule(params.schedule, Date.now());
      if (!schedule.ok) {
        return { content: [{ type: "text", text: schedule.message }], details: undefined, isError: true };
      }
      const background = params.mode === "background";
      if (params.model !== undefined && !background) {
        return {
          content: [{ type: "text", text: 'model 仅 mode="background" 支持：后台任务拉起独立子 pi 时透传 --model；前台任务注入当前会话，无法指定模型。' }],
          details: undefined,
          isError: true,
        };
      }
      const spec = schedule.value;
      const result = createTask(
        deps.tasks,
        {
          task: params.task,
          recurring: spec.recurring,
          intervalMs: spec.intervalMs,
          schedule: spec.schedule,
          background,
          model: params.model,
          fireAtMs: spec.fireAtMs,
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
      return {
        content: [{
          type: "text",
          text: `已创建 loop ${t.id}：${describeRecurrence(t)}${background ? " · 后台执行" : ""}${t.model ? ` · 模型 ${t.model}` : ""} · 下次 ${formatClock(t.nextDueAt)} · ${t.task}`,
        }],
        details: {
          loopId: t.id,
          recurring: t.recurring,
          nextDueAt: t.nextDueAt,
          ...(background ? { background: true } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "loop_list",
    label: "Loop List",
    description: "列出当前会话的全部定时任务（id、类型、下次触发时刻、任务内容；后台任务附运行中轮次（各自会话 id）与最近 10 条已完成轮次）。",
    // 保持缺省 exposure "direct"：脚本（codemode）拿的是结构化结果，不是文本
    namespace: NAMESPACE,
    annotations: { readOnlyHint: true },
    parameters: Type.Object({}),
    outputSchema: LOOP_LIST_OUTPUT_SCHEMA,
    async execute() {
      const structuredContent = { tasks: viewTasks(deps.tasks) };
      if (deps.tasks.length === 0) {
        return { content: [{ type: "text", text: "没有定时任务。" }], details: { count: 0 }, structuredContent };
      }
      const lines = formatTaskLines(deps.tasks, Date.now());
      return {
        content: [{ type: "text", text: `当前 ${deps.tasks.length} 个任务：\n${lines.join("\n")}` }],
        details: { count: deps.tasks.length },
        structuredContent,
      };
    },
  });

  pi.registerTool({
    name: "loop_delete",
    label: "Loop Delete",
    description: "删除一个定时任务。id 可以是完整 id 或唯一前缀；用 loop_list 查看现有任务。",
    exposure: "model-only",
    namespace: NAMESPACE,
    annotations: { destructiveHint: true },
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
