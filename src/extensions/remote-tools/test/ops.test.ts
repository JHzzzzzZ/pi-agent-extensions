/*
 * remote-tools — 远端 Operations 后端测试（先写测试，实现见 ../ops.ts）。
 *
 * 边界与动机：断言**发给 ssh 的远端命令字符串**与错误映射（这两个才是真出问题的地方），
 * 真实 ssh 进程用注入的假 `SshExec` 替代；tools.ts 的本地保真与分派另测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ErrorCodes } from "../errors.ts";
import {
	DEGRADED_MARKER,
	type RemoteSession,
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteFindOps,
	createRemoteLsOps,
	createRemoteReadOps,
	createRemoteSession,
	createRemoteWriteOps,
} from "../ops.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";
import { animatedPngSample, bmpSample, gifSample, jpegSample, losslessJpegSample, png1x1, textSample, webpSample } from "./fixtures.ts";

const TARGET = { host: "10.0.0.7", user: "deploy", port: 2222 };

interface ScriptedExec {
	calls: SshExecRequest[];
	exec: SshExec;
}

function makeExec(handler: (request: SshExecRequest) => Partial<SshExecResult>): ScriptedExec {
	const calls: SshExecRequest[] = [];
	const exec: SshExec = async (request) => {
		calls.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
	};
	return { calls, exec };
}

/** 假 session：直接注入 exec 与缓存的 home/rg 探测结果，避免测试里出现探测轮次噪声。 */
function makeSession(handler: (request: SshExecRequest) => Partial<SshExecResult> = () => ({})): RemoteSession & ScriptedExec {
	const scripted = makeExec(handler);
	const session = createRemoteSession({ target: TARGET, exec: scripted.exec, homeDir: "/home/deploy" });
	return Object.assign(session, scripted);
}

async function failureOf(value: Promise<unknown> | unknown): Promise<string> {
	try {
		await value;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("预期抛错但没有抛");
}

test("readFile：单轮命令区分不存在/是目录/正常读取，二进制安全", async () => {
	const session = makeSession(() => ({ stdout: Buffer.from([0x00, 0xff, 0x41]) }));
	const ops = createRemoteReadOps(session);

	const content = await ops.readFile("/srv/app/bin.dat");
	assert.deepEqual(content, Buffer.from([0x00, 0xff, 0x41]));
	assert.equal(session.calls.length, 1);
	// 目录分支必须排在 -e 之前：`-e` 对目录同样成立，先 cat 会把「是目录」误报成「不可读」（评审备注 1）。
	assert.match(
		session.calls[0].args.at(-1) ?? "",
		/^if \[ -d '\/srv\/app\/bin\.dat' \]; then exit 4; elif \[ -e '\/srv\/app\/bin\.dat' \]; then LC_ALL=C cat '\/srv\/app\/bin\.dat'; else exit 3; fi$/,
	);
});

test("readFile：远端不存在 / 是目录 分别给出结构化错误码", async () => {
	const missing = makeSession(() => ({ exitCode: 3 }));
	const notAFile = makeSession(() => ({ exitCode: 4 }));

	const missingMessage = await failureOf(createRemoteReadOps(missing).readFile("/srv/nope.ts"));
	assert.match(missingMessage, new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`));

	const dirMessage = await failureOf(createRemoteReadOps(notAFile).readFile("/srv/app"));
	assert.match(dirMessage, new RegExp(`^${ErrorCodes.REMOTE_NOT_READABLE}`));
});

test("access：可读/可写/读写分别用 test -r / -w / -r -w，并先用 -e 区分「不存在」", async () => {
	const session = makeSession();
	const read = createRemoteReadOps(session);
	const write = createRemoteWriteOps(session);
	const edit = createRemoteEditOps(session);

	await read.access("/srv/app/a.ts");
	await write.access?.("/srv/app/a.ts");
	await edit.access("/srv/app/a.ts");

	// read 的 access 顺带把图片嗅探样本取回来（见本文件末的图片识别用例）：一次往返干两件事。
	assert.equal(
		session.calls[0].args.at(-1),
		"if [ ! -e '/srv/app/a.ts' ]; then exit 3; elif [ -d '/srv/app/a.ts' ]; then exit 0; elif [ ! -r '/srv/app/a.ts' ]; then exit 1; else head -c 8192 '/srv/app/a.ts' | base64 || true; fi",
	);
	assert.equal(session.calls[1].args.at(-1), "if [ -e '/srv/app/a.ts' ]; then test -w '/srv/app/a.ts'; else exit 3; fi");
	// 读写两个标志必须拆成两条 test（`test -r -w <path>` 是非法表达式，真机验收抓到过）
	assert.equal(
		session.calls[2].args.at(-1),
		"if [ -e '/srv/app/a.ts' ]; then test -r '/srv/app/a.ts' && test -w '/srv/app/a.ts'; else exit 3; fi",
	);
});

test("access：路径不存在报 REMOTE_NOT_FOUND，权限不足报各自的不可读/不可写码", async () => {
	const missing = makeSession(() => ({ exitCode: 3 }));
	assert.match(await failureOf(createRemoteReadOps(missing).access("/srv/nope")), new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`));

	const unreadable = makeSession(() => ({ exitCode: 1 }));
	const readMessage = await failureOf(createRemoteReadOps(unreadable).access("/srv/secret"));
	assert.match(readMessage, new RegExp(`^${ErrorCodes.REMOTE_NOT_READABLE}`));

	const unwritable = makeSession(() => ({ exitCode: 1 }));
	const writeMessage = await failureOf(createRemoteWriteOps(unwritable).access?.("/srv/readonly.ts") ?? Promise.resolve());
	assert.match(writeMessage, new RegExp(`^${ErrorCodes.REMOTE_NOT_WRITABLE}`));
});

test("writeFile：内容经 stdin 传，远端命令只含重定向；mkdir 用 mkdir -p", async () => {
	const session = makeSession();
	const ops = createRemoteWriteOps(session);

	await ops.writeFile("/srv/app/a.ts", "let x = 1;\n");
	await ops.mkdir("/srv/app/nested/dir");

	assert.equal(session.calls[0].args.at(-1), "LC_ALL=C cat > '/srv/app/a.ts'");
	assert.equal(session.calls[0].stdin?.toString(), "let x = 1;\n");
	assert.equal(session.calls[1].args.at(-1), "mkdir -p '/srv/app/nested/dir'");
});

test("writeFile：远端失败映射为 REMOTE_WRITE_FAILED", async () => {
	const session = makeSession(() => ({ exitCode: 1 }));
	const message = await failureOf(createRemoteWriteOps(session).writeFile("/srv/ro/a.ts", "x"));
	assert.match(message, new RegExp(`^${ErrorCodes.REMOTE_WRITE_FAILED}`));
});

test("ls 后端：exists / stat（d|f 标记）/ readdir 解析；readdir 预取类型使后续 stat 零 ssh（宿主 ls 对每条 entry 调 stat）", async () => {
	const session = makeSession((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.includes("printf 'd'")) return { stdout: Buffer.from("d") };
		if (command.startsWith("ls -A1p")) return { stdout: Buffer.from("src/\nREADME.md\n\n") };
		return {};
	});
	const ops = createRemoteLsOps(session);

	assert.equal(await ops.exists("/srv/app"), true);
	assert.equal((await ops.stat("/srv/app")).isDirectory(), true);
	assert.deepEqual(await ops.readdir("/srv/app"), ["src", "README.md"]);
	assert.match(session.calls[1].args.at(-1) ?? "", /printf 'd'/);

	// 预取后：目录带尾斜杠 ⇒ isDirectory true；文件 ⇒ false；两者都不再发 ssh。
	const callsAfterReaddir = session.calls.length;
	assert.equal((await ops.stat("/srv/app/src")).isDirectory(), true);
	assert.equal((await ops.stat("/srv/app/README.md")).isDirectory(), false);
	assert.equal(session.calls.length, callsAfterReaddir, "readdir 预取后 stat 不应再发 ssh");
});

test("ls 后端：stat 对不存在的路径抛 REMOTE_NOT_FOUND；exists 返回 false 而非抛错", async () => {
	const missing = makeSession((request) => ((request.args.at(-1) ?? "").startsWith("test -e") ? { exitCode: 1 } : { exitCode: 3 }));
	const ops = createRemoteLsOps(missing);

	assert.equal(await ops.exists("/srv/nope"), false);
	assert.match(await failureOf(ops.stat("/srv/nope")), new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`));
});

test("find 后端：优先远端 rg --files，带 glob/ignore/limit；缺 rg 时回退 find 并标记降级", async () => {
	const session = makeSession(() => ({ stdout: Buffer.from("/srv/app/a.ts\n/srv/app/b.ts\n") }));
	const ops = createRemoteFindOps(session);

	const result = await ops.glob("**/*.ts", "/srv/app", { ignore: ["**/node_modules/**", "**/.git/**"], limit: 50 });
	assert.deepEqual(result.entries, ["/srv/app/a.ts", "/srv/app/b.ts"]);
	assert.equal(result.degraded, false);

	const command = session.calls[0].args.at(-1) ?? "";
	assert.match(command, /^if command -v rg >\/dev\/null 2>&1; then rg --files /);
	assert.match(command, /rg --files/);
	assert.match(command, /--glob '\*\*\/\*\.ts'/);
	assert.match(command, /--glob '!\*\*\/node_modules\/\*\*'/);
	assert.match(command, /head -n 50/);
	assert.match(command, /else printf/);

	const degraded = makeSession(() => ({ stdout: Buffer.from("/srv/app/b.ts\n"), stderr: `${DEGRADED_MARKER}\n` }));
	const fallback = await createRemoteFindOps(degraded).glob("*.ts", "/srv/app", { ignore: [], limit: 10 });
	assert.deepEqual(fallback.entries, ["/srv/app/b.ts"]);
	assert.equal(fallback.degraded, true);
	assert.match(degraded.calls[0].args.at(-1) ?? "", /find '\/srv\/app'/);
});

test("bash 后端：cd 失败用专用退出码、只转发白名单会话变量（不泄漏其它 PI_*）、退出码透传、流式分片原样转发", async () => {
	const session = makeSession(() => ({ exitCode: 7 }));
	const ops = createRemoteBashOps(session);
	const chunks: string[] = [];

	const { exitCode } = await ops.exec("ls -la", "/srv/app", {
		onData: (chunk: Buffer) => chunks.push(chunk.toString()),
		timeout: undefined,
		env: { PATH: "/usr/bin", PI_SESSION_ID: "abc", PI_MODEL: "m", PI_WEB_TOKEN: "secret", PI_CODING_AGENT: "true" },
	});

	assert.equal(exitCode, 7);
	assert.deepEqual(chunks, []);
	assert.equal(session.calls[0].args.at(-1), "cd '/srv/app' || exit 201; PI_SESSION_ID='abc' PI_MODEL='m' ls -la");

	// 流式：假 ssh 在返回前把分片喂给 onData，ops 必须原样转发（含 stderr 分片）。
	const streaming = makeExec(() => ({ exitCode: 0 }));
	const streamSession = Object.assign(createRemoteSession({ target: TARGET, exec: streaming.exec, homeDir: "/home/deploy" }), streaming);
	const streamChunks: string[] = [];
	const live = createRemoteBashOps(streamSession).exec("echo hi", "/srv/app", {
		onData: (chunk: Buffer) => streamChunks.push(chunk.toString()),
		timeout: undefined,
	});
	const recorded = streaming.calls.at(-1);
	recorded?.onData?.(Buffer.from("stdout-chunk"));
	recorded?.onData?.(Buffer.from("stderr-chunk"));
	await live;
	assert.deepEqual(streamChunks, ["stdout-chunk", "stderr-chunk"]);
});

test("bash 后端：超时抛 timeout:<秒>、中止抛 aborted（与内置本地后端同形态）", async () => {
	const timedOut = makeSession(() => ({ exitCode: null, timedOut: true }));
	const timeoutMessage = await failureOf(createRemoteBashOps(timedOut).exec("sleep 99", "/srv/app", { onData: () => {}, timeout: 3 }));
	assert.equal(timeoutMessage, `timeout:3`);

	const aborted = makeSession(() => ({ exitCode: null, aborted: true }));
	const controller = new AbortController();
	const promise = createRemoteBashOps(aborted).exec("sleep 99", "/srv/app", { onData: () => {}, signal: controller.signal, timeout: undefined });
	controller.abort();
	assert.equal(await failureOf(promise), "aborted");
});

test("bash 后端：连接失败/远端目录不存在给出结构化错误", async () => {
	const broken = makeSession(() => ({ exitCode: 255, stderr: "Host key verification failed." }));
	assert.match(await failureOf(createRemoteBashOps(broken).exec("ls", "/srv/app", { onData: () => {}, timeout: undefined })), new RegExp(`^${ErrorCodes.SSH_CONNECT_FAILED}`));

	const noDir = makeSession(() => ({ exitCode: 201 }));
	assert.match(await failureOf(createRemoteBashOps(noDir).exec("ls", "/srv/gone", { onData: () => {}, timeout: undefined })), /不存在的远端目录/);
});

test("路径校验先于 ssh：相对路径/Windows 路径直接报错且不发任何远端命令", async () => {
	const session = makeSession();
	const readOps = createRemoteReadOps(session);
	const lsOps = createRemoteLsOps(session);

	assert.match(await failureOf(readOps.readFile("src/a.ts")), new RegExp(`^${ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE}`));
	assert.match(await failureOf(lsOps.readdir("C:\\tmp")), new RegExp(`^${ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE}`));
	assert.equal(session.calls.length, 0);
});

/* ── 远端 read 的图片识别（remote-tools#8）──────────────────────────────────
 * 宿主 read 只在 ops 提供了 detectImageMimeType 时才走图片管线（read.js:80），否则把 PNG 当文本读。
 * 下面断言三件事：样本取不取得到、判定交给谁（宿主同一份实现）、往返次数有没有涨。
 */

const SNIFF_COMMAND = /if \[ ! -e .* \]; then exit 3; elif \[ -d .* \]; then exit 0; elif \[ ! -r .* \]; then exit 1; else head -c 8192 .* \| base64 \|\| true; fi/;

/** 假 ssh：嗅探命令回样本的 base64（真实 ssh 就是这样把字节带回来的），其余命令走 inner。 */
function sniffingExec(sample: Buffer, inner: (request: SshExecRequest) => Partial<SshExecResult> = () => ({})): RemoteSession & ScriptedExec {
	const scripted = makeExec((request) => {
		if ((request.args.at(-1) ?? "").includes("head -c")) return { stdout: Buffer.from(sample.toString("base64")) };
		return inner(request);
	});
	const session = createRemoteSession({ target: TARGET, exec: scripted.exec, homeDir: "/home/deploy" });
	return Object.assign(session, scripted);
}

test("远端 read 图片识别：样本搭 access 的顺风车（合计一条 ssh），PNG 判成 image/png", async () => {
	const session = sniffingExec(png1x1());
	const ops = createRemoteReadOps(session);

	await ops.access("/srv/app/pic.png");
	assert.equal(await ops.detectImageMimeType?.("/srv/app/pic.png"), "image/png");
	assert.equal(session.calls.length, 1, "access + detect 必须只发一条 ssh（不给每次 read 加往返）");
	assert.match(session.calls[0].args.at(-1) ?? "", SNIFF_COMMAND);
	assert.match(session.calls[0].args.at(-1) ?? "", /head -c 8192 '\/srv\/app\/pic\.png'/);
});

test("远端 read 图片识别：样本交给宿主导出的同一实现判定（正例/反例都按宿主规则）", async () => {
	const cases: Array<[string, Buffer, string | null]> = [
		["png", png1x1(), "image/png"],
		["jpeg", jpegSample(), "image/jpeg"],
		["gif", gifSample(), "image/gif"],
		["webp", webpSample(), "image/webp"],
		["bmp", bmpSample(), "image/bmp"],
		["有损 DC 帧 JPEG", losslessJpegSample(), null],
		["动图 PNG（acTL 早于 IDAT）", animatedPngSample(), null],
		["文本", textSample(), null],
		["空样本", Buffer.alloc(0), null],
	];

	for (const [label, sample, expected] of cases) {
		const session = sniffingExec(sample);
		const ops = createRemoteReadOps(session);
		await ops.access("/srv/app/sample.bin");
		assert.equal(await ops.detectImageMimeType?.("/srv/app/sample.bin"), expected, label);
		assert.equal(session.calls.length, 1, `${label}：不应多发 ssh`);
	}
});

test("远端 read 图片识别：detect 单独调用（未先 access）也工作，只发一条嗅探命令", async () => {
	const session = sniffingExec(png1x1());
	const ops = createRemoteReadOps(session);

	assert.equal(await ops.detectImageMimeType?.("/srv/app/pic.png"), "image/png");
	assert.equal(session.calls.length, 1);
	assert.match(session.calls[0].args.at(-1) ?? "", SNIFF_COMMAND);
});

test("远端 read 图片识别：不存在/不可读沿既有错误码；目录放行且样本为空 ⇒ 不是图片", async () => {
	const missing = makeSession(() => ({ exitCode: 3 }));
	assert.match(await failureOf(createRemoteReadOps(missing).access("/srv/nope")), new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`));

	const unreadable = makeSession(() => ({ exitCode: 1 }));
	assert.match(await failureOf(createRemoteReadOps(unreadable).access("/srv/secret")), new RegExp(`^${ErrorCodes.REMOTE_NOT_READABLE}`));

	const directory = makeSession(() => ({ stdout: Buffer.alloc(0) }));
	const ops = createRemoteReadOps(directory);
	await ops.access("/srv/app");
	assert.equal(await ops.detectImageMimeType?.("/srv/app"), null);
});

test("远端 $HOME：懒解析一次并缓存，失败不毒化缓存（下次调用重试）", async () => {
	let attempts = 0;
	const scripted = makeExec((request) => {
		if (!(request.args.at(-1) ?? "").includes("${HOME")) return {};
		attempts++;
		return attempts === 1 ? { exitCode: 255, stderr: "ssh: connect to host 10.0.0.7 port 22: Connection timed out" } : { stdout: Buffer.from("/home/deploy\n") };
	});
	const session = createRemoteSession({ target: TARGET, exec: scripted.exec });

	assert.match(await failureOf(session.home()), new RegExp(`^${ErrorCodes.SSH_CONNECT_FAILED}`));
	assert.equal(await session.home(), "/home/deploy", "一次失败后必须能重试成功");
	assert.equal(await session.home(), "/home/deploy");
	assert.equal(attempts, 2, "成功后就该缓存住，不再探测");

	const failing = makeExec(() => ({ stdout: Buffer.from("\n") }));
	const failingSession = createRemoteSession({ target: TARGET, exec: failing.exec });
	assert.match(await failureOf(failingSession.home()), new RegExp(`^${ErrorCodes.REMOTE_NOT_FOUND}`));
});
