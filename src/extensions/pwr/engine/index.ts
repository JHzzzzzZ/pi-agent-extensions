/**
 * PWR script engine — public API surface.
 *
 * Subsystem: 脚本规范 / ScriptValidator / ScriptInterpreter (JHL-12).
 * Runtime / adapter / UI subsystems import from here.
 */

export {
	ErrorCodes,
	ScriptError,
	formatScriptError,
	type ScriptDiagnostic,
	type ScriptEndPosition,
	type ScriptErrorCode,
	type ScriptPosition,
} from "./errors.ts";
export {
	DEFAULT_CONCURRENCY,
	MAX_AGENTS_HARD_LIMIT,
	MAX_CONCURRENCY_HARD_LIMIT,
	MAX_SCRIPT_BYTES,
	SCRIPT_VERSION,
	clampConcurrency,
	clampLoopIterations,
	clampMaxAgents,
} from "./spec.ts";
export { parseScript, type AcornNode as AstNode, type Program } from "./parser.ts";
export {
	extractPlan,
	validateScript,
	validateScriptStrict,
	type PlanItem,
	type ValidatedScript,
	type ValidationResult,
	type WorkflowMeta,
} from "./validator.ts";
export {
	ScriptInterpreter,
	runScript,
	type AgentRunResult,
	type AgentRunner,
	type AgentRunSpec,
	type RunOptions,
	type RunResult,
	type RunStats,
} from "./interpreter.ts";
export {
	runWorkflowValidate,
	type WorkflowValidateFailure,
	type WorkflowValidateOutcome,
	type WorkflowValidateParams,
	type WorkflowValidateSuccess,
} from "./validate-tool.ts";
export { createSemaphore, type Semaphore } from "./concurrency.ts";
