/*
 * remote-tools — 工具层测试：注册覆盖、本地保真、远端分派、失败映射、session 缓存。
 *
 * 边界与动机（真问题不是纸面正确）：
 *   - 本地保真用**真实文件系统 + 真实本地实现**对照（同一组参数分别打我们的定义与宿主
 *     createXxxToolDefinition），不是断言我们自己的分支；
 *   - 远端分派用注入的假 ssh（进程边界替身），断言**实际发给 ssh 的命令**——Windows 上
 *     宿主 path 解析会给远端路径注入盘符，这条断言就是那个 bug 的守门人；
 *   - 只有宿主 ExtensionAPI 与 ExtensionToolContext 用结构 fake（宿主交互不在测试范围）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { ErrorCodes } from "../errors.ts";
import { DEGRADED_MARKER } from "../ops.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";
import { createSessionCache, registerRemoteTools } from "../tools.ts";
import { png1x1 } from "./fixtures.ts";

const ID = "call-1";
const REMOTE = "deploy@10.0.0.7";
const HOME = "/home/deploy";

interface Recorder {
	tools: Map<string, ToolDefinition>;
	calls: SshExecRequest[];
}

function recordTools(handler: (request: SshExecRequest) => Partial<SshExecResult> = () => ({}), extraDeps: { markerAnchor?: string | undefined } = {}): Recorder {
	const tools = new Map<string, ToolDefinition>();
	const calls: SshExecRequest[] = [];
	const exec: SshExec = async (request) => {
		calls.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
	};
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerRemoteTools(pi, { exec, cwd: process.cwd(), ...extraDeps });
	return { tools, calls };
}

function ctxFor(cwd: string): ExtensionToolContext {
	// 宿主交互（会话环境变量）不在本测试范围，按跌实抽根提供最小形状。
	return {
		cwd,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("");
}

/** readFile 的远端命令特征：目录分支排在 -e 之前，所以不能再用 `if [ -e ` 当特征（评审备注 1 的分支重排）。 */
const isRemoteReadFile = (command: string): boolean => command.includes("; then LC_ALL=C cat ");

/** ls/find 在进宿主校验之前的目录探针（remote-tools#10；答案会被缓存）。 */
const isDirectoryProbe = (command: string): boolean => command.startsWith("if [ -d ");

/** 探针一律答「是目录」（工具层其它断言不关心探针，只关心探针之后的命令）。 */
function probeAware(inner: (request: SshExecRequest) => Partial<SshExecResult>) {
	return (request: SshExecRequest): Partial<SshExecResult> => {
		if (isDirectoryProbe(request.args.at(-1) ?? "")) return { stdout: Buffer.from("d") };
		return inner(request);
	};
}

function failureOf(run: () => Promise<unknown>): Promise<string> {
	return run().then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

/** 宿主的远端路径探测/读取都回答「存在且是目录」或给定内容。 */
function homeProbeAware(inner: (request: SshExecRequest) => Partial<SshExecResult>) {
	return (request: SshExecRequest): Partial<SshExecResult> => {
		const command = request.args.at(-1) ?? "";
		if (command.includes("${HOME")) return { stdout: Buffer.from(`${HOME}\n`) };
		return inner(request);
	};
}

test("注册覆盖：七个内置工具名都被接管，且都带 remote/remotePort（bash 另有 remoteCwd）", () => {
	const { tools } = recordTools();
	assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);

	for (const name of ["read", "write", "edit", "ls", "find", "grep"]) {
		const properties = (tools.get(name)?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		assert.ok("remote" in properties, `${name} 应有 remote`);
		assert.ok("remotePort" in properties, `${name} 应有 remotePort`);
	}
	const bashProperties = (tools.get("bash")?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
	assert.ok("remoteCwd" in bashProperties);
	assert.ok("remote" in bashProperties);

	// 提示词片段与渲染器必须保留（覆盖同名工具最容易丢的就是这两样）。
	for (const name of ["read", "write", "edit", "ls", "find", "bash"]) {
		assert.ok((tools.get(name)?.promptSnippet ?? "").length > 0, `${name} 丢了 promptSnippet`);
	}
});

test("本地保真：remote 为空时与宿主实现逐字一致，且绝不调用 ssh（真实文件系统）", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-tools-local-"));
	await mkdir(path.join(dir, "src"), { recursive: true });
	await writeFile(path.join(dir, "src", "a.ts"), "const x = 1;\n// hello\n", "utf8");

	const recorder = recordTools((request) => {
		throw new Error(`remote 为空时不应调用 ssh：${request.args.join(" ")}`);
	});
	const ctx = ctxFor(dir);

	// read / ls
	for (const [name, params, builtin] of [
		["read", { path: "src/a.ts" }, () => createReadToolDefinition(dir)],
		["ls", { path: "src" }, () => createLsToolDefinition(dir)],
	] as Array<[string, Record<string, unknown>, () => ToolDefinition]>) {
		const ours = await recorder.tools.get(name)?.execute(ID, params, undefined, undefined, ctx);
		const theirs = await builtin().execute(ID, params, undefined, undefined, ctx);
		assert.equal(textOf(ours as { content: Array<{ type: string; text?: string }> }), textOf(theirs as { content: Array<{ type: string; text?: string }> }), `${name} 本地输出不一致`);
	}

	// write / edit 的真实副作用必须与宿主一致，且文案逐字一致（remote-tools#16 的对照基准）。
	// 两边用**同一条相对路径但不同临时目录**，这样 patch 里的路径字符串完全可比。
	const dir2 = await mkdtemp(path.join(tmpdir(), "remote-tools-local2-"));
	await mkdir(path.join(dir2, "src"), { recursive: true });
	await writeFile(path.join(dir2, "src", "a.ts"), "const x = 1;\n// hello\n", "utf8");
	const ctx2 = ctxFor(dir2);

	const writeParams = { path: "src/written.ts", content: "hello\n" };
	const oursWrite = await recorder.tools.get("write")?.execute(ID, writeParams, undefined, undefined, ctx);
	const theirsWrite = await createWriteToolDefinition(dir2).execute(ID, writeParams, undefined, undefined, ctx2);
	assert.equal(await readFile(path.join(dir, "src", "written.ts"), "utf8"), "hello\n");
	assert.equal(textOf(oursWrite as never), textOf(theirsWrite as never), "write 本地文案不一致");

	const editParams = { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }] };
	const oursEdit = await recorder.tools.get("edit")?.execute(ID, editParams, undefined, undefined, ctx);
	const theirsEdit = await createEditToolDefinition(dir2).execute(ID, editParams, undefined, undefined, ctx2);
	assert.equal(await readFile(path.join(dir, "src", "a.ts"), "utf8"), "const x = 42;\n// hello\n");
	assert.equal(textOf(oursEdit as never), textOf(theirsEdit as never), "edit 本地文案不一致");
	assert.deepEqual((oursEdit as { details?: unknown })?.details, (theirsEdit as { details?: unknown })?.details, "edit 本地 details（patch/diff）不一致");
	assert.equal(recorder.calls.length, 0, "本地分支不应产生任何 ssh 调用");

	// bash：真实本地子进程（同一命令、同一 cwd）
	const oursBash = await recorder.tools.get("bash")?.execute(ID, { command: "printf hello-local" }, undefined, undefined, ctx);
	const theirsBash = await createBashToolDefinition(dir).execute(ID, { command: "printf hello-local" }, undefined, undefined, ctx);
	assert.equal(textOf(oursBash as never).includes("hello-local"), true);
	assert.equal(textOf(oursBash as never), textOf(theirsBash as never));

	// 宿主外部工具（fd/rg）未就绪时，两边必须给出同一个错误——这也是保真。
	for (const [name, params, builtin] of [
		["find", { pattern: "**/*.ts", path: "src" }, () => createFindToolDefinition(dir)],
		["grep", { pattern: "hello", path: "src" }, () => createGrepToolDefinition(dir)],
	] as Array<[string, Record<string, unknown>, () => ToolDefinition]>) {
		const outcome = async (run: () => Promise<unknown>): Promise<string> => {
			try {
				const result = (await run()) as { content: Array<{ type: string; text?: string }> };
				// 行序由宿主外部工具（rg/fd）的遍历顺序决定，两个临时目录间本就不保证一致；
				// 这里要比的是内容与错误口径，不是排列顺序（#16 改动前此处就会零星抖动）。
				return textOf(result).split("\n").sort().join("\n");
			} catch (error) {
				return `THREW:${error instanceof Error ? error.message : String(error)}`;
			}
		};
		const ours = await outcome(() => recorder.tools.get(name)!.execute(ID, params, undefined, undefined, ctx));
		const theirs = await outcome(() => builtin().execute(ID, params, undefined, undefined, ctx));
		assert.equal(ours, theirs, `${name} 本地结果/错误不一致`);
	}
});

test("远端分派：read 的 ssh 命令里是远端路径（Windows 盘符污染守门人），且返回内容来自远端", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.startsWith("test -r")) return {};
			if (isRemoteReadFile(command)) return { stdout: Buffer.from("remote-file-body\n") };
			return {};
		}),
	);

	const result = await recorder.tools.get("read")?.execute(ID, { path: "/srv/app/src/a.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	assert.match(textOf(result as never), /remote-file-body/);

	const remoteCommands = recorder.calls.map((call) => call.args.at(-1) ?? "");
	assert.equal(remoteCommands.every((command) => command.includes("/srv/app/src/a.ts")), true, remoteCommands.join(" | "));
	assert.equal(remoteCommands.some((command) => /[A-Za-z]:\\/.test(command)), false, "远端路径不应带盘符/反斜杠");
	assert.equal(recorder.calls[0].args.includes("-p"), false, "未给 remotePort 不应出现 -p");
	assert.equal(recorder.calls[0].args.includes(REMOTE), true);
});

test("远端分派：相对 path 按远端 $HOME 解析；remotePort 透传成 -p", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.startsWith("test -r")) return {};
			if (isRemoteReadFile(command)) return { stdout: Buffer.from("body\n") };
			return {};
		}),
	);

	await recorder.tools.get("read")?.execute(
		ID,
		{ path: "src/rel.ts", remote: REMOTE, remotePort: 2222 },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	const commands = recorder.calls.map((call) => call.args.at(-1) ?? "");
	assert.equal(commands.some((command) => command.includes(`'${HOME}/src/rel.ts'`)), true, commands.join(" | "));
	assert.equal(recorder.calls[0].args.includes("-p") && recorder.calls[0].args.includes("2222"), true);
});

test("远端分派：bash 用 remoteCwd（缺省远端 $HOME），命令经 onData 流回模型", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			request.onData?.(Buffer.from("streamed-output"));
			return { exitCode: 0 };
		}),
	);

	const withCwd = await recorder.tools.get("bash")?.execute(
		ID,
		{ command: "ls -la", remote: REMOTE, remoteCwd: "/srv/app" },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	assert.match(textOf(withCwd as never), /streamed-output/);
	const remoteCommand = recorder.calls.at(-1)?.args.at(-1) ?? "";
	assert.match(remoteCommand, /^cd '\/srv\/app' \|\| exit 201; /);
	assert.match(remoteCommand, /ls -la$/);
	assert.equal(remoteCommand.includes("PI_WEB_TOKEN"), false, "宿主敏感环境变量不得转发到远端");

	const defaultCwd = recordTools(homeProbeAware(() => ({ exitCode: 0 })));
	await defaultCwd.tools.get("bash")?.execute(ID, { command: "pwd", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	assert.match(defaultCwd.calls.at(-1)?.args.at(-1) ?? "", new RegExp(`^cd '${HOME}' \\|\\| exit 201; `));
});

test("远端 find：结果必须是**相对搜索目录**的路径（宿主用本机 path.relative 算，未标记的绝对路径会变 ../../../srv/… 乱码）", async () => {
	const recorder = recordTools(
		probeAware(
			homeProbeAware((request) => {
				const command = request.args.at(-1) ?? "";
				if (command.startsWith("test -e")) return {};
				return { stdout: Buffer.from("/srv/app/a.ts\n/srv/app/src/b.ts\n") };
			}),
		),
	);

	const result = await recorder.tools.get("find")?.execute(
		ID,
		{ pattern: "**/*.ts", path: "/srv/app", remote: REMOTE },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	assert.equal(textOf(result as never), "a.ts\nsrc/b.ts");
});

test("远端 find 降级：远端缺 ripgrep 时结果里带降级标注", async () => {
	const recorder = recordTools(
		probeAware(
			homeProbeAware((request) => {
				const command = request.args.at(-1) ?? "";
				if (command.startsWith("test -e")) return {};
				return { stdout: Buffer.from("/srv/app/a.ts\n"), stderr: `${DEGRADED_MARKER}\n` };
			}),
		),
	);

	const result = await recorder.tools.get("find")?.execute(
		ID,
		{ pattern: "**/*.ts", path: "/srv/app", remote: REMOTE },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	const text = textOf(result as never);
	assert.match(text, /a\.ts/);
	assert.match(text, /远端缺少 ripgrep，已回退 POSIX find/);
});

test("远端 ls/find 的结构化错误（remote-tools#10）：不存在 ⇒ REMOTE_NOT_FOUND，传文件 ⇒ REMOTE_NOT_DIRECTORY，消息里没有宿主标记路径", async () => {
	const missing = recordTools(() => ({ exitCode: 3 }));
	for (const [name, params] of [
		["ls", { path: "/srv/nope" }],
		["find", { path: "/srv/nope", pattern: "**/*.ts" }],
	] as Array<[string, Record<string, unknown>]>) {
		const message = await failureOf(() => missing.tools.get(name)!.execute(ID, { ...params, remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())));
		assert.match(message, new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`), `${name}: ${message}`);
		assert.equal(message.includes("pi-remote"), false, `${name} 错误消息不得回灌宿主标记路径：${message}`);
		assert.equal(message.includes("Path not found"), false, `${name} 不得落到宿主错误模板：${message}`);
	}
	assert.equal(missing.calls.length, 2, "每种探针只发一次 ssh，不进宿主校验");

	const file = recordTools(() => ({ stdout: Buffer.from("f") }));
	for (const [name, params] of [
		["ls", { path: "/srv/app/README.md" }],
		["find", { path: "/srv/app/README.md", pattern: "**/*.ts" }],
	] as Array<[string, Record<string, unknown>]>) {
		const message = await failureOf(() => file.tools.get(name)!.execute(ID, { ...params, remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())));
		assert.match(message, new RegExp(`^${ErrorCodes.REMOTE_NOT_DIRECTORY}`), `${name}: ${message}`);
		assert.equal(message.includes("Not a directory"), false, `${name} 不得落到宿主错误模板：${message}`);
		assert.equal(/[A-Za-z]:[\\/]/.test(message), false, `${name} 消息里不得出现盘符形态路径：${message}`);
	}
});

test("远端 ls/find 往返数：探针 + readdir/glob = 2 次 ssh（宿主自己的 exists/stat 全部命中探针缓存）", async () => {
	const ls = recordTools((request) => {
		const command = request.args.at(-1) ?? "";
		if (isDirectoryProbe(command)) return { stdout: Buffer.from("d") };
		if (command.startsWith("ls -A1p")) return { stdout: Buffer.from("src/\nREADME.md\n") };
		return {};
	});
	const listed = await ls.tools.get("ls")!.execute(ID, { path: "/srv/app", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	assert.match(textOf(listed as never), /src\//);
	assert.equal(ls.calls.length, 2, "探针 1 + readdir 1（宿主未再发 exists/stat）");

	const find = recordTools(
		probeAware((request) => ((request.args.at(-1) ?? "").startsWith("test -e") ? {} : { stdout: Buffer.from("/srv/app/a.ts\n") })),
	);
	const found = await find.tools.get("find")!.execute(ID, { path: "/srv/app", pattern: "**/*.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	assert.match(textOf(found as never), /a\.ts/);
	assert.equal(find.calls.length, 2, "探针 1 + glob 1（宿主未再发 exists）");
});
test("标记根守卫：锚文件缺失时远端调用 fail-closed（专码 + 零 ssh），本地调用不受影响", async () => {
	const bogusAnchor = path.join(tmpdir(), `pi-remote-no-anchor-${Date.now()}`, "index.ts");
	const recorder = recordTools(() => {
		throw new Error("守卫必须在 ssh 之前拦住");
	}, { markerAnchor: bogusAnchor });

	await assert.rejects(
		() => recorder.tools.get("read")!.execute(ID, { path: "/srv/a.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.HOST_MARKER_CONFLICT),
	);
	assert.equal(recorder.calls.length, 0, "守卫触发时不该发 ssh");

	// 本地分支与守卫无关：零 ssh、行为照旧（红线：本地分支不受影响）
	const dir = await mkdtemp(path.join(tmpdir(), "remote-tools-guard-"));
	await writeFile(path.join(dir, "a.ts"), "local body\n", "utf8");
	const local = await recorder.tools.get("read")!.execute(ID, { path: "a.ts" }, undefined, undefined, ctxFor(dir));
	assert.match(textOf(local as never), /local body/);
	assert.equal(recorder.calls.length, 0);
});

test("远端 read 图片：走宿主图片管线（补上 detectImageMimeType 端口），不再当文本读（用户实测 bug）", async () => {
	const png = png1x1();
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.includes("head -c")) return { stdout: Buffer.from(png.toString("base64")) };
			if (isRemoteReadFile(command)) return { stdout: png };
			return {};
		}),
	);

	const result = await recorder.tools.get("read")!.execute(ID, { path: "/srv/app/pic.png", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	const content = (result as { content: Array<{ type: string; mimeType?: string; data?: string }> }).content;
	const image = content.find((part) => part.type === "image");
	assert.equal(image?.mimeType, "image/png", textOf(result as never));
	assert.equal((image?.data ?? "").length > 0, true, "图片数据必须随结果回传");
	assert.match(textOf(result as never), /Read image file \[image\/png\]/);
	// 图片形态的 structuredContent（对象 + note）是 rewriteHostPathInStructured 的第二个分支：形状与 data 必须原样保住
	// （评审第 2 轮建议 2：该分支不能只靠纸面推理）。
	const structured = (result as { structuredContent?: { type?: string; data?: string; mimeType?: string; note?: string } }).structuredContent;
	assert.equal(structured?.type, "image");
	assert.equal(structured?.mimeType, "image/png");
	assert.equal(structured?.data, image?.data, "图片 data 不得被改写路径的过程碰掉");
	assert.match(structured?.note ?? "", /Read image file \[image\/png\]/);
	assert.equal(recorder.calls.length, 2, "一次远端 read = 嗅探（搭 access）+ 读取，共两条 ssh");
});

test("失败映射：未知主机指纹 / 相对路径 / 端口非法 都 fail-closed，且错误里带错误码", async () => {
	const hostKeyFailure = recordTools(() => ({ exitCode: 255, stderr: "Host key verification failed." }));
	await assert.rejects(
		() => hostKeyFailure.tools.get("ls")!.execute(ID, { path: "/srv/app", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.SSH_CONNECT_FAILED),
	);

	const mustNotRun = recordTools((request) => {
		throw new Error(`不该发 ssh：${request.args.join(" ")}`);
	});
	await assert.rejects(
		() => mustNotRun.tools.get("read")!.execute(ID, { path: "C:/Users/me/a.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE),
	);
	await assert.rejects(
		() => mustNotRun.tools.get("read")!.execute(ID, { path: "/srv/a.ts", remote: REMOTE, remotePort: 70000 }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.INVALID_REMOTE_PORT),
		"正数越界的端口是真错，仍然拦",
	);
	await assert.rejects(
		() => mustNotRun.tools.get("read")!.execute(ID, { path: "/srv/a.ts", remote: "-oProxyCommand=x" }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.INVALID_REMOTE_TARGET),
	);
	await assert.rejects(
		() => mustNotRun.tools.get("read")!.execute(ID, { path: "/pi-remote/a.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE),
		"模型路径不得带宿主标记首段（与宿主内部标记冲突，fail-closed）",
	);
	await assert.rejects(
		() => mustNotRun.tools.get("read")!.execute(ID, { path: "~/a.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE),
		"远端不做 ~ 展开，直接拒绝",
	);

	// 远端不存在 → 错误码来自 ops 层
	const missing = recordTools(homeProbeAware(() => ({ exitCode: 3 })));
	await assert.rejects(
		() => missing.tools.get("read")!.execute(ID, { path: "/srv/gone.ts", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd())),
		new RegExp(ErrorCodes.REMOTE_NOT_FOUND),
	);
});

test("采样器噪声不得打断本地调用：带 remotePort: 0 与不带时输出逐字一致，且零 ssh（用户实测回归）", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-tools-noise-"));
	await writeFile(path.join(dir, "a.ts"), "const noise = 0;\n", "utf8");
	const recorder = recordTools((request) => {
		throw new Error(`本地分支不应发 ssh：${request.args.join(" ")}`);
	});
	const ctx = ctxFor(dir);
	const tool = recorder.tools.get("read")!;

	const clean = await tool.execute(ID, { path: "a.ts" }, undefined, undefined, ctx);
	const noisy = await tool.execute(ID, { path: "a.ts", remotePort: 0, remote: "", remoteCwd: "/srv" }, undefined, undefined, ctx);

	assert.equal(textOf(noisy as never), textOf(clean as never), "噪声字段不得改变本地输出");
	assert.equal(recorder.calls.length, 0, "噪声字段不得拉起 ssh");
});

test("远端也用得起噪声端口：remotePort: 0 视作未指定，照常走远端默认端口", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.startsWith("test -r")) return {};
			if (isRemoteReadFile(command)) return { stdout: Buffer.from("body\n") };
			return {};
		}),
	);

	const result = await recorder.tools.get("read")!.execute(
		ID,
		{ path: "/srv/a.ts", remote: REMOTE, remotePort: 0 },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	assert.match(textOf(result as never), /body/);
	assert.equal(recorder.calls[0].args.includes("-p"), false, "remotePort: 0 不应生成 -p");
});

test("远端非字符串 remoteCwd / path 视作未提供：不抛裸 TypeError，落回远端 $HOME（评审备注 1）", async () => {
	const recorder = recordTools(homeProbeAware(() => ({ exitCode: 0 })));

	// remoteCwd: null/0/{} 是 schema 外的噪声（采样器不会造，模型可能造）——必须按「未提供」处理
	for (const remoteCwd of [null, 0, {}, []]) {
		const result = await recorder.tools.get("bash")!.execute(
			ID,
			{ command: "pwd", remote: REMOTE, remoteCwd } as never,
			undefined,
			undefined,
			ctxFor(process.cwd()),
		);
		assert.ok(result !== undefined, `remoteCwd=${JSON.stringify(remoteCwd)} 不应抛错`);
		const command = recorder.calls.at(-1)?.args.at(-1) ?? "";
		assert.match(command, new RegExp(`^cd '${HOME}' \\|\\| exit 201; `), command);
		assert.match(command, /pwd$/, command);
	}
});

test("远端非字符串 path 视作未提供：落回远端 §HOME 并给出带错误码的失败，而不是裸 TypeError（评审 B1）", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			// 基准目录是目录：远端 readFile 应该报「是目录」而不是抛裸 TypeError（目录分支现在真的排在前面）
			if (command.startsWith("if [ -d ")) return { exitCode: 4 };
			return {};
		}),
	);

	await assert.rejects(
		() => recorder.tools.get("read")!.execute(ID, { path: null, remote: REMOTE } as never, undefined, undefined, ctxFor(process.cwd())),
		(error: unknown) => {
			if (!(error instanceof Error)) return false;
			assert.doesNotMatch(error.message, /TypeError|Cannot read propert/i, "不得抛裸 TypeError");
			return /^REMOTE_(NOT_READABLE|NOT_FOUND)/.test(error.message);
		},
	);
	assert.equal((recorder.calls.at(-1)?.args.at(-1) ?? "").includes(`'${HOME}'`), true, "非字符串 path 应落回远端 $HOME");
});

test("用户实测现场回归：remote: \"null\" 必须走本机（零 ssh），输出与不带 remote 逐字一致", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-tools-absence-"));
	await writeFile(path.join(dir, "a.ts"), "const absent = null;\n", "utf8");
	const recorder = recordTools((request) => {
		throw new Error(`不应发 ssh：${request.args.join(" ")}`);
	});
	const ctx = ctxFor(dir);
	const tool = recorder.tools.get("read")!;

	const clean = await tool.execute(ID, { path: "a.ts" }, undefined, undefined, ctx);
	for (const remote of ["null", "NULL", " undefined "]) {
		const literal = await tool.execute(ID, { path: "a.ts", remote } as never, undefined, undefined, ctx);
		assert.equal(textOf(literal as never), textOf(clean as never), `remote=${remote} 应等价于本机`);
	}
	assert.equal(recorder.calls.length, 0, "缺省值字面量不得拉起 ssh");
});

test("remoteCwd: \"null\" 当未提供 ⇒ 远端 cwd 落 $HOME（不是 $HOME/null）", async () => {
	const recorder = recordTools(homeProbeAware(() => ({ exitCode: 0 })));

	await recorder.tools.get("bash")!.execute(
		ID,
		{ command: "pwd", remote: REMOTE, remoteCwd: "null" } as never,
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	const command = recorder.calls.at(-1)?.args.at(-1) ?? "";
	assert.match(command, new RegExp(`^cd '${HOME}' \\|\\| exit 201; `), command);
	assert.equal(command.includes("null"), false, "cwd 不应拼成 $HOME/null");
});

test("session 缓存：同一目标多次调用只解析一次远端 $HOME", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.startsWith("ls -A1")) return { stdout: Buffer.from("a.ts\n") };
			if (command.startsWith("if [ -d ")) return { stdout: Buffer.from("d") };
			return {};
		}),
	);
	const ctx = ctxFor(process.cwd());

	// 绝对路径不需要远端 $HOME ⇒ 两次调用都不该出现探测（少一轮 ssh）。
	await recorder.tools.get("ls")?.execute(ID, { path: "/srv", remote: REMOTE }, undefined, undefined, ctx);
	assert.equal(recorder.calls.filter((call) => (call.args.at(-1) ?? "").includes("${HOME")).length, 0, "绝对路径不该探测远端 $HOME");

	// 相对路径需要远端 $HOME ⇒ 两次调用只解析一次。
	await recorder.tools.get("ls")?.execute(ID, { path: "logs", remote: REMOTE }, undefined, undefined, ctx);
	await recorder.tools.get("ls")?.execute(ID, { path: "logs", remote: REMOTE }, undefined, undefined, ctx);

	const homeProbes = recorder.calls.filter((call) => (call.args.at(-1) ?? "").includes("${HOME"));
	assert.equal(homeProbes.length, 1, "远端 $HOME 应只解析一次");

	// 直接单测缓存函数：同目标同 session，不同端口不同 session
	const cache = createSessionCache(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false }));
	const target = { host: "h", user: undefined, port: undefined };
	assert.equal(cache(target), cache({ host: "h", user: undefined, port: undefined }));
	assert.notEqual(cache(target), cache({ host: "h", user: undefined, port: 2222 }));
});

test("grep 远端：输出与降级标注走工具层", async () => {
	const recorder = recordTools(
		homeProbeAware((request) => {
			const command = request.args.at(-1) ?? "";
			if (command.startsWith("if [ -d ")) return { stdout: Buffer.from("d") };
			return {
				stdout: Buffer.from(
					`${JSON.stringify({ type: "match", data: { path: { text: "/srv/app/src/a.ts" }, lines: { text: "const x = 1;\n" }, line_number: 3 } })}\n`,
				),
			};
		}),
	);

	const result = await recorder.tools.get("grep")?.execute(
		ID,
		{ pattern: "x", path: "/srv/app", remote: REMOTE },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	assert.equal(textOf(result as never), "src/a.ts:3: const x = 1;");
});

/*
 * remote-tools#16：宿主把自己的入参 path 原样插进成功文案、补丁头与一族报错，而远端分支必须传宿主标记
 * 形态 ⇒ 不后处理就会把假路径（形如 C:\…\index.ts\pi-remote\srv\a.ts）喂给模型，读起来像「写到了本机」。
 * 这里断言的是**模型实际看到的结果/错误文本**（不是内部字符串），并用宿主真实定义跑出来的 patch 对照。
 */
const REMOTE_FILE = "/srv/app/x.ts";
const MARKER = "pi-remote";

test("远端 write：成功文案展示远端真实路径，不出现宿主标记形态（remote-tools#16）", async () => {
	const recorder = recordTools();
	const result = await recorder.tools.get("write")?.execute(
		ID,
		{ path: REMOTE_FILE, content: "hello\n", remote: REMOTE },
		undefined,
		undefined,
		ctxFor(process.cwd()),
	);
	const text = textOf(result as never);
	assert.equal(text, `Successfully wrote to ${REMOTE_FILE}`);
	assert.equal(text.includes(MARKER), false, `文案里不该有宿主标记：${text}`);
	// 真的写入远端路径（不是宿主形态）
	assert.equal((recorder.calls.at(-1)?.args.at(-1) ?? "").includes(`cat > '${REMOTE_FILE}'`), true);
});

test("远端 edit：成功文案与 patch 头都是远端路径，失败报错也是远端路径（remote-tools#16）", async () => {
	const content = "const x = 1;\n// hello\n";
	const recorder = recordTools((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.includes("; then LC_ALL=C cat ")) return { stdout: Buffer.from(content) };
		return {};
	});
	const edit = recorder.tools.get("edit");
	const ctx = ctxFor(process.cwd());

	const result = await edit?.execute(
		ID,
		{ path: REMOTE_FILE, edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }], remote: REMOTE },
		undefined,
		undefined,
		ctx,
	);
	const text = textOf(result as never);
	assert.equal(text, `Successfully replaced 1 block(s) in ${REMOTE_FILE}.`);
	assert.equal(text.includes(MARKER), false, `文案里不该有宿主标记：${text}`);

	const patch = (result as { details?: { patch?: string; diff?: string } } | undefined)?.details?.patch ?? "";
	assert.ok(patch.includes(`--- ${REMOTE_FILE}`), `patch 头应是远端路径：${patch.split("\n").slice(0, 3).join(" | ")}`);
	assert.ok(patch.includes(`+++ ${REMOTE_FILE}`), "patch 头应是远端路径");
	assert.equal(patch.includes(MARKER), false, "patch 里不该有宿主标记");

	// 失败路径：宿主模板 `Could not find the exact text in ${path}` 同样插的是我们传进去的形态。
	const failure = await failureOf(() =>
		edit!.execute(ID, { path: REMOTE_FILE, edits: [{ oldText: "不存在的片段", newText: "x" }], remote: REMOTE }, undefined, undefined, ctx),
	);
	assert.ok(failure.includes(REMOTE_FILE), `报错应含远端路径：${failure}`);
	assert.equal(failure.includes(MARKER), false, `报错里不该有宿主标记：${failure}`);
});

test("远端 read：大行提示里的路径也是远端路径（同族的第三处插值，remote-tools#16）", async () => {
	const hugeLine = "x".repeat(60_000);
	const recorder = recordTools((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.includes("; then LC_ALL=C cat ")) return { stdout: Buffer.from(`${hugeLine}\n`) };
		return {};
	});

	const result = await recorder.tools.get("read")?.execute(ID, { path: REMOTE_FILE, remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	const text = textOf(result as never);
	assert.match(text, /\[Line 1 is /);
	assert.ok(text.includes(REMOTE_FILE), `大行提示应指向远端路径：${text}`);
	assert.equal(text.includes(MARKER), false, `大行提示里不该有宿主标记：${text}`);

	// 第二个出口：宿主在 read.js 末尾从**改写前**的 content 派生 structuredContent（codemode 消费方走它）。
	const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
	assert.equal(typeof structured, "string", "read 文本结果应带 string 形态的 structuredContent");
	assert.ok(String(structured).includes(REMOTE_FILE), `structuredContent 应指向远端路径：${String(structured)}`);
	assert.equal(String(structured).includes(MARKER), false, `structuredContent 里不该有宿主标记：${String(structured)}`);
});
