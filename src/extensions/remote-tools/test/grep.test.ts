/*
 * remote-tools — 远程 grep 测试：解析/格式化/降级/限流语义。
 *
 * 边界与动机：grep 是七个工具里唯一整份重写的一个（宿主的 GrepOperations 覆盖不到真正的
 * ripgrep 搜索），所以这里既锁纯函数（事件解析、相对路径、截断与提示），也用注入的假 ssh
 * 锁「一次往返完成搜索 + 降级标注」的端到端行为。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ErrorCodes } from "../errors.ts";
import { assertModelPathInput } from "../paths.ts";
import {
	executeRemoteGrep,
	finishGrepOutput,
	formatContextLine,
	formatMatchLine,
	parseRipgrepEvents,
	relativizeRemotePath,
	renderDegradedGrepOutput,
	resolveRemoteSearchPath,
} from "../grep.ts";
import { DEGRADED_MARKER, createRemoteSession } from "../ops.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";

const TARGET = { host: "10.0.0.7", user: "deploy", port: undefined };

function rgMatch(filePath: string, lineNumber: number, text: string): string {
	return JSON.stringify({ type: "match", data: { path: { text: filePath }, lines: { text: `${text}\n` }, line_number: lineNumber } });
}

function makeSession(handler: (request: SshExecRequest) => Partial<SshExecResult>) {
	const calls: SshExecRequest[] = [];
	const exec: SshExec = async (request) => {
		calls.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
	};
	const session = createRemoteSession({ target: TARGET, exec, homeDir: "/home/deploy" });
	return { session, calls };
}

test("rg --json 事件解析：match/context 都取，坏行与非事件行忽略", () => {
	const stdout = [
		rgMatch("/srv/app/src/a.ts", 3, "const x = 1;"),
		'{"type":"context","data":{"path":{"text":"/srv/app/src/a.ts"},"lines":{"text":"// ctx"},"line_number":2}}',
		'{"type":"begin","data":{"path":{"text":"/srv/app/src/a.ts"}}}',
		"not json at all",
		'{"type":"match","data":{}}',
		"",
	].join("\n");

	const events = parseRipgrepEvents(stdout);
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], { kind: "match", filePath: "/srv/app/src/a.ts", lineNumber: 3, lineText: "const x = 1;\n" });
	assert.equal(events[1].kind, "context");
	assert.equal(events[1].lineNumber, 2);
});

test("行格式化：匹配行 `path:line: text`、上下文行 `path-line- text`，长行截断到 500 字符", () => {
	assert.equal(formatMatchLine("src/a.ts", 3, "const x = 1;").text, "src/a.ts:3: const x = 1;");
	assert.equal(formatContextLine("src/a.ts", 2, "// ctx").text, "src/a.ts-2- // ctx");

	const long = "x".repeat(900);
	const rendered = formatMatchLine("src/a.ts", 1, long);
	assert.equal(rendered.truncated, true);
	assert.equal(rendered.text, `src/a.ts:1: ${"x".repeat(500)}... [truncated]`);
});

test("相对路径：搜索根内给相对路径、根外或文件搜索退回文件名", () => {
	assert.equal(relativizeRemotePath("/srv/app/src/a.ts", "/srv/app", true), "src/a.ts");
	assert.equal(relativizeRemotePath("/other/b.ts", "/srv/app", true), "b.ts");
	assert.equal(relativizeRemotePath("/srv/app/src/a.ts", "/srv/app/src/a.ts", false), "a.ts");
});

test("搜索根解析：省略 → 远端 $HOME；绝对原样；相对按远端 cwd 拼；Windows 盘符形态不当作远端绝对", () => {
	assert.equal(resolveRemoteSearchPath(undefined, "/home/deploy"), "/home/deploy");
	assert.equal(resolveRemoteSearchPath("   ", "/home/deploy"), "/home/deploy");
	assert.equal(resolveRemoteSearchPath("/srv/app/", "/home/deploy"), "/srv/app");
	assert.equal(resolveRemoteSearchPath("src/nested", "/home/deploy"), "/home/deploy/src/nested");
	assert.equal(resolveRemoteSearchPath("C:/Users/me", "/home/deploy"), "C:/Users/me");
});

test("缺省值字面量路径当未提供：\"null\" 落回基准目录；\"./null\" 仍是真路径（真叫 null 的文件写法）", () => {
	for (const input of ["null", " NULL ", "undefined", "nil", "none", "n/a"]) {
		assert.equal(resolveRemoteSearchPath(input, "/home/deploy"), "/home/deploy", input);
	}
	assert.equal(resolveRemoteSearchPath("./null", "/home/deploy"), "/home/deploy/null");
	assert.equal(resolveRemoteSearchPath("src/nil", "/home/deploy"), "/home/deploy/src/nil");
	assert.equal(resolveRemoteSearchPath("nullhost", "/home/deploy"), "/home/deploy/nullhost");
});

test("搜索根解析：~ 开头在**发 ssh 之前**被拒（由 assertModelPathInput 守，不走 resolveRemoteSearchPath）", () => {
	for (const input of ["~/x", "~", "~/"]) {
		assert.throws(() => assertModelPathInput(input), new RegExp(ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE), input);
	}
});

test("输出收尾：limit 与降级各给一条提示，字节截断走宿主 truncateHead", () => {
	const limited = finishGrepOutput(["a:1: x"], { matchLimitReached: 100, effectiveLimit: 100 });
	assert.match(limited.text, /100 matches limit reached\. Use limit=200 for more/);
	assert.equal(limited.details?.matchLimitReached, 100);

	const degraded = finishGrepOutput(["a:1: x"], { degraded: true, effectiveLimit: 100 });
	assert.match(degraded.text, /远端缺少 ripgrep，已回退 GNU grep/);
	assert.equal(degraded.details, undefined);
});

test("降级输出：剥掉搜索根前缀，保留 grep 原生 path:line:text 形态", () => {
	const stdout = ["/srv/app/src/a.ts:3:const x = 1;", "/srv/app/src/b.ts-4-// ctx", "unrelated line"].join("\n");
	assert.deepEqual(renderDegradedGrepOutput(stdout, "/srv/app"), ["src/a.ts:3:const x = 1;", "src/b.ts-4-// ctx", "unrelated line"]);
});

test("端到端（假 ssh）：一次往返完成「探测目录 + 远端 rg」，输出形态与内置一致", async () => {
	const { session, calls } = makeSession((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.startsWith("if [ -d ")) return { stdout: Buffer.from("d") };
		return { stdout: Buffer.from([rgMatch("/srv/app/src/a.ts", 3, "const x = 1;"), rgMatch("/srv/app/src/b.ts", 7, "let y = 2;")].join("\n")) };
	});

	const result = await executeRemoteGrep({ session, baseDir: "/home/deploy" }, { pattern: "x", path: "/srv/app" }, undefined);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(text, "src/a.ts:3: const x = 1;\nsrc/b.ts:7: let y = 2;");
	assert.equal(result.details, undefined);

	const searchCommand = calls.at(-1)?.args.at(-1) ?? "";
	assert.match(searchCommand, /^if command -v rg >\/dev\/null 2>&1; then rg /);
	assert.match(searchCommand, /--json/);
	assert.match(searchCommand, /'\/srv\/app'/);
	assert.equal(searchCommand.includes(DEGRADED_MARKER), true, "回退分支必须在同一条命令里就位");
});

test("端到端（假 ssh）：limit 命中给提示；无匹配给 No matches found", async () => {
	const limited = makeSession((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.startsWith("if [ -d ")) return { stdout: Buffer.from("d") };
		return { stdout: Buffer.from([rgMatch("/srv/a.ts", 1, "x"), rgMatch("/srv/b.ts", 2, "x")].join("\n")) };
	});
	const limitedResult = await executeRemoteGrep({ session: limited.session, baseDir: "/srv" }, { pattern: "x", limit: 2 }, undefined);
	const limitedText = limitedResult.content[0]?.type === "text" ? limitedResult.content[0].text : "";
	assert.match(limitedText, /2 matches limit reached\. Use limit=4 for more/);
	assert.equal(limitedResult.details?.matchLimitReached, 2);

	const empty = makeSession((request) => ((request.args.at(-1) ?? "").startsWith("if [ -d ") ? { stdout: Buffer.from("d") } : { exitCode: 1 }));
	const emptyResult = await executeRemoteGrep({ session: empty.session, baseDir: "/srv" }, { pattern: "zzz" }, undefined);
	assert.equal(emptyResult.content[0]?.type === "text" ? emptyResult.content[0].text : "", "No matches found");
});

test("端到端（假 ssh）：远端缺 rg → 回退 grep 并在结果里标注降级", async () => {
	const { session } = makeSession((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.startsWith("if [ -d ")) return { stdout: Buffer.from("d") };
		return { stdout: Buffer.from("/srv/app/src/a.ts:3:const x = 1;\n"), stderr: `${DEGRADED_MARKER}\n` };
	});

	const result = await executeRemoteGrep({ session, baseDir: "/home/deploy" }, { pattern: "x", path: "/srv/app" }, undefined);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /^src\/a\.ts:3:const x = 1;/);
	assert.match(text, /远端缺少 ripgrep，已回退 GNU grep：不遵守 \.gitignore/);
});

test("端到端（假 ssh）：远端搜索根不存在 → REMOTE_NOT_FOUND，且不发搜索命令", async () => {
	const { session, calls } = makeSession(() => ({ exitCode: 3 }));
	await assert.rejects(
		() => executeRemoteGrep({ session, baseDir: "/home/deploy" }, { pattern: "x", path: "/srv/gone" }, undefined),
		/REMOTE_NOT_FOUND/,
	);
	assert.equal(calls.length, 1);
});

test("端到端（假 ssh）：远端路径是 Windows 形态 → 发 ssh 之前就拒绝", async () => {
	const { session, calls } = makeSession(() => ({ stdout: Buffer.from("d") }));
	await assert.rejects(
		() => executeRemoteGrep({ session, baseDir: "/home/deploy" }, { pattern: "x", path: "C:/Users/me" }, undefined),
		/REMOTE_PATH_NOT_ABSOLUTE/,
	);
	assert.equal(calls.length, 0);
});
