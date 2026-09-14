/**
 * 仓库根发现测试：`--root` / git 自动发现 / fail-closed。
 *
 * 边界：纯函数 `resolveRepoRoot` 用注入的 cwd/execGit 覆盖各分支；`main` 级覆盖「不需要
 * 仓库根的命令」（--help / 裸调用 / 未知命令）与失败路径；**一条**真实子进程 E2E 用真实
 * `git init` 仓库证明「从仓库子目录调用 → 落到该仓库 todos/」这条主路径。重 fixture
 * （concurrency/interrupt）走 `--root`，不依赖 .git 目录（Windows 上 .git 清理慢且易 EBUSY）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { main, resolveRepoRoot } from "../todo.mjs";
import { emptyTodoData, parseTodoJson, serializeTodo } from "../schema.ts";

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODO_CLI = path.join(TOOL_DIR, "todo.mjs");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 真实 git 仓库 fixture（含 todos/ 与嵌套子目录，供「子目录发现」用例）。 */
function makeGitRepo(): string {
  const root = makeTempDir("todo-cli-root-");
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested", "deeper"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  return root;
}

function removeDir(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runCli(args: string[], cwd: string, timeoutMs = 30_000) {
  return spawnSync(process.execPath, [TODO_CLI, ...args], { cwd, encoding: "utf8", timeout: timeoutMs });
}

function readGeneral(root: string) {
  const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", "general-todo.json"), "utf8"), "test");
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.data : null;
}

test("resolveRepoRoot：--root 胜出（相对 cwd 解析），非目录/缺值 fail-closed", () => {
  const root = makeTempDir("todo-cli-root-flag-");
  try {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    const neverGit = () => {
      throw new Error("--root 在场时不得调用 git");
    };
    const resolved = resolveRepoRoot({ rootFlag: "sub", cwd: root, execGit: neverGit });
    assert.deepEqual(resolved, { ok: true, root: path.join(root, "sub") });

    const absolute = resolveRepoRoot({ rootFlag: path.join(root, "sub"), cwd: os.tmpdir(), execGit: neverGit });
    assert.deepEqual(absolute, { ok: true, root: path.join(root, "sub") });

    const missing = resolveRepoRoot({ rootFlag: "nope", cwd: root, execGit: neverGit });
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.message, /--root 指向的目录不存在/);

    const blank = resolveRepoRoot({ rootFlag: "", cwd: root, execGit: neverGit });
    assert.equal(blank.ok, false);
    assert.match(blank.ok ? "" : blank.message, /缺少 --root 的目录/);
  } finally {
    removeDir(root);
  }
});

test("resolveRepoRoot：无 --root 时走 git rev-parse --show-toplevel（cwd 传入）", () => {
  const fakeRoot = path.join(os.tmpdir(), "repo-fake");
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const execGit = (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    return `${fakeRoot}\n`;
  };
  assert.deepEqual(resolveRepoRoot({ cwd: "C:/anywhere", execGit }), { ok: true, root: fakeRoot });
  assert.deepEqual(calls, [{ args: ["rev-parse", "--show-toplevel"], cwd: "C:/anywhere" }]);

  const failing = resolveRepoRoot({
    cwd: "C:/anywhere",
    execGit: () => {
      throw new Error("fatal: not a git repository");
    },
  });
  assert.equal(failing.ok, false);
  assert.match(failing.ok ? "" : failing.message, /找不到仓库根：当前目录不在 git 仓库内/);

  const empty = resolveRepoRoot({ cwd: "C:/anywhere", execGit: () => "  \n" });
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.message, /git 未返回仓库路径/);
});

test("main：--help / 裸调用 / 未知命令都不要求仓库根（cwd 为陌生目录、execGit 会炸）", () => {
  const cwd = makeTempDir("todo-cli-root-none-");
  const boomGit = () => {
    throw new Error("这些命令不得触发仓库根发现");
  };
  try {
    const help: string[] = [];
    assert.equal(main(["--help"], { cwd, execGit: boomGit, log: (l) => help.push(l) }), 0);
    assert.match(help.join("\n"), /用法/);

    const bare: string[] = [];
    assert.equal(main([], { cwd, execGit: boomGit, log: (l) => bare.push(l) }), 1);
    assert.match(bare.join("\n"), /用法/);

    const unknown: string[] = [];
    assert.equal(main(["definitely-not-a-command"], { cwd, execGit: boomGit, log: (l) => unknown.push(l) }), 1);
    assert.match(unknown.join("\n"), /未知命令：definitely-not-a-command/);
  } finally {
    removeDir(cwd);
  }
});

test("main：仓库根解析失败 → exit 1 + 静态消息，不写任何文件", () => {
  const cwd = makeTempDir("todo-cli-root-fail-");
  const out: string[] = [];
  const code = main(["summary"], {
    cwd,
    execGit: () => {
      throw new Error("not a git repository");
    },
    log: (l) => out.push(l),
  });
  try {
    assert.equal(code, 1);
    assert.match(out.join("\n"), /找不到仓库根：当前目录不在 git 仓库内（可用 --root <dir> 指定）/);
    assert.deepEqual(fs.readdirSync(cwd), [], "失败路径不得创建任何文件");
  } finally {
    removeDir(cwd);
  }
});

test("main triage：git 不可用/不在仓库 → exit 1 + 静态消息（不抛栈）", () => {
  const root = makeTempDir("todo-cli-root-plain-");
  const out: string[] = [];
  try {
    const code = main(["triage"], {
      repoRoot: root,
      execGit: () => {
        throw new Error("fatal: not a git repository");
      },
      log: (l) => out.push(l),
    });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /triage 失败：.*不是 git 仓库/);
  } finally {
    removeDir(root);
  }
});

// ---------------------------------------------------------------------------
// 进程边界 E2E：真实子进程 + 真实 git 仓库
// ---------------------------------------------------------------------------

test("CLI E2E：真实 git 仓库的**子目录**调用 add/summary → 落到该仓库 todos/（git 自动发现）", (t) => {
  const repo = makeGitRepo();
  const other = makeTempDir("todo-cli-root-other-");
  t.after(() => {
    removeDir(repo);
    removeDir(other);
  });
  const nested = path.join(repo, "nested", "deeper");

  const added = runCli(["add", "--file", "general", "验收：子目录调用落到本仓库"], nested);
  assert.equal(added.status, 0, `add 应 exit 0（stdout=${added.stdout} stderr=${added.stderr}）`);
  assert.equal(added.stderr, "");
  const data = readGeneral(repo);
  assert.deepEqual(
    data.entries.map((entry) => [entry.text, entry.status]),
    [["验收：子目录调用落到本仓库", "open"]],
  );

  const summary = runCli(["summary"], nested);
  assert.equal(summary.status, 0);
  assert.match(summary.stdout, /general-todo\s+open 1/);

  // --root 覆盖 cwd 的仓库：cwd 在 repo 内，但写入 other/（非 git、仅 todos/）
  fs.mkdirSync(path.join(other, "todos"), { recursive: true });
  const otherPath = path.join(other, "todos", "general-todo.json");
  fs.writeFileSync(otherPath, serializeTodo(emptyTodoData("general-todo")));
  const viaRoot = runCli(["--root", other, "add", "--file", "general", "验收：--root 覆盖 cwd"], nested);
  assert.equal(viaRoot.status, 0, `--root add 应 exit 0（stdout=${viaRoot.stdout} stderr=${viaRoot.stderr}）`);
  assert.match(readGeneral(other).entries.map((entry) => entry.text).join(","), /--root 覆盖 cwd/);
  assert.deepEqual(readGeneral(repo).entries.map((entry) => entry.text), ["验收：子目录调用落到本仓库"], "cwd 仓库不得被 --root 调用污染");
});

test("CLI E2E：--root 指向不存在的目录 → exit 1 + 静态消息、stderr 恒空", (t) => {
  const repo = makeGitRepo();
  t.after(() => removeDir(repo));
  const res = runCli(["--root", path.join(repo, "no-such-dir"), "summary"], repo);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /--root 指向的目录不存在/);

  const missingValue = runCli(["summary", "--root"], repo);
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stdout, /缺少 --root 的目录/);
});
