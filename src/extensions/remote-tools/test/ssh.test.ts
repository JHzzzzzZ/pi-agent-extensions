/*
 * remote-tools — SSH 传输层测试（先写测试，实现见 ../ssh.ts）。
 *
 * 边界与动机：本文件只测**纯逻辑与策略**（目标解析、参数构造、路径校验、失败分类），
 * 真实 ssh 进程由注入的 `SshExec` 假实现替代（进程边界手写 fake，见 AGENTS.md 测试约定）；
 * 真机行为由 test/remote-live.test.ts 的 opt-in 用例覆盖。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ErrorCodes } from "../errors.ts";
import {
	buildSshArgs,
	classifySshFailure,
	type SshExec,
	type SshExecRequest,
	type SshExecResult,
	parseTarget,
	runSsh,
	shellQuote,
	validateRemotePath,
} from "../ssh.ts";

function makeFakeExec(result: Partial<SshExecResult> = {}): { calls: SshExecRequest[]; exec: SshExec } {
	const calls: SshExecRequest[] = [];
	const exec: SshExec = async (request) => {
		calls.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...result };
	};
	return { calls, exec };
}

test("本地模式：remote 省略、空串、纯空白都得到 null 目标", () => {
	for (const remote of [undefined, "", "   "]) {
		const parsed = parseTarget({ remote });
		assert.equal(parsed.ok, true);
		assert.equal(parsed.ok && parsed.target, null);
	}
});

test("目标解析：user@host / 只有 host / 端口覆盖", () => {
	const withUser = parseTarget({ remote: "deploy@10.0.0.7" });
	assert.deepEqual(withUser, { ok: true, target: { host: "10.0.0.7", user: "deploy", port: undefined } });

	const hostOnly = parseTarget({ remote: "build-box" });
	assert.deepEqual(hostOnly, { ok: true, target: { host: "build-box", user: undefined, port: undefined } });

	const withPort = parseTarget({ remote: " deploy@10.0.0.7 ", remotePort: 2222 });
	assert.deepEqual(withPort, { ok: true, target: { host: "10.0.0.7", user: "deploy", port: 2222 } });
});

test("非法端口：正数越界与非整数 fail-closed（真错的仍拦）", () => {
	for (const remotePort of [65536, 22.5]) {
		const parsed = parseTarget({ remote: "host", remotePort });
		assert.equal(parsed.ok, false);
		assert.equal(parsed.ok === false && parsed.code, ErrorCodes.INVALID_REMOTE_PORT);
	}
});

test("缺省值字面量当「未提供」：null/undefined/nil/none/n/a 走本机；自由字符串仍当主机名", () => {
	// 用户实测：agent 把 JSON null 序列化成字符串 "null"，被当主机名去 ssh → SSH_CONNECT_FAILED
	for (const remote of ["null", "NULL", " None ", "undefined", "nil", "Nil", "n/a", "NA"]) {
		const parsed = parseTarget({ remote, remotePort: 0 });
		assert.deepEqual(parsed, { ok: true, target: null }, `${remote} 应视为未提供（本地）`);
	}

	// 自由字符串一律不猜：仍当主机名（连不上就响亮报错，绝不静默跑本机）
	for (const remote of ["local", "false", "true", "myhost", "nas", "nullhost"]) {
		const parsed = parseTarget({ remote });
		assert.equal(parsed.ok && parsed.target?.host, remote, `${remote} 仍应被当主机名`);
	}
});

test("非法目标：空 user/host、多 @、带空格、前导 -、内嵌端口都拒绝", () => {
	const cases = ["@host", "user@", "user@a@b", "host name", "-oProxyCommand=bash", "host:22", "user@@host"];
	for (const remote of cases) {
		const parsed = parseTarget({ remote });
		assert.equal(parsed.ok, false, `应拒绝 ${JSON.stringify(remote)}`);
		assert.equal(parsed.ok === false && parsed.code, ErrorCodes.INVALID_REMOTE_TARGET);
	}
});

test("采样器噪声不得打断调用：remotePort 为 0 / null / 非数字 / 负数 一律当「未提供」", () => {
	// 本地模式：忽略一切 remotePort（用户实测：本地 read 被 remotePort: 0 打断）
	for (const remotePort of [0, null, undefined, "22", Number.NaN, -1, {}, [], 70000]) {
		const local = parseTarget({ remote: undefined, remotePort });
		assert.deepEqual(local, { ok: true, target: null }, `本地模式应忽略 ${JSON.stringify(remotePort)}`);
		const blank = parseTarget({ remote: "   ", remotePort });
		assert.deepEqual(blank, { ok: true, target: null }, `空白 remote 应视为本地（${JSON.stringify(remotePort)}）`);
	}

	// 远端模式：端口当未指定（用 ssh 默认或 ~/.ssh/config），不报错
	for (const remotePort of [0, null, undefined, "2222", Number.NaN, -1]) {
		const parsed = parseTarget({ remote: "deploy@10.0.0.7", remotePort });
		assert.deepEqual(parsed, { ok: true, target: { host: "10.0.0.7", user: "deploy", port: undefined } }, `应视为未指定端口：${JSON.stringify(remotePort)}`);
	}

	// remote 本身是噪声也一样：非字符串/空串 = 本地
	for (const remote of [null, 22, {}, [], ""]) {
		const parsed = parseTarget({ remote, remotePort: 0 });
		assert.deepEqual(parsed, { ok: true, target: null }, `非字符串 remote 应为本地：${JSON.stringify(remote)}`);
	}
});

test("ssh 参数：非交互、拒绝未知指纹、连接超时、端口可选、远端命令是最后一个参数", () => {
	const args = buildSshArgs({ host: "h", user: "u", port: 2222 }, "cat /srv/x");
	assert.deepEqual(args, [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ConnectTimeout=10",
		"-p",
		"2222",
		"u@h",
		"cat /srv/x",
	]);

	const noPort = buildSshArgs({ host: "h", user: undefined, port: undefined }, "true");
	assert.equal(noPort.includes("-p"), false);
	assert.equal(noPort.at(-2), "h");
	assert.equal(noPort.at(-1), "true");
});

test("远端命令里的路径必须经 shell 单引号转义", () => {
	assert.equal(shellQuote("/srv/my app/x.ts"), "'/srv/my app/x.ts'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
});

test("远端路径必须是绝对 POSIX 路径：相对路径与 Windows 路径拒绝", () => {
	assert.equal(validateRemotePath("/srv/app/src/index.ts").ok, true);
	assert.equal(validateRemotePath("/").ok, true);

	for (const bad of ["src/index.ts", "./x", "C:\\Users\\me\\x.ts", "C:/Users/me/x.ts", "~/.bashrc"]) {
		const checked = validateRemotePath(bad);
		assert.equal(checked.ok, false, `应拒绝 ${bad}`);
		assert.equal(checked.ok === false && checked.code, ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE);
	}
});

test("runSsh：透传退出码与标准输出，stdin 原样交给假实现", async () => {
	const { calls, exec } = makeFakeExec({ exitCode: 3, stdout: Buffer.from("out"), stderr: "err" });
	const result = await runSsh(exec, { host: "h", user: "u", port: undefined }, "cat /x", {
		stdin: Buffer.from("body"),
		timeoutMs: 1234,
	});
	assert.equal(result.exitCode, 3);
	assert.equal(result.stdout.toString(), "out");
	assert.equal(result.stderr, "err");
	assert.equal(result.timedOut, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, "ssh");
	assert.equal(calls[0].timeoutMs, 1234);
	assert.equal(calls[0].stdin?.toString(), "body");
	assert.deepEqual(calls[0].args, buildSshArgs({ host: "h", user: "u", port: undefined }, "cat /x"));
});

test("失败分类：超时、ssh 客户端缺失、255 + 主机指纹/认证错误 → 连接类错误码", () => {
	assert.equal(classifySshFailure({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: true, spawnFailed: false })?.code, ErrorCodes.SSH_TIMEOUT);
	assert.equal(classifySshFailure({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: true })?.code, ErrorCodes.SSH_CONNECT_FAILED);

	for (const stderr of [
		"Host key verification failed.",
		"Permission denied (publickey).",
		"ssh: connect to host 10.0.0.7 port 22: Connection refused",
	]) {
		const failure = classifySshFailure({ exitCode: 255, stdout: Buffer.alloc(0), stderr, timedOut: false, spawnFailed: false });
		assert.equal(failure?.code, ErrorCodes.SSH_CONNECT_FAILED, stderr);
		assert.match(failure?.message ?? "", /ssh /, "错误消息要给出人工排查入口");
	}

	assert.equal(classifySshFailure({ exitCode: 1, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false }), null);
	assert.equal(classifySshFailure({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false }), null);
});
