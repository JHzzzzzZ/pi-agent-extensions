/**
 * touch.ts 单测：「模型碰了哪个目录」的第一跳 —— 工具 + 入参 → 被触碰的路径。
 *
 * 边界：本文件只测纯解析（无 fs、无宿主）。路径是否合法/是否在 cwd 之下的判定在
 * anchor.ts 的测试里用真实临时目录覆盖。bash 白名单是启发式：漏判只是少注入，
 * 误判最多多注入一个目录的上下文，因此用例同时锁「该认的认」与「拿不准的不认」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTouch } from "../touch.ts";

test("read / write / edit：入参 path 是文件，锚点按文件处理", () => {
  for (const toolName of ["read", "write", "edit"]) {
    assert.deepEqual(detectTouch(toolName, { path: "src/components/Button.tsx" }), {
      rawPath: "src/components/Button.tsx",
      kind: "file",
    });
  }
});

test("ls：入参 path 是目录", () => {
  assert.deepEqual(detectTouch("ls", { path: "src/components" }), { rawPath: "src/components", kind: "directory" });
});

test("ls：省略 path 视为当前目录（cwd）", () => {
  assert.deepEqual(detectTouch("ls", {}), { rawPath: ".", kind: "directory" });
});

test("bash 单文件读：cat / head / tail 各形态都认", () => {
  const cases: Array<[string, string]> = [
    ["cat src/a.ts", "src/a.ts"],
    ["cat ./src/a.ts", "./src/a.ts"],
    ["head -n 20 src/a.ts", "src/a.ts"],
    ["head -20 src/a.ts", "src/a.ts"],
    ["tail -5 src/a.ts", "src/a.ts"],
    ["tail -n +1 src/a.ts", "src/a.ts"],
    ['cat "src/a b.ts"', "src/a b.ts"],
    ["cat 'src/a b.ts'", "src/a b.ts"],
    ["cat src/a.ts | head -5", "src/a.ts"],
  ];
  for (const [command, expected] of cases) {
    assert.deepEqual(detectTouch("bash", { command }), { rawPath: expected, kind: "file" }, command);
  }
});

test("bash 拿不准一律不认：多文件、重定向、变量、非读命令", () => {
  const commands = [
    "cat a.ts b.ts", // 多文件：无法判断碰的是哪个目录
    "cat a.ts > out.txt", // 重定向
    "cat < a.ts",
    "cat $FILE",
    "cat `pwd`/a.ts",
    "npm test",
    "git status",
    "rm src/a.ts",
    "ls src",
    "grep -rn foo src",
    "echo src/a.ts",
    "",
  ];
  for (const command of commands) {
    assert.equal(detectTouch("bash", { command }), null, command);
  }
});

test("非触发工具与非法入参：零触碰", () => {
  assert.equal(detectTouch("grep", { path: "src" }), null);
  assert.equal(detectTouch("find", { path: "src" }), null);
  assert.equal(detectTouch("powershell", { command: "cat src/a.ts" }), null);
  assert.equal(detectTouch("read", { path: 42 }), null);
  assert.equal(detectTouch("read", {}), null);
  assert.equal(detectTouch("ls", { path: 42 }), null);
  assert.equal(detectTouch("bash", { command: 42 }), null);
});
