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
 * 前提：本机已配好密钥/ssh-agent。指纹策略是 TOFU（`accept-new`，`#15`）：目标机不在 known_hosts 里也能首次连上
 * （由 ssh 自己写入）；已收录主机的指纹变更仍会 fail-closed。
 * 用例只在自己创建的临时目录里读写，结束前删除。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { RemoteJobPort } from "../capability.ts";
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

test("真机：建连并解析远端 $HOME（非交互 + TOFU 指纹策略）", { skip }, async () => {
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
	// 这一条才走完整链路：同名覆盖 → resolveToolPath 的标记根前缀 → 宿主 path 解析 → ops 还原 → 真 ssh。
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

		// write → read（#16：成功文案必须是远端绝对路径，不是宿主标记形态）
		const written = await tools.get("write")!.execute(ID, { path: file, content: "export const live = 1;\n", remote }, undefined, undefined, ctx);
		assert.equal(text(written as never), `Successfully wrote to ${file}`);
		assert.equal(text(written as never).includes("pi-remote"), false, "write 文案泄露了宿主标记路径");
		const readBack = await tools.get("read")!.execute(ID, { path: file, remote }, undefined, undefined, ctx);
		assert.match(text(readBack as never), /export const live = 1;/);

		// edit（宿主 read-modify-write + 远端写回；#16：文案与 patch 头同样是远端路径）
		const edited = await tools.get("edit")!.execute(ID, { path: file, edits: [{ oldText: "live = 1", newText: "live = 2" }], remote }, undefined, undefined, ctx);
		assert.equal(text(edited as never), `Successfully replaced 1 block(s) in ${file}.`);
		assert.equal(text(edited as never).includes("pi-remote"), false, "edit 文案泄露了宿主标记路径");
		const patch = (edited as { details?: { patch?: string } } | undefined)?.details?.patch ?? "";
		assert.equal(patch.includes("pi-remote"), false, `edit patch 泄露了宿主标记路径：${patch.split("\n").slice(0, 3).join(" | ")}`);
		assert.ok(patch.includes(file), "edit patch 头应是远端路径");
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

	// 目录的归因必须真的是「是目录」——`-e` 对目录同样成立，分支顺序写反就会误报成权限问题（评审备注 1）。
	const directory = baseDirInput ?? (await makeSession().home());
	await assert.rejects(
		() => read.readFile(directory),
		(error: unknown) => error instanceof Error && error.message.startsWith(ErrorCodes.REMOTE_NOT_READABLE) && error.message.includes("是目录"),
	);
});

test("真机：不可达域名 fail-closed（ssh 参数含 BatchMode 与 StrictHostKeyChecking）", { skip }, async () => {
	const exec = createSpawnExec();
	const bogus = { host: "pi-remote-tools.invalid", user: "nobody", port: undefined };
	assert.equal(buildSshArgs(bogus, "true").includes("-o"), true);

	const result = await runSsh(exec, bogus, "true", { timeoutMs: 20_000 });
	assert.notEqual(result.exitCode, 0, "不存在的域名不该成功");
	assert.equal(result.stderr.length > 0, true);
});

test("真机：远端 bash 真在远端跑；ls/find 的不存在/传文件报结构化错误且不泄露宿主标记路径（remote-tools#9/#10）", { skip }, async () => {
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
		sessionManager: { getSessionId: () => "live-errors", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	const remote = targetInput as string;
	const base = baseDirInput ?? (await makeSession().home());
	const marker = `${base}/.pi-remote-tools-probe-${Date.now()}`;
	const file = `${marker}/probe.txt`;
	const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
	const failure = (run: () => Promise<unknown>): Promise<string> =>
		run().then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

	try {
		// 远端 bash 真的在远端跑（本机是 MINGW64_NT，远端是 Linux）。
		const uname = await tools.get("bash")!.execute(ID, { command: "uname -s", remote }, undefined, undefined, ctx);
		assert.match(text(uname as never), /Linux/, "带 remote 的 bash 必须真的在远端执行");

		await tools.get("bash")!.execute(ID, { command: `mkdir -p '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
		await tools.get("write")!.execute(ID, { path: file, content: "probe\n", remote }, undefined, undefined, ctx);

		// 真目录：正常列出（探针缓存路径的真机分支）。
		const listed = await tools.get("ls")!.execute(ID, { path: marker, remote }, undefined, undefined, ctx);
		assert.match(text(listed as never), /probe\.txt/);

		const missing = `${marker}/nope-${Date.now()}`;
		for (const [name, params] of [
			["ls", { path: missing }],
			["find", { path: missing, pattern: "**/*.ts" }],
		] as Array<[string, Record<string, unknown>]>) {
			const message = await failure(() => tools.get(name)!.execute(ID, { ...params, remote }, undefined, undefined, ctx));
			assert.match(message, new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`), `${name}: ${message}`);
			assert.equal(message.includes("pi-remote"), false, `${name} 不得回灌宿主标记路径：${message}`);
			assert.equal(message.includes("Path not found"), false, `${name} 不得落到宿主错误模板：${message}`);
		}
		for (const [name, params] of [
			["ls", { path: file }],
			["find", { path: file, pattern: "**/*.ts" }],
		] as Array<[string, Record<string, unknown>]>) {
			const message = await failure(() => tools.get(name)!.execute(ID, { ...params, remote }, undefined, undefined, ctx));
			assert.match(message, new RegExp(`^${ErrorCodes.REMOTE_NOT_DIRECTORY}`), `${name}: ${message}`);
			assert.equal(message.includes("Not a directory"), false, `${name} 不得落到宿主错误模板：${message}`);
		}
	} finally {
		await tools.get("bash")!.execute(ID, { command: `rm -rf '${marker}'`, remote, remoteCwd: base }, undefined, undefined, ctx);
	}
});

/**
 * 真机：远端超时转后台（remote-tools#12）——真 ssh/真远端 shell，owner 用契约形状的假实现。
 *
 * 分工：跨扩展协商（真两个扩展 + 真事件总线）在 shell-composition.test.ts 里测；这里只验
 * 假 ssh 测不出的东西——pid 文件在当前远端 shell 下真的可写、超时不断连真的保住了远端命令、
 * 终止脚本真的杀得掉远端进程组。owner 用假端口是为了让本文件保持「只依赖 remote-tools」。
 */
function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	const poll = async (): Promise<void> => {
		if (await check()) return;
		if (Date.now() - started > timeoutMs) assert.fail(`等待超时：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		return poll();
	};
	return poll();
}

test("真机：远端超时不断连（命令跑到结束）；/bg:kill 杀掉远端进程组", { skip }, async () => {
	const session = makeSession();
	const baseDir = baseDirInput ?? (await session.home());
	const target = makeTarget();
	const marker = `${baseDir}/.pi-remote-timeout-${Date.now()}`;
	const markerAlive = `${marker}.alive`;
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-live-job-"));
	const registrations: Array<{ id: string; logPath: string; tail: string; terminate: () => void }> = [];
	const settled: Array<number | null> = [];
	const host: RemoteJobPort = {
		allocate: () => ({ id: "bg-live", logPath: path.join(logDir, "bg-live.log") }),
		register: (job) => {
			registrations.push({ id: job.id, logPath: job.logPath, tail: job.tail, terminate: job.terminate });
			return `超时转后台：job ${job.id} 日志 ${job.logPath}`;
		},
		settle: (_id, exitCode) => settled.push(exitCode),
	};
	const ops = createRemoteBashOps(session, { jobHost: () => host });
	const remoteRead = async (command: string): Promise<string> => {
		const result = await runSsh(session.exec, target, command, { timeoutMs: 15_000 });
		return result.stdout.toString("utf8").trim();
	};

	try {
		// ① 超时不再杀连：本地 ssh 活着，命令 3 秒后写出标记（timeout=1 早就过了）。
		await assert.rejects(
			() => ops.exec(`sleep 3; printf 'DONE' > '${markerAlive}'`, baseDir, { onData: () => {}, timeout: 1, env: {} }),
			/超时转后台/, // 假 owner 的文本；真 owner 的文案在 timeout-bg 的单测里锁
		);
		assert.equal(registrations.length, 1);
		await waitUntil(async () => (await remoteRead(`cat '${markerAlive}' 2>/dev/null || true`)) === "DONE", "远端命令跑到结束（没被杀）");
		await waitUntil(async () => settled.length === 1, "命令结束后 settle 一次");
		assert.equal(settled[0], 0, "自然结束的退出码必须回传");

		// ② /bg:kill：杀掉远端进程组（长任务不再写出标记）。
		await assert.rejects(
			() => ops.exec(`sleep 987654; printf 'ALIVE' > '${markerAlive}'`, baseDir, { onData: () => {}, timeout: 1, env: {} }),
			/超时转后台/,
		);
		registrations[1]!.terminate();
		// 字符类写法（sleep 98765[4]）：轮询命令自己的命令行不含可匹配的字面串，免得自匹配。
		await waitUntil(async () => (await remoteRead("pgrep -f 'sleep 98765[4]' | wc -l")) === "0", "远端进程组被终止");
		const after = await remoteRead(`cat '${markerAlive}' 2>/dev/null || true`);
		assert.notEqual(after, "ALIVE", "被 kill 的命令不得继续跑到结束");
	} finally {
		await remoteRead(`rm -f '${markerAlive}'`);
		fs.rmSync(logDir, { recursive: true, force: true });
	}
});

test("真机：干净 known_hosts 下首次连接成功、指纹由 ssh 自己写入（accept-new，remote-tools#15）", { skip }, async () => {
	const target = makeTarget();
	// 生产 argv 必须带 accept-new（防无声回退到 yes）；再挂一个隔离的 UserKnownHostsFile 观察「谁写了指纹」。
	const args = buildSshArgs(target, "true");
	assert.equal(args.includes("StrictHostKeyChecking=accept-new"), true, "生产参数应使用 accept-new");
	assert.equal(args.includes("StrictHostKeyChecking=yes"), false, "不该回退到 yes");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-tools-known-hosts-"));
	const knownHosts = path.join(dir, "known_hosts");
	args.splice(1, 0, "-o", `UserKnownHostsFile=${knownHosts}`);

	assert.equal(fs.existsSync(knownHosts), false, "起点必须是干净 known_hosts");

	const result = await createSpawnExec()({ file: "ssh", args, stdin: undefined, timeoutMs: 20_000, signal: undefined });
	assert.equal(result.exitCode, 0, `干净 known_hosts 的首次连接应成功：${result.stderr}`);
	const written = fs.readFileSync(knownHosts, "utf8");
	assert.ok(written.trim().length > 0, "ssh 应把主机条目写进 known_hosts（空文件 = 没写）");
	// 不直接断言主机名字面量：用户/系统 ssh_config 开了 `HashKnownHosts yes` 时条目是哈希形态。
	// 写进文件就说明 ssh 接受了主机身份（这才是 accept-new 的语义）。
	fs.rmSync(dir, { recursive: true, force: true });
});
