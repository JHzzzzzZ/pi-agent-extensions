/**
 * PWR script parser — thin wrapper over the vendored acorn parser
 * (vendor/acorn.mjs, MIT). Acorn only parses; it never executes script code.
 * Parse errors are converted into SCRIPT_FORBIDDEN_SYNTAX diagnostics that
 * carry a position into the original source.
 */

import { parse } from "../vendor/acorn.mjs";
import { ErrorCodes, ScriptError, type ScriptPosition } from "./errors.ts";
import { MAX_SCRIPT_BYTES, PARSE_OPTIONS } from "./spec.ts";

/** A type-only view of the acorn AST nodes the engine walks. */
export interface AcornNode {
	type: string;
	start: number;
	end: number;
	loc?: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	} | null;
	// Node-specific fields (callee/arguments/properties/...). `any` keeps
	// narrowing ergonomic; the engine validates structure defensively at runtime.
	[key: string]: any;
}

export type Program = AcornNode;

/** Convert an acorn offset to a source position (line/column computed lazily). */
export function offsetToPosition(source: string, offset: number): ScriptPosition {
	let line = 1;
	let column = 0;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source.charCodeAt(i) === 10) {
			line++;
			column = 0;
		} else {
			column++;
		}
	}
	return { line, column, offset };
}

export function nodeStart(node: AcornNode): ScriptPosition | undefined {
	if (node.loc?.start) {
		return { line: node.loc.start.line, column: node.loc.start.column, offset: node.start };
	}
	return { line: 1, column: 0, offset: node.start };
}

export function nodeEnd(node: AcornNode): ScriptPosition | undefined {
	if (node.loc?.end) {
		return { line: node.loc.end.line, column: node.loc.end.column, offset: node.end };
	}
	return { line: 1, column: 0, offset: node.end };
}

/**
 * Parse `source` as a PWR workflow module.
 * @throws ScriptError SCRIPT_FORBIDDEN_SYNTAX on size overflow or syntax errors.
 */
export function parseScript(source: string): Program {
	if (typeof source !== "string") {
		throw new ScriptError(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "脚本必须是字符串");
	}
	if (source.length > MAX_SCRIPT_BYTES) {
		throw new ScriptError(
			ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
			`脚本超出大小上限（${MAX_SCRIPT_BYTES} 字节）`,
		);
	}
	try {
		return parse(source, PARSE_OPTIONS) as unknown as Program;
	} catch (err) {
		if (err instanceof ScriptError) throw err;
		const e = err as { message?: string; pos?: number; loc?: { line: number; column: number } };
		const offset = typeof e.pos === "number" ? e.pos : 0;
		const pos = e.loc
			? { line: e.loc.line, column: e.loc.column, offset }
			: offsetToPosition(source, offset);
		const detail = typeof e.message === "string" ? e.message : String(err);
		throw new ScriptError(
			ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
			`语法错误：${detail}`,
			pos,
		);
	}
}
