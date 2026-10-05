/**
 * solo 状态读取测试：真实临时文件 + 环境表注入，覆盖 fail-closed 语义
 * （缺失 / 损坏 / 异 pid 一律未激活）。与 pwr / opencode-bridge / deep-init
 * 的 `solo-gate.ts` 同构（跨扩展契约 docs/cross/solo-approval-gate.md）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SOLO_STATE_FILE_ENV, isSoloActive, resolveSoloStatePath } from "../solo-gate.ts";

describe("solo-gate — 状态文件读取（fail-closed）", () => {
  it("resolveSoloStatePath：PI_SOLO_MODE_FILE 优先，空值回落 ~/.pi/agent/solo-mode.json", () => {
    assert.equal(resolveSoloStatePath({ [SOLO_STATE_FILE_ENV]: "/tmp/solo.json" }), "/tmp/solo.json");
    assert.match(resolveSoloStatePath({ [SOLO_STATE_FILE_ENV]: "  " }), /solo-mode\.json$/);
    assert.match(resolveSoloStatePath({}), /solo-mode\.json$/);
  });

  it("isSoloActive：本进程 pid 激活；缺失/损坏/异 pid fail-closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-safe-gate-solo-"));
    const file = path.join(dir, "solo-mode.json");
    const env = { [SOLO_STATE_FILE_ENV]: file };
    try {
      assert.equal(isSoloActive({ env }), false, "文件缺失 → 未激活");
      fs.writeFileSync(file, "{ broken", "utf8");
      assert.equal(isSoloActive({ env }), false, "JSON 损坏 → 未激活");
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }), "utf8");
      assert.equal(isSoloActive({ env }), false, "异 pid（子进程/崩溃残留）→ 未激活");
      fs.writeFileSync(file, JSON.stringify({ activatedAt: "2026-10-05T00:00:00Z" }), "utf8");
      assert.equal(isSoloActive({ env }), false, "pid 缺失 → 未激活");
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, activatedAt: "2026-10-05T00:00:00Z" }), "utf8");
      assert.equal(isSoloActive({ env }), true, "本进程 pid → 激活");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
