/*
 * remote-tools — 目标登记表的纯逻辑与文件端口测试（remote-tools-todo#2）。
 *
 * 边界与动机：
 *   - 解析/校验/登记是**纯函数**，直接测真函数（不 fake）；
 *   - 文件端口（读/写/原子落盘/损坏 fail-closed）用**真实临时目录**测，因为「损坏时静默当空表」
 *     与「写坏文件」的代价都落在这个边界上，用 fake 测不到；
 *   - strict 的两种语义（开 ⇒ 拒绝、关 ⇒ 逐字回落）各自锁用例：默认开是行为变更，
 *     不能只靠「没报错」证明。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ErrorCodes } from "../errors.ts";
import {
	ALIAS_ECHO_LIMIT,
	type RemoteTargetsFile,
	addTarget,
	createTargetsStore,
	emptyTargetsFile,
	formatEntry,
	formatTargetsList,
	parseTargetsFile,
	removeTarget,
	resolveTarget,
	serializeTargetsFile,
	strictRejectionMessage,
	targetHintLine,
	targetsFilePath,
	validateTargetEntry,
	withStrict,
} from "../targets.ts";

const NOW = "2026-10-13T00:00:00.000Z";

/** 测试用的条目构造：只写有值的可选字段（与生产解析结果同形，往返比较才有意义）。 */
function entry(alias: string, host?: string, user?: string, port?: number) {
	const built: RemoteTargetsFile["targets"][number] = { alias, source: "human", createdAt: NOW };
	if (host !== undefined) built.host = host;
	if (user !== undefined) built.user = user;
	if (port !== undefined) built.port = port;
	return built;
}

function file(...targets: ReturnType<typeof entry>[]): RemoteTargetsFile {
	return { version: 1, strict: true, targets };
}

test("strict 默认开：未登记目标被拒，文案列出已登记别名与两个修复入口", () => {
	const result = resolveTarget({ remote: "10.0.0.9" }, file(entry("prod", "10.0.0.7", "deploy")));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.code, ErrorCodes.UNKNOWN_REMOTE_TARGET);
	assert.match(result.message, /prod/);
	assert.match(result.message, /\/remote:add/);
	assert.match(result.message, /remote_targets/);
});

test("命中别名：补齐条目里的 user/port；字面三元组与别名同源命中同一条目", () => {
	const targets = file(entry("prod", "10.0.0.7", "deploy", 2222));
	const byAlias = resolveTarget({ remote: "prod" }, targets);
	assert.equal(byAlias.ok, true);
	if (!byAlias.ok || byAlias.kind !== "resolved") return assert.fail("别名应命中");
	assert.deepEqual(byAlias.target, { host: "10.0.0.7", user: "deploy", port: 2222 });
	assert.equal(byAlias.entry?.alias, "prod");

	const byTriple = resolveTarget({ remote: "deploy@10.0.0.7" }, targets);
	assert.equal(byTriple.ok, true);
	if (!byTriple.ok || byTriple.kind !== "resolved") return assert.fail("字面三元组应命中");
	assert.equal(byTriple.target.port, 2222, "条目端口应补齐");

	const byHostOnly = resolveTarget({ remote: "10.0.0.7" }, targets);
	assert.equal(byHostOnly.ok, true, "只给 host 也应命中（user/port 由条目补齐）");
});

test("显式 remotePort 优先于条目默认端口（默认值不是强制值）", () => {
	const result = resolveTarget({ remote: "prod", remotePort: 2200 }, file(entry("prod", "10.0.0.7", "deploy", 2222)));
	assert.equal(result.ok, true);
	if (!result.ok || result.kind !== "resolved") return assert.fail("应命中");
	assert.equal(result.target.port, 2200);
});

test("ssh_config 兜底：条目不给 host ⇒ 别名本身就是主机名（user/port 交给 ssh 自己解析）", () => {
	const result = resolveTarget({ remote: "lab" }, file(entry("lab")));
	assert.equal(result.ok, true);
	if (!result.ok || result.kind !== "resolved") return assert.fail("应命中");
	assert.deepEqual(result.target, { host: "lab", user: undefined, port: undefined });
});

test("strict 关：未命中回落成今天的自由填写（逐字不变）", () => {
	const loose: RemoteTargetsFile = { version: 1, strict: false, targets: [entry("prod", "10.0.0.7")] };
	const result = resolveTarget({ remote: "10.0.0.9", remotePort: 22 }, loose);
	assert.equal(result.ok, true);
	if (!result.ok || result.kind !== "resolved") return assert.fail("应放行");
	assert.deepEqual(result.target, { host: "10.0.0.9", user: undefined, port: 22 });
	assert.equal(result.entry, null, "自由填写没有命中条目");
});

test("本地模式与登记表无关：空串/缺省值字面量 ⇒ kind local（不查表）", () => {
	for (const remote of ["", "   ", "null", "undefined", null, 42]) {
		const result = resolveTarget({ remote }, file(entry("prod", "10.0.0.7")));
		assert.equal(result.ok, true, String(remote));
		if (!result.ok) continue;
		assert.equal(result.kind, "local", String(remote));
	}
});

test("形态非法优先于登记表：前导 - 与内嵌端口仍报 INVALID_REMOTE_TARGET（strict 不参与）", () => {
	for (const remote of ["-x", "host:22", "a b"]) {
		const result = resolveTarget({ remote }, file(entry("prod", "10.0.0.7")));
		assert.equal(result.ok, false, remote);
		if (result.ok) continue;
		assert.equal(result.code, ErrorCodes.INVALID_REMOTE_TARGET);
	}
});

test("匹配严格：大小写敏感；条目没给 user 时 `root@host` 不命中（对齐文档 Q3）", () => {
	const targets = file(entry("prod", "10.0.0.7", "deploy"));
	const upper = resolveTarget({ remote: "PROD" }, targets);
	assert.equal(upper.ok, false, "别名大小写敏感");

	const wrongUser = resolveTarget({ remote: "root@10.0.0.7" }, targets);
	assert.equal(wrongUser.ok, false, "user 必须与条目相等");

	const rightUser = resolveTarget({ remote: "deploy@10.0.0.7" }, targets);
	assert.equal(rightUser.ok, true);
});

test("parseTargetsFile：非法 JSON / 版本 / 未知字段 / 条目非法 / 重复别名都 fail-closed 并给码", () => {
	const cases: Array<[string, string, string]> = [
		["不是 JSON", "{ nope", ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["未知顶层字段", JSON.stringify({ version: 1, strict: true, targets: [], extra: 1 }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["版本不符", JSON.stringify({ version: 2, strict: true, targets: [] }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["strict 非布尔", JSON.stringify({ version: 1, strict: "yes", targets: [] }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["targets 非数组", JSON.stringify({ version: 1, strict: true, targets: {} }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["条目含未知字段", JSON.stringify({ version: 1, strict: true, targets: [{ ...entry("prod"), strictt: false }] }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
		["别名非法", JSON.stringify({ version: 1, strict: true, targets: [entry("a b", "h")] }), ErrorCodes.INVALID_REMOTE_TARGET],
		["端口非法", JSON.stringify({ version: 1, strict: true, targets: [entry("prod", "h", "u", 70000)] }), ErrorCodes.INVALID_REMOTE_PORT],
		["重复别名", JSON.stringify({ version: 1, strict: true, targets: [entry("prod", "a"), entry("prod", "b")] }), ErrorCodes.REMOTE_TARGETS_UNREADABLE],
	];
	for (const [name, text, code] of cases) {
		const parsed = parseTargetsFile(text);
		assert.equal(parsed.ok, false, name);
		if (parsed.ok) continue;
		assert.equal(parsed.code, code, name);
	}
});

test("序列化往返：写出的形态能被自己读回（含可选字段缺省）", () => {
	const original = file(entry("prod", "10.0.0.7", "deploy", 2222), entry("lab"));
	const parsed = parseTargetsFile(serializeTargetsFile(original));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(parsed.value, original);
});

test("validateTargetEntry：host 带 @ / user 带空白 / note 过长都拒绝", () => {
	assert.equal(validateTargetEntry(entry("p", "a@b")).ok, false);
	assert.equal(validateTargetEntry(entry("p", "h", "u v")).ok, false);
	assert.equal(validateTargetEntry({ ...entry("p", "h"), note: "x".repeat(201) }).ok, false);
	assert.equal(validateTargetEntry({ ...entry("p", "h"), source: "robot" }).ok, false);
});

test("addTarget：首次登记追加；同名非 force 拒绝；force 覆盖不增条目；非法别名拒绝", () => {
	const added = addTarget(null, { alias: "prod", host: "10.0.0.7", user: "deploy", port: 2222, source: "agent" }, { nowIso: NOW, force: false });
	assert.equal(added.ok, true);
	if (!added.ok) return;
	assert.deepEqual(added.value.targets[0], { alias: "prod", host: "10.0.0.7", user: "deploy", port: 2222, source: "agent", createdAt: NOW });
	assert.equal(added.value.strict, true, "首次登记的文件默认 strict 开");

	const conflict = addTarget(added.value, { alias: "prod", host: "10.0.0.8", source: "human" }, { nowIso: NOW, force: false });
	assert.equal(conflict.ok, false);
	if (conflict.ok) return;
	assert.equal(conflict.code, ErrorCodes.REMOTE_TARGET_EXISTS);

	const forced = addTarget(added.value, { alias: "prod", host: "10.0.0.8", source: "human" }, { nowIso: NOW, force: true });
	assert.equal(forced.ok, true);
	if (!forced.ok) return;
	assert.equal(forced.value.targets.length, 1);
	assert.equal(forced.value.targets[0].host, "10.0.0.8");

	const bad = addTarget(null, { alias: "a b", source: "human" }, { nowIso: NOW, force: false });
	assert.equal(bad.ok, false);
});

test("removeTarget / withStrict：删不存在的别名报 REMOTE_TARGET_UNKNOWN；strict 可开可关", () => {
	const base = file(entry("prod", "10.0.0.7"), entry("lab"));
	const removed = removeTarget(base, "lab");
	assert.equal(removed.ok, true);
	if (!removed.ok) return;
	assert.deepEqual(removed.value.targets.map((item) => item.alias), ["prod"]);

	const missing = removeTarget(base, "nope");
	assert.equal(missing.ok, false);
	if (missing.ok) return;
	assert.equal(missing.code, ErrorCodes.REMOTE_TARGET_UNKNOWN);

	assert.equal(withStrict(null, false).strict, false);
	assert.equal(withStrict(base, false).strict, false);
	assert.equal(emptyTargetsFile().strict, true, "空表的语义就是 strict 开");
});

test("展示：hint 行（空表为空串、超限截断）、清单（strict 状态 + 来源）、拒绝文案超限提示", () => {
	assert.equal(targetHintLine(null), "");
	assert.match(targetHintLine(file(entry("prod", "10.0.0.7"))), /已登记目标：prod/);

	const many = file(...Array.from({ length: ALIAS_ECHO_LIMIT + 1 }, (_, index) => entry(`t${index}`, "h")));
	assert.match(targetHintLine(many), /等 21 个/);
	assert.match(strictRejectionMessage(many), /共 21 个/);
	assert.match(strictRejectionMessage(null), /（空）/);

	const list = formatTargetsList(file(entry("prod", "10.0.0.7", "deploy", 2222), entry("lab")), "C:\\cfg\\remote-targets.json");
	assert.match(list, /strict 白名单：开/);
	assert.match(list, /- prod → deploy@10.0.0.7:2222（human/);
	assert.match(list, /- lab → lab（ssh_config 兜底）/);
	assert.equal(formatEntry(entry("lab")), "lab");
});

test("targetsFilePath：PI_REMOTE_TARGETS_FILE 覆盖优先；缺省落 ~/.pi/agent/remote-targets.json", () => {
	assert.equal(targetsFilePath({ PI_REMOTE_TARGETS_FILE: "  D:\\cfg\\t.json  " }), "D:\\cfg\\t.json");
	assert.match(targetsFilePath({}), /\.pi[\\/]agent[\\/]remote-targets\.json$/);
	assert.match(targetsFilePath({ PI_REMOTE_TARGETS_FILE: "   " }), /remote-targets\.json$/);
});

test("文件端口（真实临时目录）：不存在 ⇒ null；写读往返；损坏 fail-closed；写失败给码；readAtLoad 静默", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-targets-"));
	const filePath = path.join(dir, "remote-targets.json");
	const store = createTargetsStore(filePath);

	const missing = await store.read();
	assert.equal(missing.ok, true);
	if (!missing.ok) return;
	assert.equal(missing.value, null, "文件不存在不是错误");

	assert.equal((await store.write(file(entry("prod", "10.0.0.7")))).ok, true);
	const round = await store.read();
	assert.equal(round.ok, true);
	if (!round.ok) return;
	assert.equal(round.value?.targets[0]?.alias, "prod");

	// 写路径不留临时文件（temp + rename 的原子性表象之一）。
	assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".tmp-")), []);

	await writeFile(filePath, "{ broken", "utf8");
	const broken = await store.read();
	assert.equal(broken.ok, false);
	if (broken.ok) return;
	assert.equal(broken.code, ErrorCodes.REMOTE_TARGETS_UNREADABLE);
	assert.equal(store.readAtLoad(), null, "加载期读损坏文件只当没有登记表（绝不阻断注册）");

	const blocked = createTargetsStore(path.join(dir, "remote-targets.json", "nested.json"));
	const failed = await blocked.write(file());
	assert.equal(failed.ok, false);
	if (failed.ok) return;
	assert.equal(failed.code, ErrorCodes.REMOTE_TARGETS_WRITE_FAILED);
});
