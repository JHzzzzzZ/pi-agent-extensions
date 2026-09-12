/**
 * PWR - script generation constraints
 *
 * Injected into the main agent so it produces a schema-conformant PWR
 * JavaScript script. This is the "script constraints" payload described in
 * JHL-16 goal 1 / PRD 4.2.
 */

import { AGENT_LIMIT, CONCURRENCY_DEFAULT, CONCURRENCY_MAX } from "./types.ts";

export function buildGenerationRequest(task: string, argsSchema?: unknown): string {
	const argsNote = argsSchema
		? `The task may reference a structured args object; use the args schema ${JSON.stringify(argsSchema)} if the task mentions parameters.`
		: "";
	return `[PWR WORKFLOW GENERATION]

Task: ${task}
${argsNote}

Generate a PWR (Pi Workflow Runtime) JavaScript workflow script that accomplishes this task by orchestrating subagents. The script must follow the PWR schema exactly:

1. Start with \`export const meta = { name, description, version }\` describing the workflow.
2. Use top-level \`await\` statements.
3. Only these globals are available: \`meta\`, \`args\`, \`agent\`, \`pipeline\`, \`parallel\`, \`sleep\`.
   - \`agent(prompt, options)\`: run one subagent. options: { label, schema?, tools: 'readonly'|'write', model? }.
   - \`pipeline(items, fn, { concurrency, onError })\`: fan out one agent per item. concurrency must be <= ${CONCURRENCY_MAX} (default ${CONCURRENCY_DEFAULT}). onError: 'fail' (default, first failure aborts the run) or 'continue' (failed items collected; returns { results, failures: [{ index, code, message }] }, failed results are undefined).
   - \`parallel(tasks, { onError })\`: run distinct agents in parallel. Same onError option ('fail' default).
   - \`sleep(ms)\`: scheduling backoff only.
4. \`process\`, \`require\`, \`import\`, \`eval\`, \`Function\`, \`globalThis\`, Node built-ins, network and filesystem APIs are forbidden in the script itself; only subagents perform real tool use.
5. Give every agent/pipeline/parallel call a human-readable \`label\` (e.g. "discover", "audit", "verify") so stages can be displayed.
6. Prefer \`tools: 'readonly'\` for analysis stages; use \`tools: 'write'\` only when the stage must modify files.
7. Return a final summary with \`return\` (string or small object). Total agents must stay under ${AGENT_LIMIT}.

Submit the complete script to the workflow_validate tool with the full source. After it returns a runId, call workflow_start with { runId, approval: 'once' }. PWR will show an approval card at that point — wait for the user's decision. If workflow_start is blocked (approval pending or rejected), stop and tell the user the run is waiting for approval.`;
}
