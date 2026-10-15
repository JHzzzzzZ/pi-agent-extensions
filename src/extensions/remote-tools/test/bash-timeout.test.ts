/*
 * remote-tools — 远端 bash 超时转后台（remote-tools-todo#12）
 *
 * 边界与动机：这条路径的风险全在「真实进程边界下的计时与接管」——超时那一刻不能杀 ssh、
 * 输出要继续落盘、job 要登记给 owner、/bg:kill 要既能杀远端也要断开本地 ssh。所以
 *   - 传输层用**脚本化的假 ssh**（按请求脚本化完成/中止/超时，真实 promise 时序）；
 *   - 端口用真契约形状的假 owner（真 owner 的实现在 timeout-bg 侧另测）；
 *   - 工具层接线用**真 registerRemoteTools + 真 event bus**（证明端口索取确实接上了）。
 * 真 ssh 的端到端用例在 remote-live.test.ts（opt-in）。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, createEventBus } from "@earendil-works/pi-coding-agent";

import { type RemoteJobPort, SHELL_JOB_HOST_CHANNEL } from "../capability.ts";
import { ErrorCodes } from "../errors.ts";
import { createRemoteBashOps, createRemoteSession, type RemoteSession } from "../ops.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";
import { registerRemoteTools } from "../tools.ts";
import type { CommandRegistration } from "./fixtures.ts";
import { looseTargets } from "./fixtures.ts";

const TARGET = { host: "10.0.0.7", user: "deploy", port: undefined };
const HOME = "/home/deploy";

function result(overrides: Partial<SshExecResult> = {}): SshExecResult {
	return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...overrides };
}

/** 脚本化假 ssh：主命令挂住等你 finish/emit，`kill -TERM` 终止脚本立即成功。 */
class FakeSsh {
	readonly requests: SshExecRequest[] = [];
	private pending: Array<(value: SshExecResult) => void> = [];
	private streams: Array<(chunk: Buffer) => void> = [];

	readonly exec: SshExec = (request) => {
		this.requests.push(request);
		const command = request.args.at(-1) ?? "";
		if (command.includes("kill -TERM")) return Promise.resolve(result());
		return new Promise<SshExecResult>((resolve) => {
			this.pending.push(resolve);
			this.streams.push((chunk) => request.onData?.(chunk));
			request.signal?.addEventListener("abort", () => resolve(result({ exitCode: null, aborted: true })), { once: true });
		});
	};

	emit(text: string): void {
		for (const stream of this.streams) stream(Buffer.from(text, "utf8"));
	}

	finish(overrides: Partial<SshExecResult> = {}): void {
		const pending = this.pending;
		this.pending = [];
		this.streams = [];
		for (const resolve of pending) resolve(result(overrides));
	}

	/** 主命令（非终止脚本）请求。 */
	get main(): SshExecRequest {
		const found = this.requests.find((request) => !(request.args.at(-1) ?? "").includes("kill -TERM"));
		assert.ok(found !== undefined, "必须发过主命令");
		return found;
	}

	get killRequests(): SshExecRequest[] {
		return this.requests.filter((request) => (request.args.at(-1) ?? "").includes("kill -TERM"));
	}
}

interface RecordedRegistration {
	id: string;
	logPath: string;
	command: string;
	target: string;
	timeoutSeconds: number;
	tail: string;
	terminate: () => void;
}

function makeFakeOwner(logDir: string, options: { withBackground?: boolean } = {}) {
	const registrations: RecordedRegistration[] = [];
	const backgroundRegistrations: Array<Omit<RecordedRegistration, "timeoutSeconds">> = [];
	const settled: Array<{ id: string; exitCode: number | null }> = [];
	const host: RemoteJobPort = {
		allocate: () => ({ id: "bg-7", logPath: path.join(logDir, "bg-7.log") }),
		register: (job) => {
			registrations.push(job);
			return `⏱ 超时文本 ${job.id}`;
		},
		settle: (id, exitCode) => settled.push({ id, exitCode }),
	};
	// 旧版 owner（timeout-bg ≤ 1.2）没有 registerBackground：默认给上，要测旧版时显式关掉。
	if (options.withBackground !== false) {
		host.registerBackground = (job) => {
			backgroundRegistrations.push(job);
			return `⏸ 后台文本 ${job.id}`;
		};
	}
	return { host, registrations, backgroundRegistrations, settled };
}

function makeHarness() {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bash-job-"));
	const ssh = new FakeSsh();
	const owner = makeFakeOwner(logDir);
	const session: RemoteSession = createRemoteSession({ target: TARGET, exec: ssh.exec, homeDir: HOME });
	return { logDir, ssh, owner, session };
}

const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`等待超时：${what}`);
};

test("超时：不断连（传输层不给 timeout）+ 登记 job + 返回 owner 的文本；跑完 settle 记退出码", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => h.owner.host });
	const chunks: string[] = [];

	const pending = ops.exec("sleep 15; echo MARK", "/srv/app", {
		onData: (chunk: Buffer) => chunks.push(chunk.toString("utf8")),
		timeout: 0.05,
		env: {},
	});
	h.ssh.emit("partial-output\n");
	await assert.rejects(() => pending, /超时文本 bg-7/, "本次 tool call 以 owner 的单源文本结束");

	assert.equal(h.ssh.requests.length, 1, "只发了一条主命令（没有额外的探测往返）");
	assert.equal(h.ssh.main.timeoutMs, undefined, "托管路径下不得把超时交给传输层（那会杀 ssh）");
	const remoteCommand = h.ssh.main.args.at(-1) ?? "";
	assert.match(remoteCommand, /^cd '\/srv\/app' \|\| exit 201; /, "cwd 语义不变");
	assert.match(remoteCommand, /pi_remote_job_pidfile='\/tmp\/pi-remote-job-[0-9a-f-]+\.pid'/, "先写 pid 文件供 /bg:kill 定位");
	assert.match(remoteCommand, /trap 'rm -f "\$pi_remote_job_pidfile"' EXIT/, "正常结束要自己清掉 pid 文件");
	// TERM/HUP 必须显式 exit：只挂清理 trap 会让 shell 吞掉信号、继续跑下一条命令
	// （真机验收抓到过 `sleep N; printf ALIVE > marker` 在 /bg:kill 后仍写出标记）。
	assert.match(remoteCommand, /trap 'rm -f "\$pi_remote_job_pidfile"; exit 143' TERM/);
	assert.match(remoteCommand, /trap 'rm -f "\$pi_remote_job_pidfile"; exit 129' HUP/);
	assert.match(remoteCommand, /sleep 15; echo MARK$/, "命令原文原样在最后");

	const registration = h.owner.registrations[0];
	assert.ok(registration !== undefined);
	assert.equal(registration.id, "bg-7");
	assert.equal(registration.target, "deploy@10.0.0.7");
	assert.equal(registration.command, "sleep 15; echo MARK");
	assert.equal(registration.timeoutSeconds, 0.05);
	assert.match(registration.tail, /partial-output/);
	assert.equal(typeof registration.terminate, "function");
	await waitFor(() => fs.existsSync(registration.logPath), "日志文件创建");
	assert.match(fs.readFileSync(registration.logPath, "utf8"), /partial-output/, "超时之前的输出也要在日志里");

	// 转后台之后：输出只进日志，不再进 tool call 的流（与本地 timeout-bg 同口径）。
	h.ssh.emit("late-output\n");
	await waitFor(() => fs.readFileSync(registration.logPath, "utf8").includes("late-output"), "后台输出继续落盘");
	assert.equal(chunks.join("").includes("late-output"), false, "后台输出不再回灌已结束的 tool call");

	h.ssh.finish({ exitCode: 0 });
	await waitFor(() => h.owner.settled.length === 1, "命令自然结束后 settle");
	assert.deepEqual(h.owner.settled[0], { id: "bg-7", exitCode: 0 });
});

test("/bg:kill（terminate）：先尽力杀远端进程组，再断开本地 ssh（本地 ssh 的 signal 被 abort）", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => h.owner.host });
	const pending = ops.exec("sleep 400", "/srv/app", { onData: () => {}, timeout: 0.05, env: {} });
	await assert.rejects(() => pending, /超时文本 bg-7/);

	const pidFile = /pi_remote_job_pidfile='([^']+)'/.exec(h.ssh.main.args.at(-1) ?? "")?.[1];
	assert.ok(pidFile !== undefined);

	h.owner.registrations[0]!.terminate();
	assert.equal(h.ssh.main.signal?.aborted, true, "本地 ssh 必须被断开（远端杀失败时的退化路径）");
	await waitFor(() => h.ssh.killRequests.length === 1, "发一条远端终止命令");
	const killCommand = h.ssh.killRequests[0]!.args.at(-1) ?? "";
	assert.ok(killCommand.includes(pidFile), `终止命令要读同一个 pid 文件：${killCommand}`);
	assert.match(killCommand, /kill -TERM -- "-\$pid"/, "先按进程组 TERM");
	assert.match(killCommand, /pkill -TERM -P "\$pid"/, "进程组杀不动时按子进程杀");
	assert.match(killCommand, /kill -KILL/, "TERM 无效时补 KILL");
});

test("未超时：正常回退出码、不登记 job；日志仍然全量落盘", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => h.owner.host });
	const chunks: string[] = [];
	const pending = ops.exec("echo hi", HOME, { onData: (chunk: Buffer) => chunks.push(chunk.toString("utf8")), timeout: 30, env: {} });
	h.ssh.emit("hi\n");
	h.ssh.finish({ exitCode: 3 });
	assert.deepEqual(await pending, { exitCode: 3 });
	assert.equal(chunks.join(""), "hi\n", "未超时时输出照常流回模型");
	assert.deepEqual(h.owner.registrations, [], "只有真的超时才进 job 面");
	const logPath = path.join(h.logDir, "bg-7.log");
	assert.equal(fs.readFileSync(logPath, "utf8"), "hi\n");
});

test("register 抛错（端口异常）：断开本地 ssh + 带错误码的结构化错误 + notify，不静默当作已杀", async () => {
	const h = makeHarness();
	const notified: string[] = [];
	const settledIds: string[] = [];
	const brokenHost: RemoteJobPort = {
		allocate: () => ({ id: "bg-9", logPath: path.join(h.logDir, "bg-9.log") }),
		register: () => {
			throw new Error("port boom");
		},
		settle: (id) => settledIds.push(id),
	};
	const ops = createRemoteBashOps(h.session, { jobHost: () => brokenHost, notify: (message) => notified.push(message) });
	const pending = ops.exec("sleep 400", HOME, { onData: () => {}, timeout: 0.05, env: {} });
	await assert.rejects(() => pending, new RegExp(ErrorCodes.REMOTE_BACKGROUND_FAILED));
	assert.equal(h.ssh.main.signal?.aborted, true, "转后台失败必须断开本地 ssh（不能留下看不见的孤儿）");
	assert.equal(notified.length, 1, "失败要可见（notify 一次）");
	// 登记没成功 ⇒ 绝不能对未登记的 id 调 settle（契约只保证「kill 过的忽略」，不保证「未登记的忽略」）。
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(settledIds, []);
});

test("register 抛端口契约错误：错误码原样透传（不把归因吞成转后台失败）", async () => {
	const h = makeHarness();
	const portFailure = `${ErrorCodes.REMOTE_JOB_PORT_INVALID}: job 托管端口未返回超时结果文本。`;
	const brokenHost: RemoteJobPort = {
		allocate: () => ({ id: "bg-9", logPath: path.join(h.logDir, "bg-9.log") }),
		register: () => {
			throw new Error(portFailure);
		},
		settle: () => {},
	};
	const ops = createRemoteBashOps(h.session, { jobHost: () => brokenHost });
	const message = await ops
		.exec("sleep 400", HOME, { onData: () => {}, timeout: 0.05, env: {} })
		.then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	assert.equal(message, portFailure, "端口自己的错误码不能洗掉（排障要知道是端口不合契约）");
	assert.equal(h.ssh.main.signal?.aborted, true, "仍然要断开本地 ssh");
});

test("日志建不出来：回退旧路径（远端命令照跑）+ notify 一次", async () => {
	const h = makeHarness();
	const blocker = path.join(h.logDir, "not-a-dir");
	fs.writeFileSync(blocker, "x");
	const notified: string[] = [];
	const host: RemoteJobPort = {
		allocate: () => ({ id: "bg-9", logPath: path.join(blocker, "bg-9.log") }),
		register: () => "text",
		settle: () => {},
	};
	const ops = createRemoteBashOps(h.session, { jobHost: () => host, notify: (message) => notified.push(message) });
	const pending = ops.exec("sleep 400", HOME, { onData: () => {}, timeout: 0.05, env: {} });
	assert.equal(h.ssh.main.timeoutMs, 50, "回退到旧路径后超时交给传输层");
	h.ssh.finish({ timedOut: true });
	await assert.rejects(() => pending, /^Error: timeout:0\.05$/);
	assert.equal(notified.length, 1);
});

test("显式 timeout 非法：fail-closed，不 spawn、不占号（与宿主同一句文案）", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => h.owner.host });
	await assert.rejects(
		() => ops.exec("echo hi", HOME, { onData: () => {}, timeout: 0, env: {} }),
		/Invalid timeout: must be a finite number of seconds/,
	);
	assert.equal(h.ssh.requests.length, 0);
});

test("没装 timeout-bg（拿不到端口）：行为与今天逐字一致——传输层超时 + timeout:<秒>", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session);
	const pending = ops.exec("sleep 400", HOME, { onData: () => {}, timeout: 0.05, env: {} });
	assert.equal(h.ssh.main.timeoutMs, 50, "旧路径把超时交给传输层");
	assert.doesNotMatch(h.ssh.main.args.at(-1) ?? "", /pi_remote_job_pidfile/, "没有 job 托管时不写 pid 文件");
	h.ssh.finish({ exitCode: null, timedOut: true });
	await assert.rejects(() => pending, /^Error: timeout:0\.05$/);
});

test("工具层接线：真 registerRemoteTools + 真 event bus 索取端口（只索取一次），远端调用走托管路径", async () => {
	const bus = createEventBus();
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bash-wire-"));
	const owner = makeFakeOwner(logDir);
	let offers = 0;
	// 模拟 timeout-bg 的应答端：谁 emit 空盒子就把端口填进去（先到先得）。
	bus.on(SHELL_JOB_HOST_CHANNEL, (box) => {
		offers += 1;
		(box as { host?: unknown }).host = owner.host;
	});

	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, CommandRegistration>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: CommandRegistration) {
			commands.set(name, options);
		},
		events: bus,
	} as unknown as ExtensionAPI;
	const ssh = new FakeSsh();
	registerRemoteTools(pi, { exec: ssh.exec, cwd: process.cwd(), targets: looseTargets() });
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;

	const pending = tools
		.get("bash")!
		.execute("call-1", { command: "sleep 400", remote: "deploy@10.0.0.7", remoteCwd: "/srv/app", timeout: 0.05 }, undefined, undefined, ctx);
	await assert.rejects(() => pending, /超时文本 bg-7/, "工具层必须把超时交给 job 托管（不再走宿主 kill 文案）");
	assert.equal(owner.registrations.length, 1);
	assert.equal(offers, 1, "端口只索取一次（缓存）");

	// 第二次远端调用复用缓存的端口：不再 emit。
	const second = tools
		.get("bash")!
		.execute("call-2", { command: "sleep 400", remote: "deploy@10.0.0.7", remoteCwd: "/srv/app", timeout: 0.05 }, undefined, undefined, ctx);
	await assert.rejects(() => second, /超时文本 bg-7/);
	assert.equal(offers, 1, "缓存命中：不重复索取");
});

test("主动后台（run_in_background）：ssh 一启动就登记，本次调用以 owner 的文本结束；跑完 settle 记退出码", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => h.owner.host, runInBackground: true });
	const message = await ops
		.exec("npm run build", HOME, { onData: () => {}, env: {} })
		.then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	assert.equal(message, "⏸ 后台文本 bg-7", "结果文本由 owner 单源提供（提供方不自己拼）");
	assert.equal(h.owner.backgroundRegistrations.length, 1, "不等超时就登记");
	assert.deepEqual(h.owner.registrations, [], "不得走超时登记");
	assert.equal(h.ssh.main.timeoutMs, undefined, "托管路径自己计时；后台更是完全没有计时器");
	assert.match(h.ssh.main.args.at(-1) ?? "", /pi_remote_job_pidfile/, "后台 job 仍要写 pid 文件（/bg:kill 靠它）");
	assert.deepEqual(h.owner.settled, [], "命令还在跑，不能提前 settle");

	h.ssh.finish({ exitCode: 0 });
	await waitFor(() => h.owner.settled.length === 1, "跑完 settle");
	assert.deepEqual(h.owner.settled, [{ id: "bg-7", exitCode: 0 }]);
});

test("主动后台：拿不到托管端口（没装 timeout-bg）⇒ fail-closed，不 spawn 也不退回旧路径", async () => {
	const h = makeHarness();
	const ops = createRemoteBashOps(h.session, { jobHost: () => null, runInBackground: true });
	await assert.rejects(
		() => ops.exec("npm run build", HOME, { onData: () => {}, env: {} }),
		new RegExp(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED),
	);
	assert.equal(h.ssh.requests.length, 0, "拒绝执行：不 spawn、不前台等待");
});

test("主动后台：端口是旧版（没有 registerBackground）⇒ fail-closed", async () => {
	const h = makeHarness();
	const legacy = makeFakeOwner(h.logDir, { withBackground: false });
	const ops = createRemoteBashOps(h.session, { jobHost: () => legacy.host, runInBackground: true });
	await assert.rejects(
		() => ops.exec("npm run build", HOME, { onData: () => {}, env: {} }),
		new RegExp(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED),
	);
	assert.equal(h.ssh.requests.length, 0);
	assert.deepEqual(legacy.registrations, [], "旧端口不能收到登记");
});

test("主动后台：显式 timeout 仍按宿主同文案校验（非法值 fail-closed）；合法值不装计时器", async () => {
	const invalid = makeHarness();
	const invalidOps = createRemoteBashOps(invalid.session, { jobHost: () => invalid.owner.host, runInBackground: true });
	await assert.rejects(
		() => invalidOps.exec("echo hi", HOME, { onData: () => {}, timeout: 0, env: {} }),
		/Invalid timeout: must be a finite number of seconds/,
	);
	assert.equal(invalid.ssh.requests.length, 0, "非法 timeout 先于 spawn 拒绝");

	const ok = makeHarness();
	const okOps = createRemoteBashOps(ok.session, { jobHost: () => ok.owner.host, runInBackground: true });
	await okOps.exec("sleep 400", HOME, { onData: () => {}, timeout: 0.05, env: {} }).catch(() => undefined);
	assert.equal(ok.owner.backgroundRegistrations.length, 1);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.deepEqual(ok.owner.settled, [], "0.05s 早已过去，但后台不装计时器");
});

test("主动后台 + 日志建不出来：fail-closed（不 spawn、不回退旧路径的前台等待）", async () => {
	const h = makeHarness();
	const blocker = path.join(h.logDir, "not-a-dir");
	fs.writeFileSync(blocker, "x");
	const host: RemoteJobPort = {
		allocate: () => ({ id: "bg-9", logPath: path.join(blocker, "bg-9.log") }),
		register: () => "text",
		registerBackground: () => "text",
		settle: () => {},
	};
	const ops = createRemoteBashOps(h.session, { jobHost: () => host, runInBackground: true });
	await assert.rejects(
		() => ops.exec("npm run build", HOME, { onData: () => {}, env: {} }),
		new RegExp(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED),
	);
	assert.equal(h.ssh.requests.length, 0, "拒绝执行（不留孤儿 ssh）");
});

test("工具层接线：run_in_background 抵达远端登记（剥掉的只是宿主定义那一份），本地分支不受影响", async () => {
	const bus = createEventBus();
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bash-wire-bg-"));
	const owner = makeFakeOwner(logDir);
	bus.on(SHELL_JOB_HOST_CHANNEL, (box) => {
		(box as { host?: unknown }).host = owner.host;
	});

	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand: () => undefined,
		events: bus,
	} as unknown as ExtensionAPI;
	const ssh = new FakeSsh();
	registerRemoteTools(pi, { exec: ssh.exec, cwd: process.cwd(), targets: looseTargets() });
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;

	await assert.rejects(
		() =>
			tools
				.get("bash")!
				.execute("call-1", { command: "npm run build", remote: "deploy@10.0.0.7", remoteCwd: "/srv/app", run_in_background: true }, undefined, undefined, ctx),
		/⏸ 后台文本 bg-7/,
	);
	assert.equal(owner.backgroundRegistrations.length, 1, "参数经工具层一路抵达远端登记");
	assert.match(ssh.main.args.at(-1) ?? "", /npm run build/);
});
