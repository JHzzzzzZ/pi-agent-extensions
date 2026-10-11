/*
 * remote-tools — 跨扩展能力载荷测试（remote-tools-todo#9 的提供方一侧）。
 *
 * 边界与动机：本模块的风险在「与 owner 的约定」与「远端分支只有一份实现」——
 * 事件总线用**宿主真实的 createEventBus**（验证 emit 是同步派发、订阅方在 emit 返回前把盒子填好），
 * 进程边界仍用注入的假 ssh；host 的 ExtensionAPI 用结构 fake（宿主交互不在本测试范围）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, createEventBus } from "@earendil-works/pi-coding-agent";

import { type RemoteBashCapability, SHELL_CAPABILITY_CHANNEL, isRemoteBashCall } from "../capability.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";
import { registerRemoteTools } from "../tools.ts";

const ID = "call-1";
const REMOTE = "deploy@10.0.0.7";
const HOME = "/home/deploy";

function makeRecorder(handler: (request: SshExecRequest) => Partial<SshExecResult> = () => ({})) {
	const tools = new Map<string, ToolDefinition>();
	const calls: SshExecRequest[] = [];
	const exec: SshExec = async (request) => {
		calls.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
	};
	const bus = createEventBus();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		events: bus,
	} as unknown as ExtensionAPI;
	registerRemoteTools(pi, { exec, cwd: process.cwd() });
	return { tools, calls, bus };
}

function ctxFor(cwd: string): ExtensionToolContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
}

/** 从真实事件总线里取出本扩展放进盒子的能力（同时覆盖订阅路径）。 */
function collectCapability(bus: { emit: (channel: string, data: unknown) => void }): RemoteBashCapability {
	const box: { bash?: unknown } = {};
	bus.emit(SHELL_CAPABILITY_CHANNEL, box);
	assert.notEqual(box.bash, undefined, "订阅方必须同步填充盒子（emit 返回前）");
	return box.bash as RemoteBashCapability;
}

test("isRemoteBashCall：空串/缺省值字面量/非字符串 ⇒ 本机；正常目标与**形态非法目标** ⇒ 远端", () => {
	for (const params of [
		{},
		{ remote: "" },
		{ remote: "   " },
		{ remote: null },
		{ remote: 42 },
		{ remote: "null" },
		{ remote: "N/A" },
		{ remote: "undefined" },
		// 本地模式完全忽略 remotePort（remote-tools#5 的采样器噪声口径）。
		{ remotePort: 0 },
		{ remotePort: 70000 },
	]) {
		assert.equal(isRemoteBashCall(params), false, `应判本机：${JSON.stringify(params)}`);
	}

	for (const params of [
		{ remote: REMOTE },
		{ remote: "prod" },
		{ remote: "deploy@10.0.0.7", remotePort: 2222 },
		// 形态非法也是「有远端意图」：必须交给远端分支报结构化错误，绝不静默落本机。
		{ remote: "-oProxyCommand=x" },
		{ remote: "bad host" },
		{ remote: "user@host:2222" },
		{ remote: "deploy@10.0.0.7", remotePort: 70000 },
	]) {
		assert.equal(isRemoteBashCall(params), true, `应判远端：${JSON.stringify(params)}`);
	}
});

test("offerBashCapability：畸形盒子忽略、先到先得（不覆盖别的提供方）、订阅本身失败不抛", () => {
	const recorder = makeRecorder();
	for (const box of [null, "box", 42, undefined]) {
		assert.doesNotThrow(() => recorder.bus.emit(SHELL_CAPABILITY_CHANNEL, box));
	}

	const occupied = { bash: "another-provider" as unknown };
	recorder.bus.emit(SHELL_CAPABILITY_CHANNEL, occupied);
	assert.equal(occupied.bash, "another-provider", "槽位已有主时不得覆盖");

	const capability = collectCapability(recorder.bus);
	assert.equal(typeof capability.executeRemote, "function");
	assert.equal(typeof capability.isRemoteCall, "function");
	assert.ok(Object.keys(capability.parameters).includes("remoteCwd"), "bash 的参数片段必须带 remoteCwd");
	assert.ok((capability.guideline ?? "").length > 0);

	// 没有事件总线（旧宿主 / 结构 fake）也必须能注册成功：协商不可用，自身 bash 仍在。
	const pi = { registerTool: () => undefined } as unknown as ExtensionAPI;
	assert.doesNotThrow(() => registerRemoteTools(pi, { exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false }), cwd: process.cwd() }));
});

test("能力载荷的 executeRemote 与自身注册的 bash 共用同一远端实现（同一条命令）", async () => {
	const recorder = makeRecorder((request) => {
		const command = request.args.at(-1) ?? "";
		if (command.includes("${HOME")) return { stdout: Buffer.from(`${HOME}\n`) };
		return {};
	});
	const capability = collectCapability(recorder.bus);

	await capability.executeRemote(ID, { command: "uname -s", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));
	await recorder.tools.get("bash")!.execute(ID, { command: "uname -s", remote: REMOTE }, undefined, undefined, ctxFor(process.cwd()));

	assert.equal(recorder.calls.length, 3, "HOME 解析一次 + 两次远端执行（能力与工具共用一个 session 缓存）");
	assert.match(recorder.calls[0].args.at(-1) ?? "", /\$\{HOME:-\}/, "第一次调用解析远端 $HOME");
	assert.match(recorder.calls[1].args.at(-1) ?? "", /^cd '\/home\/deploy' \|\| exit 201; (PI_[A-Z_]+='[^']*' )*uname -s$/);
	assert.equal(recorder.calls[1].args.at(-1), recorder.calls[2].args.at(-1), "能力与工具必须发同一条命令（禁止两份实现）");
});
