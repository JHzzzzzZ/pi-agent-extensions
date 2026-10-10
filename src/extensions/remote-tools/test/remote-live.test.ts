/*
 * remote-tools — 真机 opt-in 用例（进程边界接真实 ssh，不是 fake）。
 *
 * 为什么要这层：纯函数与假 ssh 测不出「真实 OpenSSH 的参数/RFC 行为」——主机指纹策略、
 * 非交互认证、stdin 传输、远端 shell 的引号解析、`cd ... || exit 201` 的真实退出码，
 * 只有真连一台机器才验证得了。所以这些用例默认**跳过**，显式开：
 *
 *   PI_REMOTE_TOOLS_TEST_TARGET=user@host        # 必填，例如 deploy@10.0.0.7
 *   PI_REMOTE_TOOLS_TEST_PORT=2222               # 可选
 *   PI_REMOTE_TOOLS_TEST_DIR=/srv/app            # 可选，可写目录；缺省远端 $HOME
 *
 * 前提：本机已配好密钥/ssh-agent，且目标机指纹已在 known_hosts（本扩展拒绝未知指纹）。
 * 用例只在自己创建的临时目录里读写，结束前删除。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ErrorCodes } from "../errors.ts";
import {
	createRemoteBashOps,
	createRemoteLsOps,
	createRemoteReadOps,
	createRemoteSession,
	createRemoteWriteOps,
} from "../ops.ts";
import { buildSshArgs, createSpawnExec, parseTarget, runSsh } from "../ssh.ts";
import { registerRemoteTools } from "../tools.ts";
import { png1x1 } from "./fixtures.ts";

const ID = "live-call";

const targetInput = process.env.PI_REMOTE_TOOLS_TEST_TARGET;
const portInput = process.env.PI_REMOTE_TOOLS_TEST_PORT;
const baseDirInput = process.env.PI_REMOTE_TOOLS_TEST_DIR;
const skip = targetInput === undefined || targetInput.trim() === "" ? "未设置 PI_REMOTE_TOOLS_TEST_TARGET（真机 opt-in）" : false;

function makeTarget() {
	const parsed = parseTarget({ remote: targetInput, remotePort: portInput === undefined ? undefined : Number(portInput) });
	if (parsed.ok === false) throw new Error(`真机目标解析失败：${parsed.code}`);
	if (parsed.target === null) throw new Error("真机目标解析失败");
	return parsed.target;
}

function makeSession() {
	return createRemoteSession({ target: makeTarget(), exec: createSpawnExec() });
}

test("真机：建连并解析远端 $HOME（非交互 + 拒绝未知指纹）", { skip }, async () => {
	const session = makeSession();
	const home = await session.home();
	assert.equal(home.startsWith("/"), true, `远端 $HOME 异常：${home}`);
});

test("真机：bash 在远端目录执行并回传输出/退出码；缺目录报结构化错误", { skip }, async () => {
	const session = makeSession();
	const baseDir = baseDirInput ?? (await session.home());
	const ops = createRemoteBashOps(session);

	const chunks: string[] = [];
	const ok = await ops.exec("printf 'pi-remote-tools-ok'", baseDir, { onData: (chunk: Buffer) => chunks.push(chunk.toString()), timeout: 30 });
	assert.equal(ok.exitCode, 0);
	assert.equal(chunks.join("").includes("pi-remote-tools-ok"), true);

	const failing = await ops.exec("exit 7", baseDir, { onData: () => {}, timeout: 30 });
	assert.equal(failing.exitCode, 7);

	await assert.rejects(
		() => ops.exec("true", `${baseDir}/definitely-missing-dir-${Date.now()}`, { onData: () => {}, timeout: 30 }),
		new RegExp(ErrorCodes.REMOTE_NOT_FOUND),
	);
});

test("真机：write → read → edit → ls 往返（临时目录，结束清理）", { skip }, async () => {
	const session = makeSession();
	const baseDir = baseDirInput ?? (await session.home());
	const marker = `${baseDir}/.pi-remote-tools-${Date.now()}`;
	const filePath = `${marker}/hello.ts`;

	const read = createRemoteReadOps(session);
	const write = createRemoteWriteOps(session);
	const ls = createRemoteLsOps(session);

	await write.mkdir(marker);
	await write.writeFile(filePath, "const answer = 41;\n");
	assert.equal((await read.readFile(filePath)).toString("utf8"), "const answer = 41;\n");

	// edit 的运维语义：读-改-写（与内置 edit 工具走的同一套 Operations）
	const current = (await read.readFile(filePath)).toString("utf8");
	await write.writeFile(filePath, current.replace("41", "42"));
	assert.equal((await read.readFile(filePath)).toString("utf8"), "const answer = 42;\n");

	assert.equal(await ls.exists(filePath), true);
	assert.equal((await ls.stat(marker)).isDirectory(), true);
	assert.equal((await ls.readdir(marker)).includes("hello.ts"), true);

	await createRemoteBashOps(session).exec(`rm -rf ${JSON.stringify(marker)}`, baseDir, { onData: () => {}, timeout: 30 });
	assert.equal(await ls.exists(marker), false, "清理失败：临时目录仍在");
});

test("真机：远端 read 图片走图片管线（真 PNG → image 块；文本文件不受影响）", { skip }, async () => {
	// 这条是真机才验得了的：样本要经真 ssh 以 base64 回来、真 PNG 再交给宿主的 processImage。
	const tools = new Map<string, ToolDefinition>();
	registerRemoteTools(
		{
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI,
		{ exec: createSpawnExec(), cwd: process.cwd() },
	);
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "live-image", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;

	const remote = targetInput as string;
	const base = baseDirInput ?? (await makeSession().home());
	const marker = `${base}/.pi-remote-tools-image-${Date.now()}`;
	const pngPath = `${marker}/pic.png`;
	const textPath = `${marker}/note.txt`;
	const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

	try {
		await tools.get("bash")!.execute(ID, { command: `mkdir -p '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		await tools
			.get("bash")!
			.execute(ID, { command: `printf '%s' '${png1x1().toString("base64")}' | base64 -d > '${pngPath}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		await tools.get("write")!.execute(ID, { path: textPath, content: "plain text\n", remote }, undefined, undefined, ctx);

		const image = (await tools.get("read")!.execute(ID, { path: pngPath, remote }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; mimeType?: string; data?: string }>;
		};
		const block = image.content.find((part) => part.type === "image");
		assert.equal(block?.mimeType, "image/png", JSON.stringify(image.content.map((part) => part.type)));
		assert.equal((block?.data ?? "").length > 0, true, "图片数据必须随结果回传（processImage 之后）");

		const plain = await tools.get("read")!.execute(ID, { path: textPath, remote }, undefined, undefined, ctx);
		assert.match(textOf(plain as never), /plain text/);
	} finally {
		await tools.get("bash")!.execute(ID, { command: `rm -rf '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		assert.equal(await createRemoteLsOps(makeSession()).exists(marker), false, "清理失败：临时目录仍在");
	}
});

test("真机：工具层端到端（注册覆盖 → Windows 路径往返 → 远端 write/read/ls/grep/find/bash）", { skip }, async () => {
	// 这一条才走完整链路：同名覆盖 → resolveToolPath 的 //pi-remote 标记 → 宿主 path 解析 → ops 还原 → 真 ssh。
	const tools = new Map<string, ToolDefinition>();
	registerRemoteTools(
		{
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI,
		{ exec: createSpawnExec(), cwd: process.cwd() },
	);
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "live-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;

	const remote = targetInput as string;
	const base = baseDirInput ?? (await makeSession().home());
	const marker = `${base}/.pi-remote-tools-tool-${Date.now()}`;
	const file = `${marker}/live.ts`;
	const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

	try {
		// bash：建目录（远端目录、远端 cwd 解析都走一遍）
		const mkdir = await tools.get("bash")!.execute(ID, { command: `mkdir -p '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		assert.match(text(mkdir as never), /.*/);

		// write → read
		await tools.get("write")!.execute(ID, { path: file, content: "export const live = 1;\n", remote }, undefined, undefined, ctx);
		const readBack = await tools.get("read")!.execute(ID, { path: file, remote }, undefined, undefined, ctx);
		assert.match(text(readBack as never), /export const live = 1;/);

		// edit（宿主 read-modify-write + 远端写回）
		await tools.get("edit")!.execute(ID, { path: file, edits: [{ oldText: "live = 1", newText: "live = 2" }], remote }, undefined, undefined, ctx);
		const afterEdit = await tools.get("read")!.execute(ID, { path: file, remote }, undefined, undefined, ctx);
		assert.match(text(afterEdit as never), /export const live = 2;/);

		// ls
		const listed = await tools.get("ls")!.execute(ID, { path: marker, remote }, undefined, undefined, ctx);
		assert.match(text(listed as never), /live\.ts/);

		// grep（远端 rg 主路径；WSL 里已装 rg）
		const grepped = await tools.get("grep")!.execute(ID, { pattern: "live = 2", path: marker, remote }, undefined, undefined, ctx);
		assert.match(text(grepped as never), /live\.ts:1: export const live = 2;/);

		// find：结果必须是**相对搜索目录**的路径（宿主用本机 path.relative 算，绝对路径会被算成 ../../../srv/… 乱码）
		const found = await tools.get("find")!.execute(ID, { pattern: "**/*.ts", path: marker, remote }, undefined, undefined, ctx);
		assert.equal(text(found as never).trim(), "live.ts");

		// 省略 path 时基准是远端 $HOME（绝对不是本机项目目录）：/home/user/.ssh 是我们刚装过公钥的目录
		const homeListing = await tools.get("ls")!.execute(ID, { remote }, undefined, undefined, ctx);
		assert.match(text(homeListing as never), /\.ssh/);
	} finally {
		const cleanup = await tools.get("bash")!.execute(ID, { command: `rm -rf '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		void cleanup;
		assert.equal(await createRemoteLsOps(makeSession()).exists(marker), false, "清理失败：临时目录仍在");
	}
});

test("真机：远端不存在 / 无权限报结构化错误码（不是未捕获异常）", { skip }, async () => {
	const session = makeSession();
	const read = createRemoteReadOps(session);
	// 用校验函数而不是锚定正则：node:assert 对 RegExp 校验的是 `String(error)`（带 "Error: " 前缀），锚 ^ 会永远不中。
	const isNotFoundOrUnreadable = (error: unknown): boolean =>
		error instanceof Error &&
		(error.message.startsWith(ErrorCodes.REMOTE_NOT_FOUND) || error.message.startsWith(ErrorCodes.REMOTE_NOT_READABLE));

	await assert.rejects(() => read.readFile("/definitely/missing/pi-remote-tools.ts"), isNotFoundOrUnreadable);
	await assert.rejects(() => read.readFile("/proc/1/mem"), isNotFoundOrUnreadable);
});

test("真机：不可达/未知主机 fail-closed（ssh 参数含 BatchMode 与 StrictHostKeyChecking）", { skip }, async () => {
	const exec = createSpawnExec();
	const bogus = { host: "pi-remote-tools.invalid", user: "nobody", port: undefined };
	assert.equal(buildSshArgs(bogus, "true").includes("-o"), true);

	const result = await runSsh(exec, bogus, "true", { timeoutMs: 20_000 });
	assert.notEqual(result.exitCode, 0, "不存在的域名不该成功");
	assert.equal(result.stderr.length > 0, true);
});
