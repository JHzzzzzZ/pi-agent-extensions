/*
 * remote-tools — 登记表的模型面与人工面测试（remote-tools-todo#2）：remote_targets 工具、
 * /remote:* 命令、7 个内置工具描述里的别名提示行、guideline 的「优先 remote」文案。
 *
 * 边界与动机：
 *   - 宿主 ExtensionAPI / ExtensionCommandContext 用结构 fake（宿主交互不在测试范围），
 *     但**走的是真实的 registerRemoteTools 注册面**——提示行与命令分派的接线错误只有这样才测得出来；
 *   - 关键不变量单独锁：本地调用**一次都不读登记表**（readFailure 的 store + reads 计数），
 *     登记表坏掉不得弄坏本机工具。
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { ErrorCodes } from "../errors.ts";
import type { RemoteToolsFailure } from "../errors.ts";
import { REMOTE_COMMANDS, registerRemoteTools } from "../tools.ts";
import type { RemoteTargetsFile } from "../targets.ts";
import { type CommandRegistration, type MemoryTargetsStore, createMemoryTargetsStore } from "./fixtures.ts";

const ID = "call-1";
const NOW = "2026-10-13T00:00:00.000Z";
const STORE_PATH = "C:\\fake\\remote-targets.json";

interface Surface {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, CommandRegistration>;
	notices: string[];
}

function record(store: MemoryTargetsStore): Surface {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, CommandRegistration>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: CommandRegistration) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	registerRemoteTools(pi, {
		exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false }),
		cwd: process.cwd(),
		targets: store,
		now: () => NOW,
	});
	return { tools, commands, notices: [] };
}

/** 宿主 ctx 的结构 fake：捕获 notify，其余字段按最小形状给（宿主交互不在测试范围）。 */
function context(surface: Surface): ExtensionToolContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			notify: (message: string) => {
				surface.notices.push(message);
			},
		},
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
}

function file(...targets: RemoteTargetsFile["targets"]): RemoteTargetsFile {
	return { version: 1, strict: true, targets };
}

function entry(alias: string, host?: string): RemoteTargetsFile["targets"][number] {
	const built: RemoteTargetsFile["targets"][number] = { alias, source: "human", createdAt: NOW };
	if (host !== undefined) built.host = host;
	return built;
}

async function runTool(surface: Surface, name: string, params: unknown): Promise<string> {
	const tool = surface.tools.get(name);
	assert.ok(tool !== undefined, `缺少工具 ${name}`);
	const result = await tool.execute(ID, params as never, undefined, undefined, context(surface));
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

async function runCommand(surface: Surface, name: string, args: string): Promise<void> {
	const command = surface.commands.get(name);
	assert.ok(command !== undefined, `缺少命令 ${name}`);
	await command.handler(args, context(surface) as unknown as ExtensionCommandContext);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

test("模型面：7 个内置工具的 remote 描述带已登记别名提示行；空登记表时不加", () => {
	const withTargets = record(createMemoryTargetsStore(file(entry("prod", "10.0.0.7"))));
	for (const name of ["read", "write", "edit", "ls", "find", "grep", "bash"]) {
		const properties = (withTargets.tools.get(name)?.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
		assert.match(properties.remote?.description ?? "", /已登记目标：prod/, `${name} 的 remote 描述应带提示行`);
	}

	const empty = record(createMemoryTargetsStore(null));
	const readProperties = (empty.tools.get("read")?.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
	assert.doesNotMatch(readProperties.remote?.description ?? "", /已登记目标/, "空登记表不加提示行");
});

test("模型面：guideline 明确「优先传 remote，不要在 bash 里拼 ssh」", () => {
	const surface = record(createMemoryTargetsStore(null));
	for (const name of ["read", "bash", "grep"]) {
		const guidelines = (surface.tools.get(name)?.promptGuidelines ?? []).join(" ");
		assert.match(guidelines, /优先传 remote，不要在 bash 里拼 ssh/, `${name} 的 guideline 缺少偏好文案`);
	}
	const targetsGuideline = (surface.tools.get("remote_targets")?.promptGuidelines ?? []).join(" ");
	assert.match(targetsGuideline, /remote_targets/);
});

test("remote_targets(list)：输出别名、目标、来源与 strict 状态；无 list 参数时默认 list", async () => {
	const surface = record(createMemoryTargetsStore(file(entry("prod", "10.0.0.7"), entry("lab"))));
	const text = await runTool(surface, "remote_targets", { action: "list" });
	assert.match(text, /strict 白名单：开/);
	assert.match(text, /- prod → 10\.0\.0\.7（human/);
	assert.match(text, /- lab → lab（ssh_config 兜底）/);
	assert.ok(text.includes(STORE_PATH), "清单里要回显登记表路径（人好去手改）");
});

test("remote_targets(register)：落盘 source=agent、通知一次；同名再登记报 REMOTE_TARGET_EXISTS", async () => {
	const store = createMemoryTargetsStore(file(entry("prod", "10.0.0.7")));
	const surface = record(store);

	const text = await runTool(surface, "remote_targets", { action: "register", alias: "lab", host: "10.0.0.8", user: "deploy", port: 2222 });
	assert.match(text, /已登记 lab → deploy@10\.0\.0\.8:2222（source=agent）/);
	assert.equal(store.current()?.targets.length, 2);
	assert.equal(store.current()?.targets[1]?.source, "agent");
	assert.equal(store.current()?.targets[1]?.createdAt, NOW);
	assert.equal(surface.notices.length, 1, "登记成功应通知一次（人看得见模型改了什么）");

	await assert.rejects(
		() => runTool(surface, "remote_targets", { action: "register", alias: "lab", host: "10.0.0.9" }),
		(error: Error) => error.message.includes(ErrorCodes.REMOTE_TARGET_EXISTS),
		"同名登记必须拒绝（模型无 force）",
	);

	const bad = await runTool(surface, "remote_targets", { action: "register", alias: "a b" }).then(
		() => "resolved",
		(error: Error) => error.message,
	);
	assert.match(bad, new RegExp(ErrorCodes.INVALID_REMOTE_TARGET), "非法别名要报形态错");
});

test("/remote:add：登记 source=human；--force 覆盖；--port 生效；非法输入只通知不写盘", async () => {
	const store = createMemoryTargetsStore(null);
	const surface = record(store);

	await runCommand(surface, REMOTE_COMMANDS.add, "prod deploy@10.0.0.7 --port 2222");
	assert.equal(store.current()?.targets[0]?.alias, "prod");
	assert.equal(store.current()?.targets[0]?.source, "human");
	assert.equal(store.current()?.targets[0]?.port, 2222);
	assert.match(surface.notices.at(-1) ?? "", /已登记 prod → deploy@10\.0\.0\.7:2222/);

	await runCommand(surface, REMOTE_COMMANDS.add, "prod deploy@10.0.0.7 --port 2222");
	assert.equal(store.current()?.targets.length, 1, "同名无 --force 不得追加");
	assert.match(surface.notices.at(-1) ?? "", new RegExp(ErrorCodes.REMOTE_TARGET_EXISTS));

	await runCommand(surface, REMOTE_COMMANDS.add, "prod deploy@10.0.0.8 --force");
	assert.equal(store.current()?.targets.length, 1);
	assert.equal(store.current()?.targets[0]?.host, "10.0.0.8");

	// ssh_config 兜底：省略 user@host 时别名自己当主机名。
	await runCommand(surface, REMOTE_COMMANDS.add, "lab");
	assert.equal(store.current()?.targets[1]?.host, undefined);

	const before = JSON.stringify(store.current());
	await runCommand(surface, REMOTE_COMMANDS.add, "prod --port 0");
	await runCommand(surface, REMOTE_COMMANDS.add, "prod host --unknown");
	await runCommand(surface, REMOTE_COMMANDS.add, "a b c");
	assert.equal(JSON.stringify(store.current()), before, "非法输入不得写盘");
	assert.match(surface.notices.join("\n"), /--port 必须是 1-65535 的整数/);
	assert.match(surface.notices.join("\n"), /不认识的选项/);
	assert.match(surface.notices.join("\n"), /位置参数只接受/);
});

test("/remote:rm 与 /remote:strict：删除与开关都落盘；删不存在的只通知", async () => {
	const store = createMemoryTargetsStore(file(entry("prod", "10.0.0.7")));
	const surface = record(store);

	await runCommand(surface, REMOTE_COMMANDS.list, "");
	assert.match(surface.notices.at(-1) ?? "", /- prod → 10\.0\.0\.7（human/);

	await runCommand(surface, REMOTE_COMMANDS.strict, "off");
	assert.equal(store.current()?.strict, false);
	assert.match(surface.notices.at(-1) ?? "", /strict 白名单已关闭/);

	await runCommand(surface, REMOTE_COMMANDS.strict, "maybe");
	assert.equal(store.current()?.strict, false, "非法参数不写盘");

	await runCommand(surface, REMOTE_COMMANDS.remove, "nope");
	assert.match(surface.notices.at(-1) ?? "", new RegExp(ErrorCodes.REMOTE_TARGET_UNKNOWN));

	await runCommand(surface, REMOTE_COMMANDS.remove, "prod");
	assert.equal(store.current()?.targets.length, 0);
	assert.match(surface.notices.at(-1) ?? "", /已删除远端目标 prod/);

	await runCommand(surface, REMOTE_COMMANDS.remove, "  ");
	assert.match(surface.notices.at(-1) ?? "", /用法：\/remote:rm/);
});

test("零影响不变量：本地调用不读登记表——登记表读取失败也照样工作（reads === 0）", async () => {
	const failure: RemoteToolsFailure = { ok: false, code: ErrorCodes.REMOTE_TARGETS_UNREADABLE, message: "登记表坏了" };
	const store = createMemoryTargetsStore(null, { readFailure: failure });
	const surface = record(store);
	const ctx = context(surface);
	const dir = await mkdtemp(path.join(tmpdir(), "remote-targets-local-"));
	await writeFile(path.join(dir, "keep.txt"), "local\n", "utf8");

	const ls = surface.tools.get("ls");
	assert.ok(ls !== undefined);
	const result = await ls.execute(ID, { path: dir } as never, undefined, undefined, ctx);
	assert.match(textOf(result as { content: Array<{ type: string; text?: string }> }), /keep\.txt/);
	assert.equal(store.reads, 0, "本地调用绝不读登记表");
});

test("远端调用遇到损坏的登记表：fail-closed 抛类型化错误（不静默当空表）", async () => {
	const failure: RemoteToolsFailure = { ok: false, code: ErrorCodes.REMOTE_TARGETS_UNREADABLE, message: "登记表坏了" };
	const store = createMemoryTargetsStore(null, { readFailure: failure });
	const surface = record(store);

	const error = await runTool(surface, "remote_targets", { action: "list" }).then(
		() => null,
		(caught: Error) => caught,
	);
	assert.ok(error !== null);
	assert.match(error.message, new RegExp(ErrorCodes.REMOTE_TARGETS_UNREADABLE));
	const readsAfterList = store.reads;

	const read = surface.tools.get("read");
	assert.ok(read !== undefined);
	await assert.rejects(
		() => read.execute(ID, { path: "/srv/app/a.ts", remote: "prod" } as never, undefined, undefined, context(surface)),
		(caught: Error) => caught.message.includes(ErrorCodes.REMOTE_TARGETS_UNREADABLE),
	);
	assert.equal(store.reads, readsAfterList + 1, "远端调用才读表（本地调用一次都不读）");
});
