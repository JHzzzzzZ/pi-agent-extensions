/**
 * L2 配对组合测试（general-todo#32 / docs/specs/composition-test-matrix.md）
 *
 * 验的是「A+B 兼容」：按接触面清单自动生成配对（不做 18² 全跑），每对跑两种加载顺序，
 * 断言
 *   ① 双方都注册成功、生命周期流转不抛未捕获异常（含二次 session_start 可重入）；
 *   ② 双方**声明的注册面都真的注册了**（同名槽不出现静默消失）；
 *   ③ **加载顺序无关**：先 A 后 B 与先 B 后 A 的可观测注册面一致；
 *   ④ 共享同一槽的取值**必须已被清单裁决**（`独占声明` / `共享槽`），否则算未声明的真冲突。
 *
 * 配对放在子进程里跑（`test/helpers/pair-probe.mjs`）：扩展持模块级单例与全局双加载守卫，
 * 同进程反复加载会互相污染，而真实世界里一个 pi 会话就是一个进程。
 *
 * 变异自证：本文件末尾用 `COMPOSITION_PROBE_INJECT` 注入一个同名工具，断言探针**如实记录
 * 了两个注册者**（矩阵具备发现同槽冲突的原始材料），并且仲裁函数会把未声明的同槽判为冲突。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  REPO_ROOT,
  checkArbitration,
  computePairs,
  listExtensions,
  parseSurfaces,
  validateSurfaces,
} from "../tools/composition-surfaces.mjs";

const PROBE = path.join(REPO_ROOT, "test", "helpers", "pair-probe.mjs");
const markdown = fs.readFileSync(path.join(REPO_ROOT, "docs/cross/composition-surfaces.md"), "utf8");
const surfaces = parseSurfaces(markdown);
const pairs = computePairs(surfaces);

const declaredValues = (name, field) => surfaces.get(name)?.fields.get(field) ?? [];
const modes = (name) => declaredValues(name, "mode");
const declaredToolNames = (name) => [
  ...declaredValues(name, "tool"),
  ...declaredValues(name, "toolSurface").map((v) => v.replace(/^(replace|wrap)\s*[:：]\s*/, "").trim()),
];

const runProbe = (a, b, env = {}) => {
  const output = execFileSync(process.execPath, [PROBE, a, b], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(output.trim().split("\n").pop());
};

const namesOf = (list) => list.map((entry) => entry.name ?? entry.id).sort();

test("L2：清单校验与仲裁在真实清单上全通过（含配对集合非空）", () => {
  const { problems } = validateSurfaces({ repoRoot: REPO_ROOT, markdown });
  assert.deepEqual(problems, []);
  assert.deepEqual(checkArbitration({ surfaces, pairs }), []);
  assert.ok(pairs.length > 0, "真实清单没有生成任何配对——接触面声明可能与实现脱节");
});

test("L2：配对集合必须覆盖现有跨扩展测试所覆盖的组合（自动生成不得比人工现状弱）", () => {
  const covered = pairs.map((p) => p.pair.join(" × "));
  for (const required of [
    "remote-tools × timeout-bg", // shell 能力协商（docs/cross/shell-tool-capability.md）
    "jev-safe-gate × pwr", // 同为 tool_call 拦截型
    "jev-safe-gate × solo-mode", // 免审批文件契约（docs/cross/solo-approval-gate.md）
    "pwr × run-timer", // widget 排序带同槽（docs/cross/status-bar.md）
  ]) {
    assert.ok(covered.includes(required), `配对集合缺 ${required}（实得：${covered.join(", ")}）`);
  }
});

for (const { pair: [a, b], reasons } of pairs) {
  test(`L2 配对：${a} × ${b}（${reasons.map((r) => `${r.dim}:${r.value}`).join(", ")}）`, () => {
    const forward = runProbe(a, b);
    const backward = runProbe(b, a);
    assert.equal(forward.error, null, `${a} × ${b}（正序）加载/生命周期抛错：${forward.error}`);
    assert.equal(backward.error, null, `${b} × ${a}（反序）加载/生命周期抛错：${backward.error}`);
    for (const report of [forward, backward]) {
      assert.deepEqual(report.phases, { load: "ok", firstStart: "ok", shutdown: "ok", secondStart: "ok" });
    }

    // ② 声明的面都在（多模式扩展按模式放宽：由 L1 的模式用例覆盖另一支）
    const observed = new Set(namesOf(forward.tools));
    for (const side of [a, b]) {
      if (modes(side).length > 1) continue;
      for (const tool of declaredToolNames(side)) {
        assert.ok(observed.has(tool), `${side}: 同装后声明的 \`${tool}\` 没有注册（静默消失？）`);
      }
      for (const command of declaredValues(side, "commands")) {
        if (command.includes(":")) continue; // 子命令随父命令注册
        assert.ok(
          forward.commands.some((c) => c.name === command),
          `${side}: 同装后声明的命令 \`${command}\` 没注册`,
        );
      }
    }

    // ③ 顺序无关：可观测注册面一致
    assert.deepEqual(namesOf(forward.tools), namesOf(backward.tools), "工具注册面与加载顺序有关");
    assert.deepEqual(namesOf(forward.commands), namesOf(backward.commands), "命令注册面与加载顺序有关");
    assert.deepEqual(namesOf(forward.providers), namesOf(backward.providers), "provider 注册面与加载顺序有关");
    assert.deepEqual(namesOf(forward.virtualModels), namesOf(backward.virtualModels), "虚拟模型注册面与加载顺序有关");
    assert.deepEqual(
      forward.hooks.map((h) => `${h.source}:${h.event}`).sort(),
      backward.hooks.map((h) => `${h.source}:${h.event}`).sort(),
      "钩子注册面与加载顺序有关",
    );
    assert.deepEqual(forward.statusKeys, backward.statusKeys, "状态键写入与加载顺序有关");
    assert.deepEqual(forward.widgetKeys, backward.widgetKeys, "widget 写入与加载顺序有关");
  });
}

test("L2 变异自证：探针如实记录同槽的两个注册者（矩阵能看见静默覆盖）", () => {
  // 挑一个真拥有目标工具的配对（bash 的 owner 是 timeout-bg，remote-tools 也声明了它）
  const target = pairs.find((p) => p.pair.includes("timeout-bg")) ?? pairs[0];
  const [a, b] = target.pair;
  const injected = declaredToolNames(a).includes("bash") ? "bash" : declaredToolNames(a)[0] ?? "bash";
  const report = runProbe(a, b, { COMPOSITION_PROBE_INJECT: injected });
  const registrants = report.tools.filter((t) => t.name === injected);
  assert.ok(
    registrants.length >= 2,
    `注入同名工具后应看到 ≥2 个注册者（实际 ${registrants.length}：${JSON.stringify(registrants)}）`,
  );
});

test("L2 变异自证：未声明共享槽的同槽会被仲裁判为冲突", () => {
  const synthetic = parseSurfaces("### alpha\n工具: shared-tool\n\n### beta\n工具: shared-tool\n");
  const problems = checkArbitration({ surfaces: synthetic, pairs: computePairs(synthetic) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未声明的真冲突/);

  const arbitrated = parseSurfaces(
    "### alpha\n工具: shared-tool\n独占声明: shared-tool\n\n### beta\n工具: shared-tool\n共享槽: shared-tool（由 alpha 独占，beta 只读）\n",
  );
  assert.deepEqual(checkArbitration({ surfaces: arbitrated, pairs: computePairs(arbitrated) }), []);
});

test("L2：清单声明的扩展集合与仓库实际扩展集合一致", () => {
  assert.deepEqual(
    [...surfaces.keys()].sort(),
    listExtensions(REPO_ROOT),
    "清单与 src/extensions 目录不一致（新增插件必须在清单补一节）",
  );
});
