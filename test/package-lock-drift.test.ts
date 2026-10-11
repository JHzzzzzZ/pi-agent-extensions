/**
 * 仓库卫生守门：每个 `package-lock.json` 的版本字段必须与同级 `package.json` 一致。
 *
 * 为什么需要（general-todo#24）：lock 顶层的 `version` 与 `packages[""].version` 本应镜像
 * `package.json`。一旦漂移，任何人跑一次 `npm install`（含 `tools/test-all.mjs --install`）
 * 都会顺手改这些 lock，把无关改动混进 diff——交付时只能逐个 `git checkout` 回滚，否则会挡住
 * 并行会话的工作区。2026-10-11 实测：`#6`、`#7` 两个分支各被撞一次（`#6` 那次到评审第 3 轮
 * 才揪出来）。漂移本身无害、代价全在交付期，所以用一个便宜的全仓扫描把它挡在门口。
 *
 * 边界：纯读文件，无网络、无子进程、无 npm 调用。不扫 `node_modules/`、`.git/`、
 * `.worktrees/`、`.pi/`、`history/`。第一个用例是扫描器的自检（临时目录造三种漂移），
 * 保证第二个用例不会因为「仓库恰好干净」而恒绿。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", ".pi", "history"]);

/** 收集 root 下所有 package-lock.json（跳过 SKIP_DIRS，不跟符号链接）。 */
function findLockfiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "package-lock.json") {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * 读一个 lock 的漂移情况。返回按字段拆开的差异列表；无同级 package.json（纯 lock 形态）
 * 时返回空数组——「不知道」不等于「漂移」，宁可不报也不误报。lock/package.json 的 JSON
 * 损坏则让 JSON.parse 抛出去（整个套件红）：损坏的 lock 是真问题，不该静默跳过。
 */
function readDrift(lockPath) {
  const manifestPath = path.join(path.dirname(lockPath), "package.json");
  if (!fs.existsSync(manifestPath)) return [];
  const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
  if (typeof expected !== "string") return [];

  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const drift = [];
  if (lock.version !== expected) drift.push({ field: "version", found: lock.version });
  const root = lock.packages?.[""];
  if (root && root.version !== expected) drift.push({ field: 'packages[""].version', found: root.version });
  return drift;
}

function describeDrift(lockPath, drift) {
  return drift.map((d) => `${path.relative(REPO_ROOT, lockPath)} ${d.field}=${d.found}`).join("；");
}

test("扫描器自检：三种漂移都抓得住，一致与无 package.json 都不误报", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "lock-drift-"));
  try {
    const write = (name, manifest, lock) => {
      const dir = path.join(sandbox, name);
      fs.mkdirSync(dir, { recursive: true });
      if (manifest) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: manifest }));
      fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock));
      return path.join(dir, "package-lock.json");
    };

    const clean = write("clean", "1.0.0", { version: "1.0.0", packages: { "": { version: "1.0.0" } } });
    const topOnly = write("top-only", "2.0.0", { version: "1.9.0", packages: { "": { version: "2.0.0" } } });
    const innerOnly = write("inner-only", "3.0.0", { version: "3.0.0", packages: { "": { version: "2.9.0" } } });
    const both = write("both", "4.0.0", { version: "1.0.0", packages: { "": { version: "1.0.0" } } });
    const orphan = write("orphan", null, { version: "0.0.1", packages: { "": { version: "0.0.1" } } });
    const legacy = write("legacy", "5.0.0", { version: "5.0.0", lockfileVersion: 1 });

    assert.deepEqual(readDrift(clean), [], "一致的不该报");
    assert.deepEqual(readDrift(topOnly).map((d) => d.field), ["version"], "顶层漂移要报");
    assert.deepEqual(readDrift(innerOnly).map((d) => d.field), ['packages[""].version'], "只改内层也要报");
    assert.deepEqual(readDrift(both).map((d) => d.field), ["version", 'packages[""].version'], "两处都落后要报");
    assert.deepEqual(readDrift(orphan), [], "没有同级 package.json 的纯 lock 不报");
    assert.deepEqual(readDrift(legacy), [], "无 packages 段的旧格式只查顶层，一致即不报");

    // 目录级：同一个沙箱里能看到 6 个 lock，没有被 SKIP_DIRS 之外的规则漏掉
    assert.equal(findLockfiles(sandbox).length, 6);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("全仓：每个 package-lock.json 的版本字段与同级 package.json 一致（general-todo#24）", () => {
  const lockfiles = findLockfiles(REPO_ROOT);
  assert.ok(lockfiles.length >= 10, `应当扫到所有扩展的 lock，实际只扫到 ${lockfiles.length} 个——扫描器坏了？`);

  const drifts = [];
  for (const lockPath of lockfiles) {
    const drift = readDrift(lockPath);
    if (drift.length > 0) drifts.push(describeDrift(lockPath, drift));
  }
  assert.deepEqual(
    drifts,
    [],
    `lock 版本漂移会让每次 npm install 都改出无关 diff（跑 npm install 对齐，别手改 package.json）：\n  ${drifts.join("\n  ")}`,
  );
});
