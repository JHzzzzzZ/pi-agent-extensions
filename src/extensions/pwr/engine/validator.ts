/**
 * PWR ScriptValidator — static AST validation of the PWR ECMAScript subset.
 *
 * Accepts: variables (const/let/var, incl. destructuring), object/array
 * literals, conditionals, restricted loops, functions, await (whitelisted
 * APIs only), return/throw/try, template literals, spread, optional
 * chaining. Rejects: module loading, reflection, prototype access, dynamic
 * code generation, regex/class/generator syntax and unknown globals.
 *
 * Error codes (PRD 6.2): SCRIPT_FORBIDDEN_SYNTAX / SCRIPT_UNKNOWN_API, with
 * position info pointing into the original script source.
 *
 * Validation target: < 300ms (see test/perf.test.ts).
 */

import {
	ErrorCodes,
	ScriptError,
	type ScriptDiagnostic,
	type ScriptEndPosition,
	type ScriptErrorCode,
	type ScriptPosition,
} from "./errors.ts";
import { nodeEnd, nodeStart, parseScript, type AcornNode, type Program } from "./parser.ts";
import {
	ASYNC_APIS,
	FORBIDDEN_IDENTIFIERS,
	FORBIDDEN_PROPERTY_NAMES,
	IMMUTABLE_GLOBALS,
	WHITELISTED_GLOBALS,
} from "./spec.ts";

/** `meta` extracted from `export const meta = {...}`. */
export interface WorkflowMeta {
	name?: string;
	description?: string;
	version?: number;
	[key: string]: unknown;
}

/** A scheduling call site, in source order (used for the startup plan card). */
export interface PlanItem {
	type: "agent" | "pipeline" | "parallel";
	label?: string;
	concurrency?: number;
	line: number;
	column: number;
}

export interface ValidatedScript {
	source: string;
	ast: Program;
	meta?: WorkflowMeta;
	plan: PlanItem[];
}

export interface ValidationResult {
	ok: boolean;
	errors: ScriptDiagnostic[];
	meta?: WorkflowMeta;
	plan?: PlanItem[];
}

const WHITELIST = new Set<string>(WHITELISTED_GLOBALS);

const node = (n: AcornNode | null | undefined): n is AcornNode => Boolean(n && typeof n.type === "string");

function isIdentifier(n: AcornNode | null | undefined, name?: string): n is AcornNode & { name: string } {
	if (!node(n) || n.type !== "Identifier") return false;
	if (name !== undefined && (n as { name?: string }).name !== name) return false;
	return true;
}

/** Literal string value, if the node is a string literal. */
function literalString(n: AcornNode | null | undefined): string | undefined {
	if (node(n) && n.type === "Literal" && typeof (n as { value?: unknown }).value === "string") {
		return (n as any).value;
	}
	return undefined;
}

/** Literal number value, if the node is a number literal. */
function literalNumber(n: AcornNode | null | undefined): number | undefined {
	if (node(n) && n.type === "Literal" && typeof (n as { value?: unknown }).value === "number") {
		return (n as any).value;
	}
	return undefined;
}

/** Literal boolean value. */
function literalBoolean(n: AcornNode | null | undefined): boolean | undefined {
	if (node(n) && n.type === "Literal" && typeof (n as { value?: unknown }).value === "boolean") {
		return (n as any).value;
	}
	return undefined;
}

/** Extracts plain JSON-like values from a meta object literal. */
function extractMetaValue(n: AcornNode): unknown {
	const str = literalString(n);
	if (str !== undefined) return str;
	const num = literalNumber(n);
	if (num !== undefined) return num;
	const bool = literalBoolean(n);
	if (bool !== undefined) return bool;
	if (n.type === "UnaryExpression" && (n as { operator?: string }).operator === "-") {
		const num = literalNumber((n as { argument?: AcornNode }).argument);
		if (num !== undefined) return -num;
	}
	if (n.type === "TemplateLiteral") {
		const quasis = (n as { quasis?: AcornNode[] }).quasis ?? [];
		const expressions = (n as { expressions?: AcornNode[] }).expressions ?? [];
		if (expressions.length === 0 && quasis.length === 1) {
			const raw = (quasis[0] as { value?: { cooked?: string } }).value?.cooked;
			if (raw !== undefined) return raw;
		}
	}
	if (n.type === "ArrayExpression") {
		const out: unknown[] = [];
		for (const el of (n as { elements?: Array<AcornNode | null> }).elements ?? []) {
			if (!el) return undefined;
			const v = extractMetaValue(el);
			if (v === undefined) return undefined;
			out.push(v);
		}
		return out;
	}
	if (n.type === "ObjectExpression") {
		const out: Record<string, unknown> = {};
		for (const prop of (n as { properties?: AcornNode[] }).properties ?? []) {
			if (!node(prop) || prop.type !== "Property") return undefined;
			const keyNode = (prop as { key?: AcornNode }).key;
			const key =
				isIdentifier(keyNode) && !(prop as { computed?: boolean }).computed
					? keyNode.name
					: literalString(keyNode);
			if (key === undefined) return undefined;
			const v = extractMetaValue((prop as { value?: AcornNode }).value as AcornNode);
			if (v === undefined) return undefined;
			out[key] = v;
		}
		return out;
	}
	return undefined;
}

class Validator {
	private readonly errors: ScriptDiagnostic[] = [];
	private scopes: Array<Set<string>> = [new Set()];
	private functionScopeIndex = 0;
	private loopDepth = 0;
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	private scope(): Set<string> {
		return this.scopes[this.scopes.length - 1]!;
	}

	private declareName(name: string, at: AcornNode): boolean {
		if (WHITELIST.has(name) || FORBIDDEN_IDENTIFIERS.has(name)) {
			this.report(
				ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
				`禁止声明名称 "${name}"（与保留/白名单全局冲突）`,
				at,
			);
			return false;
		}
		this.scope().add(name);
		return true;
	}

	private report(
		code: ScriptErrorCode,
		message: string,
		at: AcornNode | null | undefined,
		end?: AcornNode | null,
	): void {
		const start: ScriptPosition | undefined = at ? nodeStart(at) : undefined;
		const endPos: ScriptEndPosition | undefined = end ? nodeEnd(end) : undefined;
		this.errors.push({ code, message, start, end: endPos });
	}

	/** Walk a binding pattern (Identifier / Object / Array / Assignment / Rest). */
	private walkPattern(pattern: AcornNode | null | undefined): void {
		if (!node(pattern)) return;
		switch (pattern.type) {
			case "Identifier": {
				this.declareName((pattern as any).name, pattern);
				return;
			}
			case "ObjectPattern": {
				for (const prop of (pattern as { properties?: AcornNode[] }).properties ?? []) {
					if (!node(prop)) continue;
					if (prop.type === "RestElement") {
						this.walkPattern((prop as { argument?: AcornNode }).argument);
						continue;
					}
					if (prop.type !== "Property") continue;
					const key = (prop as { key?: AcornNode }).key;
					if ((prop as { computed?: boolean }).computed) {
						this.walkExpression(key as AcornNode);
					} else {
						this.checkPropertyName(key as AcornNode, prop);
					}
					this.walkPattern((prop as { value?: AcornNode }).value);
				}
				return;
			}
			case "ArrayPattern": {
				for (const el of (pattern as { elements?: Array<AcornNode | null> }).elements ?? []) {
					this.walkPattern(el);
				}
				return;
			}
			case "AssignmentPattern": {
				this.walkPattern((pattern as { left?: AcornNode }).left);
				this.walkExpression((pattern as { right?: AcornNode }).right as AcornNode);
				return;
			}
			case "RestElement": {
				this.walkPattern((pattern as { argument?: AcornNode }).argument);
				return;
			}
			default: {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不允许的解构语法（${pattern.type}）`, pattern);
			}
		}
	}

	private checkPropertyName(key: AcornNode, at: AcornNode): void {
		const name = isIdentifier(key) ? key.name : literalString(key);
		if (name !== undefined && FORBIDDEN_PROPERTY_NAMES.has(name)) {
			this.report(
				ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
				`禁止访问/定义属性 "${name}"`,
				at,
			);
		}
	}

	private walkExpression(expr: AcornNode): void {
		switch (expr.type) {
			case "Identifier": {
				const name = (expr as any).name;
				if (FORBIDDEN_IDENTIFIERS.has(name)) {
					this.report(
						ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
						`禁止的全局/API：${name}`,
						expr,
					);
					return;
				}
				if (WHITELIST.has(name)) return;
				for (let i = this.scopes.length - 1; i >= 0; i--) {
					if (this.scopes[i]!.has(name)) return;
				}
				this.report(
					ErrorCodes.SCRIPT_UNKNOWN_API,
					`未知的全局/API：${name}（未声明且不在白名单）`,
					expr,
				);
				return;
			}
			case "Literal": {
				const raw = expr as { regex?: unknown; bigint?: unknown };
				if (raw.regex !== undefined) {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止正则表达式字面量", expr);
				}
				if (raw.bigint !== undefined) {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止 BigInt 字面量", expr);
				}
				return;
			}
			case "TemplateLiteral": {
				for (const e of (expr as { expressions?: AcornNode[] }).expressions ?? []) {
					this.walkExpression(e);
				}
				return;
			}
			case "ObjectExpression": {
				for (const prop of (expr as { properties?: AcornNode[] }).properties ?? []) {
					if (!node(prop)) continue;
					if (prop.type === "SpreadElement") {
						this.walkExpression((prop as { argument?: AcornNode }).argument as AcornNode);
						continue;
					}
					if (prop.type !== "Property") {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不允许的对象成员（${prop.type}）`, prop);
						continue;
					}
					const p = prop as {
						key?: AcornNode;
						value?: AcornNode;
						computed?: boolean;
						kind?: string;
						shorthand?: boolean;
					};
					if (p.kind === "get" || p.kind === "set") {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止 getter/setter", prop);
					}
					if (p.computed) {
						this.walkExpression(p.key as AcornNode);
					} else {
						this.checkPropertyName(p.key as AcornNode, prop);
					}
					if (p.shorthand) {
						// {x} — the value is the identifier itself
						this.walkExpression(p.value as AcornNode);
					} else {
						this.walkExpression(p.value as AcornNode);
					}
				}
				return;
			}
			case "ArrayExpression": {
				for (const el of (expr as { elements?: Array<AcornNode | null> }).elements ?? []) {
					if (el) this.walkExpression(el);
				}
				return;
			}
			case "CallExpression":
			case "OptionalCallExpression": {
				const call = expr as { callee?: AcornNode; arguments?: AcornNode[]; optional?: boolean };
				if (isIdentifier(call.callee)) {
					const name = (call.callee as any).name;
					if (FORBIDDEN_IDENTIFIERS.has(name)) {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的全局/API：${name}`, expr);
					} else if (!WHITELIST.has(name) && !this.isDeclared(name)) {
						this.report(
							ErrorCodes.SCRIPT_UNKNOWN_API,
							`未知的全局/API：${name}（未声明且不在白名单）`,
							expr,
						);
					}
				} else if (node(call.callee)) {
					this.walkExpression(call.callee);
				}
				for (const arg of call.arguments ?? []) this.walkExpression(arg);
				return;
			}
			case "MemberExpression":
			case "OptionalMemberExpression": {
				const mem = expr as { object?: AcornNode; property?: AcornNode; computed?: boolean };
				this.walkExpression(mem.object as AcornNode);
				if (mem.computed) {
					const prop = mem.property as AcornNode;
					this.walkExpression(prop);
					const lit = literalString(prop);
					if (lit !== undefined && FORBIDDEN_PROPERTY_NAMES.has(lit)) {
						this.report(
							ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
							`禁止访问属性 "${lit}"`,
							expr,
						);
					}
				} else {
					this.checkPropertyName(mem.property as AcornNode, expr);
				}
				return;
			}
			case "ChainExpression": {
				this.walkExpression((expr as { expression?: AcornNode }).expression as AcornNode);
				return;
			}
			case "UnaryExpression": {
				const op = (expr as { operator?: string }).operator;
				if (op === "delete" || op === "void") {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止操作符 ${op}`, expr);
				}
				this.walkExpression((expr as { argument?: AcornNode }).argument as AcornNode);
				return;
			}
			case "BinaryExpression":
			case "LogicalExpression": {
				const bin = expr as { operator?: string; left?: AcornNode; right?: AcornNode };
				if (bin.operator === "in" || bin.operator === "instanceof") {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止操作符 ${bin.operator}`, expr);
				}
				this.walkExpression(bin.left as AcornNode);
				this.walkExpression(bin.right as AcornNode);
				return;
			}
			case "AssignmentExpression": {
				const asg = expr as { operator?: string; left?: AcornNode; right?: AcornNode };
				if (isIdentifier(asg.left)) {
					const name = (asg.left as any).name;
					if (IMMUTABLE_GLOBALS.has(name) || FORBIDDEN_IDENTIFIERS.has(name)) {
						this.report(
							ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
							`禁止修改 "${name}"`,
							expr,
						);
						return;
					}
					if (!this.isDeclared(name)) {
						this.report(
							ErrorCodes.SCRIPT_UNKNOWN_API,
							`未知的全局/API：${name}（未声明且不在白名单）`,
							expr,
						);
						return;
					}
				} else if (node(asg.left)) {
					const leftType = (asg.left as AcornNode).type;
					if (leftType === "ObjectPattern" || leftType === "ArrayPattern") {
						this.walkPattern(asg.left);
					} else {
						this.walkExpression(asg.left);
					}
				}
				this.walkExpression(asg.right as AcornNode);
				return;
			}
			case "UpdateExpression": {
				const upd = expr as { operator?: string; argument?: AcornNode };
				if (isIdentifier(upd.argument)) {
					const name = (upd.argument as any).name;
					if (IMMUTABLE_GLOBALS.has(name) || FORBIDDEN_IDENTIFIERS.has(name)) {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止修改 "${name}"`, expr);
						return;
					}
					if (!this.isDeclared(name)) {
						this.report(
							ErrorCodes.SCRIPT_UNKNOWN_API,
							`未知的全局/API：${name}（未声明且不在白名单）`,
							expr,
						);
						return;
					}
				} else if (node(upd.argument)) {
					this.walkExpression(upd.argument);
				}
				return;
			}
			case "ConditionalExpression": {
				const cond = expr as { test?: AcornNode; consequent?: AcornNode; alternate?: AcornNode };
				this.walkExpression(cond.test as AcornNode);
				this.walkExpression(cond.consequent as AcornNode);
				this.walkExpression(cond.alternate as AcornNode);
				return;
			}
			case "ArrowFunctionExpression":
			case "FunctionExpression":
			case "FunctionDeclaration": {
				const fn = expr as AcornNode & {
					id?: AcornNode | null;
					params?: AcornNode[];
					body?: AcornNode;
					generator?: boolean;
					expression?: boolean;
				};
				if (fn.generator) {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止生成器函数", expr);
					return;
				}
				this.pushFunctionScope();
				if (fn.type === "FunctionDeclaration" && node(fn.id)) {
					this.declareName((fn.id as any).name, fn.id);
				}
				for (const p of fn.params ?? []) this.walkPattern(p);
				if (fn.expression) {
					this.walkExpression(fn.body as AcornNode);
				} else if (node(fn.body)) {
					this.walkStatements((fn.body as { body?: AcornNode[] }).body ?? []);
				}
				this.popScope();
				return;
			}
			case "AwaitExpression": {
				const arg = (expr as { argument?: AcornNode }).argument;
				const isWhitelistedCall =
					node(arg) &&
					(arg.type === "CallExpression" || arg.type === "OptionalCallExpression") &&
					isIdentifier((arg as { callee?: AcornNode }).callee) &&
					ASYNC_APIS.has((arg as { callee?: { name: string } }).callee!.name);
				if (!isWhitelistedCall) {
					this.report(
						ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
						"await 仅可用于白名单异步 API（agent/pipeline/parallel/sleep）",
						expr,
					);
					return;
				}
				this.walkExpression(arg as AcornNode);
				return;
			}
			case "NewExpression": {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止 new 表达式", expr);
				return;
			}
			case "TaggedTemplateExpression":
			case "ClassDeclaration":
			case "ClassExpression":
			case "MetaProperty":
			case "ThisExpression":
			case "Super":
			case "SequenceExpression":
			case "YieldExpression":
			case "ImportExpression": {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的语法（${expr.type}）`, expr);
				return;
			}
			case "SpreadElement": {
				this.walkExpression((expr as { argument?: AcornNode }).argument as AcornNode);
				return;
			}
			default: {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不支持的表达式语法（${expr.type}）`, expr);
			}
		}
	}

	private isDeclared(name: string): boolean {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			if (this.scopes[i]!.has(name)) return true;
		}
		return false;
	}

	private pushFunctionScope(): void {
		this.scopes.push(new Set());
		this.functionScopeIndex = this.scopes.length - 1;
	}

	private pushBlockScope(): void {
		this.scopes.push(new Set());
	}

	private popScope(): void {
		this.scopes.pop();
		this.functionScopeIndex = Math.min(this.functionScopeIndex, this.scopes.length - 1);
	}

	private declareInFunctionScope(name: string, at: AcornNode): void {
		if (WHITELIST.has(name) || FORBIDDEN_IDENTIFIERS.has(name)) {
			this.report(
				ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
				`禁止声明名称 "${name}"（与保留/白名单全局冲突）`,
				at,
			);
			return;
		}
		this.scopes[this.functionScopeIndex]!.add(name);
	}

	private walkStatements(stmts: AcornNode[]): void {
		for (const stmt of stmts) {
			if (!node(stmt)) continue;
			switch (stmt.type) {
				case "FunctionDeclaration": {
				// declare the name in the *current* scope, then validate the body
				const fnName = (stmt as { id?: { name: string } }).id?.name;
				if (fnName) this.declareName(fnName, stmt);
				this.walkExpression(stmt);
				continue;
			}
			case "ExpressionStatement": {
					this.walkExpression((stmt as { expression?: AcornNode }).expression as AcornNode);
					continue;
				}
				case "BlockStatement": {
					this.pushBlockScope();
					this.walkStatements((stmt as { body?: AcornNode[] }).body ?? []);
					this.popScope();
					continue;
				}
				case "VariableDeclaration": {
					const decl = stmt as { declarations?: AcornNode[]; kind?: string };
					for (const d of decl.declarations ?? []) {
						const declarator = d as { id?: AcornNode; init?: AcornNode | null };
						if (decl.kind === "var") {
							this.collectVarNames(declarator.id as AcornNode);
						} else {
							this.walkPattern(declarator.id);
						}
						if (declarator.init) this.walkExpression(declarator.init);
					}
					continue;
				}
				case "IfStatement": {
					const ifs = stmt as { test?: AcornNode; consequent?: AcornNode; alternate?: AcornNode | null };
					this.walkExpression(ifs.test as AcornNode);
					this.walkStatement(ifs.consequent as AcornNode);
					if (ifs.alternate) this.walkStatement(ifs.alternate);
					continue;
				}
				case "ForStatement": {
					const fs = stmt as {
						init?: AcornNode | null;
						test?: AcornNode | null;
						update?: AcornNode | null;
						body?: AcornNode;
					};
					this.pushBlockScope();
					if (fs.init) {
						if ((fs.init as AcornNode).type === "VariableDeclaration") {
							this.walkStatements([fs.init as AcornNode]);
						} else {
							this.walkExpression(fs.init as AcornNode);
						}
					}
					if (fs.test) this.walkExpression(fs.test);
					if (fs.update) this.walkExpression(fs.update);
					this.loopDepth++;
					this.walkStatement(fs.body as AcornNode);
					this.loopDepth--;
					this.popScope();
					continue;
				}
				case "ForOfStatement": {
					const fos = stmt as {
						left?: AcornNode;
						right?: AcornNode;
						body?: AcornNode;
						await?: boolean;
					};
					if (fos.await) {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止 for await", stmt);
						continue;
					}
					this.pushBlockScope();
					if ((fos.left as AcornNode).type === "VariableDeclaration") {
						this.walkStatements([fos.left as AcornNode]);
					} else {
						this.walkPattern(fos.left);
					}
					this.walkExpression(fos.right as AcornNode);
					this.loopDepth++;
					this.walkStatement(fos.body as AcornNode);
					this.loopDepth--;
					this.popScope();
					continue;
				}
				case "WhileStatement":
				case "DoWhileStatement": {
					const ws = stmt as { test?: AcornNode; body?: AcornNode };
					this.walkExpression(ws.test as AcornNode);
					this.loopDepth++;
					this.walkStatement(ws.body as AcornNode);
					this.loopDepth--;
					continue;
				}
				case "ReturnStatement": {
					const ret = stmt as { argument?: AcornNode | null };
					if (ret.argument) this.walkExpression(ret.argument);
					continue;
				}
				case "ThrowStatement": {
					this.walkExpression((stmt as { argument?: AcornNode }).argument as AcornNode);
					continue;
				}
				case "TryStatement": {
					const ts = stmt as {
						block?: AcornNode;
						handler?: AcornNode | null;
						finalizer?: AcornNode | null;
					};
					this.walkStatement(ts.block as AcornNode);
					if (ts.handler) {
						const h = ts.handler as { param?: AcornNode | null; body?: AcornNode };
						this.pushBlockScope();
						if (h.param) this.walkPattern(h.param);
						this.walkStatement(h.body as AcornNode);
						this.popScope();
					}
					if (ts.finalizer) this.walkStatement(ts.finalizer);
					continue;
				}
				case "BreakStatement":
				case "ContinueStatement": {
					const bs = stmt as { label?: AcornNode | null };
					if (bs.label) {
						this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止带标签的 break/continue", stmt);
						continue;
					}
					if (this.loopDepth === 0) {
						this.report(
							ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
							`${stmt.type === "BreakStatement" ? "break" : "continue"} 仅可用于循环内部`,
							stmt,
						);
					}
					continue;
				}
				case "EmptyStatement":
					continue;
				case "DebuggerStatement":
				case "LabeledStatement":
				case "SwitchStatement":
				case "ForInStatement":
				case "ImportDeclaration":
				case "ExportAllDeclaration":
				case "ExportDefaultDeclaration": {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的语法（${stmt.type}）`, stmt);
					continue;
				}
				case "ExportNamedDeclaration": {
					this.checkExport(stmt);
					continue;
				}
				default: {
					this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不支持的语句（${stmt.type}）`, stmt);
				}
			}
		}
	}

	private walkStatement(stmt: AcornNode | null | undefined): void {
		if (node(stmt)) this.walkStatements([stmt]);
	}

	/** `var` declarations hoist: register names in the function-level scope. */
	private collectVarNames(id: AcornNode): void {
		if (!node(id)) return;
		switch (id.type) {
			case "Identifier":
				this.declareInFunctionScope((id as any).name, id);
				return;
			case "ObjectPattern":
				for (const prop of (id as { properties?: AcornNode[] }).properties ?? []) {
					if (node(prop) && prop.type === "RestElement") {
						this.collectVarNames((prop as { argument?: AcornNode }).argument as AcornNode);
					} else if (node(prop)) {
						this.collectVarNames((prop as { value?: AcornNode }).value as AcornNode);
					}
				}
				return;
			case "ArrayPattern":
				for (const el of (id as { elements?: Array<AcornNode | null> }).elements ?? []) {
					if (el) this.collectVarNames(el);
				}
				return;
			case "AssignmentPattern":
				this.collectVarNames((id as { left?: AcornNode }).left as AcornNode);
				return;
			default:
				return;
		}
	}

	/** Only `export const meta = {...}` is allowed. */
	private checkExport(stmt: AcornNode): void {
		const decl = (stmt as { declaration?: AcornNode | null }).declaration;
		const ok =
			node(decl) &&
			decl.type === "VariableDeclaration" &&
			(decl as { kind?: string }).kind === "const" &&
			(decl as { declarations?: AcornNode[] }).declarations?.length === 1 &&
			isIdentifier(
				((decl as { declarations?: AcornNode[] }).declarations?.[0] as AcornNode)?.id,
				"meta",
			);
		if (!ok) {
			this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "仅允许 export const meta = {...}", stmt);
			return;
		}
		const init = ((decl as { declarations?: AcornNode[] }).declarations![0] as { init?: AcornNode }).init;
		if (!node(init) || init.type !== "ObjectExpression") {
			this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "meta 必须是对象字面量", stmt);
			return;
		}
		for (const prop of (init as { properties?: AcornNode[] }).properties ?? []) {
			if (!node(prop)) continue;
			if (prop.type === "SpreadElement" || prop.type !== "Property") {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "meta 不允许展开", prop);
				continue;
			}
			const key = (prop as { key?: AcornNode }).key;
			if ((prop as { computed?: boolean }).computed) {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "meta 键必须是静态字符串", prop);
				continue;
			}
			const keyName = isIdentifier(key) ? key.name : literalString(key);
			if (keyName === undefined || FORBIDDEN_PROPERTY_NAMES.has(keyName)) {
				this.report(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `meta 键名不合法`, prop);
				continue;
			}
			const v = extractMetaValue((prop as { value?: AcornNode }).value as AcornNode);
			if (v === undefined) {
				this.report(
					ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
					`meta.${keyName} 的值必须是字面量（字符串/数字/布尔/对象/数组）`,
					(prop as { value?: AcornNode }).value as AcornNode,
				);
			}
		}
	}

	run(ast: Program): ScriptDiagnostic[] {
		this.walkStatements(ast.body as AcornNode[]);
		return this.errors;
	}
}

function collectMeta(ast: Program): WorkflowMeta | undefined {
	for (const stmt of ast.body as AcornNode[]) {
		if (stmt.type !== "ExportNamedDeclaration") continue;
		const decl = (stmt as { declaration?: AcornNode }).declaration;
		if (!node(decl) || decl.type !== "VariableDeclaration") continue;
		const declarators = (decl as { declarations?: AcornNode[] }).declarations ?? [];
		if (declarators.length !== 1) continue;
		const init = (declarators[0] as { init?: AcornNode }).init;
		if (node(init) && init.type === "ObjectExpression") {
			return extractMetaValue(init) as WorkflowMeta;
		}
	}
	return undefined;
}

/**
 * Extract the scheduling call sites (agent/pipeline/parallel) in source
 * order — feeds the startup plan card (PRD 4.2/5.3).
 */
export function extractPlan(ast: Program): PlanItem[] {
	const plan: PlanItem[] = [];
	const visit = (n: AcornNode | null | undefined): void => {
		if (!node(n)) return;
		if (n.type === "CallExpression") {
			const callee = (n as { callee?: AcornNode }).callee;
			if (isIdentifier(callee)) {
				const name = (callee as any).name;
				const args = (n as { arguments?: AcornNode[] }).arguments ?? [];
				const start = nodeStart(n);
				const item: PlanItem = {
					type: name as PlanItem["type"],
					line: start?.line ?? 1,
					column: start?.column ?? 0,
				};
				if (name === "agent" || name === "pipeline") {
					const opts = name === "agent" ? args[1] : args[2];
					if (node(opts) && opts.type === "ObjectExpression") {
						for (const prop of (opts as { properties?: AcornNode[] }).properties ?? []) {
							if (!node(prop) || prop.type !== "Property") continue;
							const key = isIdentifier((prop as { key?: AcornNode }).key)
								? ((prop as { key?: { name: string } }).key as any).name
								: literalString((prop as { key?: AcornNode }).key);
							if (key === "label") {
								item.label = literalString((prop as { value?: AcornNode }).value);
							}
							if (key === "concurrency") {
								item.concurrency = literalNumber((prop as { value?: AcornNode }).value);
							}
						}
					}
				}
				if (name === "agent" || name === "pipeline" || name === "parallel") {
					plan.push(item);
				}
			}
		}
		for (const key of Object.keys(n)) {
			if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
			const v = (n as Record<string, unknown>)[key];
			if (Array.isArray(v)) {
				for (const el of v) visit(el as AcornNode);
			} else if (node(v as AcornNode)) {
				visit(v as AcornNode);
			}
		}
	};
	visit(ast);
	return plan;
}

/**
 * Non-throwing validation. Returns diagnostics (possibly several) plus the
 * parsed meta / plan when the script is accepted.
 */
export function validateScript(source: string): ValidationResult {
	try {
		const ast = parseScript(source);
		const validator = new Validator(source);
		const errors = validator.run(ast);
		if (errors.length > 0) {
			return { ok: false, errors };
		}
		return { ok: true, errors: [], meta: collectMeta(ast), plan: extractPlan(ast) };
	} catch (err) {
		if (err instanceof ScriptError) {
			return { ok: false, errors: [err.toDiagnostic()] };
		}
		return {
			ok: false,
			errors: [{ code: ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, message: String(err) }],
		};
	}
}

/**
 * Strict validation: throws the first ScriptError (used by the interpreter
 * entry point and by tools that must fail with a single actionable error).
 */
export function validateScriptStrict(source: string): ValidatedScript {
	const ast = parseScript(source);
	const validator = new Validator(source);
	const errors = validator.run(ast);
	if (errors.length > 0) {
		const first = errors[0]!;
		throw new ScriptError(first.code, first.message, first.start, first.end);
	}
	return { source, ast, meta: collectMeta(ast), plan: extractPlan(ast) };
}
