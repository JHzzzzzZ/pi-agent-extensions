/**
 * pwr solo 审批门读取测试：真实临时文件 + PI_SOLO_MODE_FILE 注入，
 * 覆盖 fail-closed 语义（缺失/损坏/异 pid 一律未激活）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSoloActive, resolveSoloStatePath, SOLO_STATE_FILE_ENV } from "../src/solo-gate.ts";

function tempStateFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-solo-"));
	return path.join(dir, "solo-mode.json");
}

test("resolveSoloStatePath：PI_SOLO_MODE_FILE 优先，空值回落 ~/.pi/agent/solo-mode.json", () => {
	assert.equal(resolveSoloStatePath({ [SOLO_STATE_FILE_ENV]: "C:/tmp/solo.json" }), "C:/tmp/solo.json");
	assert.match(resolveSoloStatePath({ [SOLO_STATE_FILE_ENV]: "  " }), /solo-mode\.json$/);
	assert.match(resolveSoloStatePath({}), /solo-mode\.json$/);
});

test("isSoloActive：本进程 pid 激活；缺失/损坏/异 pid fail-closed", () => {
	const file = tempStateFile();
	const env = { [SOLO_STATE_FILE_ENV]: file };

	assert.equal(isSoloActive({ env }), false, "文件缺失 → 未激活");
	fs.writeFileSync(file, "{ broken", "utf8");
	assert.equal(isSoloActive({ env }), false, "JSON 损坏 → 未激活");
	fs.writeFileSync(file, JSON.stringify({ pid: "not-a-number" }), "utf8");
	assert.equal(isSoloActive({ env }), false, "pid 类型不符 → 未激活");
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }), "utf8");
	assert.equal(isSoloActive({ env }), false, "异 pid（子进程/崩溃残留）→ 未激活");
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, activatedAt: "2026-08-05T12:00:00Z" }), "utf8");
	assert.equal(isSoloActive({ env }), true, "本进程 pid → 激活");

	fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
