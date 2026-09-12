/**
 * PWR - workflow intent recognition
 *
 * Triggers: `/workflow <task>` (extension command) and `workflow: <task>`
 * prefix (input event). Both produce a generation request that is injected
 * into the main agent. All colon sub-commands live in the SAME `/workflow:*`
 * namespace (v2.9.0) and are registered as independent static commands.
 */

export const WORKFLOW_COMMAND = "workflow";
export const WORKFLOW_PREFIX = "workflow:";

export interface GenerationRequest {
	task: string;
	requestedAt: string;
	argsSchema?: unknown;
}

/** Parses the argument text of the /workflow command. Empty args are invalid. */
export function parseWorkflowCommandArgs(raw: string): GenerationRequest | null {
	const task = (raw ?? "").trim();
	if (!task) return null;
	return { task, requestedAt: new Date().toISOString() };
}

/** Detects the `workflow:` prefix in raw user input (before skill/template expansion). */
export function matchWorkflowPrefix(text: string): GenerationRequest | null {
	const trimmed = (text ?? "").trim();
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(WORKFLOW_PREFIX)) return null;

	const task = trimmed.slice(WORKFLOW_PREFIX.length).trim();
	if (!task) return null;
	return { task, requestedAt: new Date().toISOString() };
}

/** 冒号子命令（v2.9.0）：独立静态注册命令名，统一 `/workflow:*` 命名空间。 */
export const WORKFLOW_SUBCOMMANDS = {
	run: "workflow:run",
	delete: "workflow:delete",
	model: "workflow:model",
	list: "workflow:list",
	view: "workflow:view",
	open: "workflow:open",
	pause: "workflow:pause",
	resume: "workflow:resume",
	stop: "workflow:stop",
	restart: "workflow:restart",
	save: "workflow:save",
	saved: "workflow:saved",
	script: "workflow:script",
	approve: "workflow:approve",
	help: "workflow:help",
} as const;

/**
 * 旧空格子命令 → 新命令 + 用法。裸 `/workflow` 命中时只提示改名、绝不生成
 * （防止 `/workflow list <runId>` 误触发生成回合）。`help` 不在表内：裸词
 * help 按既有语义继续显示帮助（不算旧子命令执行）。
 */
export const RETIRED_WORKFLOW_SUBCOMMANDS: Record<string, { command: string; usage: string }> = {
	run: { command: WORKFLOW_SUBCOMMANDS.run, usage: "/workflow:run <名称> [参数]" },
	delete: { command: WORKFLOW_SUBCOMMANDS.delete, usage: "/workflow:delete [名称]" },
	model: { command: WORKFLOW_SUBCOMMANDS.model, usage: "/workflow:model [auto|<模型>]" },
	list: { command: WORKFLOW_SUBCOMMANDS.list, usage: "/workflow:list [状态]" },
	view: { command: WORKFLOW_SUBCOMMANDS.view, usage: "/workflow:view [runId]" },
	open: { command: WORKFLOW_SUBCOMMANDS.open, usage: "/workflow:open <runId>" },
	pause: { command: WORKFLOW_SUBCOMMANDS.pause, usage: "/workflow:pause <runId>" },
	resume: { command: WORKFLOW_SUBCOMMANDS.resume, usage: "/workflow:resume <runId>" },
	stop: { command: WORKFLOW_SUBCOMMANDS.stop, usage: "/workflow:stop <runId> [taskId]" },
	restart: { command: WORKFLOW_SUBCOMMANDS.restart, usage: "/workflow:restart <runId> <taskId>" },
	save: { command: WORKFLOW_SUBCOMMANDS.save, usage: "/workflow:save <runId>" },
	saved: { command: WORKFLOW_SUBCOMMANDS.saved, usage: "/workflow:saved" },
	script: { command: WORKFLOW_SUBCOMMANDS.script, usage: "/workflow:script <runId>" },
	approve: { command: WORKFLOW_SUBCOMMANDS.approve, usage: "/workflow:approve <runId>" },
};

/** 取首个空白分隔 token（无则空串）：各子命令的单参数解析用。 */
export function firstToken(text: string): string {
	return (text ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * 解析 `/workflow:run` 参数：首个 token = saved 名，其余为原始参数串
 * （key=value 或 JSON，交给 invokeSavedWorkflow 按 schema 校验）。
 */
export function parseWorkflowRunArgs(raw: string): { name: string; rawArgs: string } | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) return { name: trimmed, rawArgs: "" };
	return { name: trimmed.slice(0, spaceIndex), rawArgs: trimmed.slice(spaceIndex + 1).trim() };
}
