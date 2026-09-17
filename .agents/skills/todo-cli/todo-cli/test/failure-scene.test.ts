/**
 * todo-cli/failure-scene.test.ts — 失败现场 helper 的行为锁定（todo-cli-todo:13 第一步）。
 *
 * 动机：test:todo 并发用例首跑失败时只剩 reporter 一行与截断 200 字符的 stderr
 * （`res.stderr.slice(0, 200)`），无法区分「锁等待拖到超时」「EPERM rename 争用」
 * 「测试自身竞态」。本文件锁定 helper 契约：失败才写现场、通过零写盘零输出、
 * 原错误对象原样重抛（写盘失败绝不吞失败）、现场文件名确定（stamp + 碰撞取号）。
 *
 * 边界：第 ⑦ 例用真子进程（真退出码 + 真 stderr，防纸面正确），其余注入固定时钟；
 * 每个用例各自 mkdtemp 目录，绝不写共享默认目录 `%TEMP%\todo-cli-failure-scenes`。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { archiveStamp } from "../align.ts";
import { activeSceneSink, withFailureScene } from "./failure-scene.ts";
import type { SceneDeps } from "./failure-scene.ts";

const START = "2026-08-05T12:00:00Z";
const SPAWN_AT = "2026-08-05T12:00:01Z";
const CLOSE_AT = "2026-08-05T12:00:02Z";
const END = "2026-08-05T12:00:03Z";

/** 每个用例独享的现场目录（写盘后由 t.after 清理）。 */
function makeSceneDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-failure-scene-test-"));
}

/** 脚本化时钟：按序返回注入时刻，用尽后退化为最后一个（对实现调用次数不敏感）。 */
function scriptedClock(times: string[]): () => string {
  let index = 0;
  return () => {
    const value = times[Math.min(index, times.length - 1)];
    index += 1;
    return value;
  };
}

/** 跑一个必失败的 wrapper，返回被重抛的原值（含 message 追加后的形态）。 */
async function caughtFrom(name: string, body: () => void, deps: SceneDeps): Promise<unknown> {
  try {
    await withFailureScene(name, body, deps);
  } catch (thrown) {
    return thrown;
  }
  assert.fail("失败体必须被重抛");
}

/** 读现场目录里唯一的现场文件（用例名/目录都注入，数量应确定）。 */
function readSingleScene(dir: string): { file: string; content: string } {
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `现场目录应恰有一个文件，实际 ${JSON.stringify(files)}`);
  const file = files[0];
  return { file, content: fs.readFileSync(path.join(dir, file), "utf8") };
}

test("① 失败：现场文件产生于注入 dir（文件名 = stamp-净化名），含用例名/起止/错误/stack，重抛同一 Error 且 message 尾行为路径", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = "并发写 6 个子进程 add";
  const original = new Error("boom 现场测试");

  const thrown = await caughtFrom(
    name,
    () => {
      throw original;
    },
    { dir, now: scriptedClock([START, END]) },
  );

  assert.equal(thrown, original, "必须重抛同一个 Error 对象（stack 与字段不动）");
  const { file, content } = readSingleScene(dir);
  assert.equal(file, `${archiveStamp(START)}-并发写-6-个子进程-add.md`, "文件名 = 开始 stamp-净化用例名");
  const scenePath = path.join(dir, file);
  assert.ok(path.isAbsolute(scenePath), "现场路径必须是绝对路径");
  assert.equal((thrown as Error).message.split("\n").at(-1), `[失败现场] ${scenePath}`, "message 尾行必须给绝对路径");

  assert.ok(content.includes(`# 失败现场：${name}`), "标题含原始用例名");
  assert.ok(content.includes(START) && content.includes(END), "头部含开始/结束 ISO");
  assert.ok(content.includes("boom 现场测试"), "含原始错误文本");
  assert.ok(content.includes("failure-scene.test.ts"), "含完整 stack（可定位到测试文件）");
});

test("② 通过：返回值原样透传；目录直到失败才创建（通过路径零写盘）", async (t) => {
  const root = makeSceneDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "nested", "scenes");

  const value = await withFailureScene("通过用例", async () => 42, { dir, now: scriptedClock([START, END]) });

  assert.equal(value, 42, "通过体返回值必须原样透传");
  assert.equal(fs.existsSync(dir), false, "通过路径不得 mkdir/写盘");
});

test("③ 时间线：seq 升序、spawn 行含 args、close 行 durationMs = close−spawn、stdout/stderr 全文进输出节", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stdout = "OUT-全文-第一行\nOUT-全文-第二行\n";
  const stderr = "ERR-全文-第一行\nERR-全文-第二行\n";

  const thrown = await caughtFrom(
    "时间线用例",
    () => {
      const sink = activeSceneSink();
      assert.ok(sink !== null, "wrapper 内必须有激活 sink");
      const childId = sink.spawn("add", { pid: 4321, args: ["--file", "general"] });
      sink.close(childId, { code: 0, signal: null, stdout, stderr });
      throw new Error("close 后失败");
    },
    { dir, now: scriptedClock([START, SPAWN_AT, CLOSE_AT, END]) },
  );

  assert.ok(thrown instanceof Error);
  const { content } = readSingleScene(dir);
  const rows = content.split("\n");
  const spawnRow = rows.find((line) => line.startsWith("| 1 |"));
  const closeRow = rows.find((line) => line.startsWith("| 2 |"));
  assert.ok(spawnRow !== undefined && closeRow !== undefined, "时间线必须含 seq 1/2 两行");
  assert.ok(spawnRow.includes(SPAWN_AT) && spawnRow.includes("--file general"), "spawn 行含时刻与 args");
  assert.ok(content.indexOf("| 1 |") < content.indexOf("| 2 |"), "seq 必须升序");
  assert.ok(closeRow.endsWith("| 1000 |"), `close 行耗时必须 = close−spawn = 1000，实际：${closeRow}`);
  assert.ok(content.includes(stdout), "stdout 全文（不截断）");
  assert.ok(content.includes(stderr), "stderr 全文（不截断）");
});

test("④ 无激活场景：activeSceneSink() 为 null，?. 喂事件短路不抛", () => {
  const sink = activeSceneSink();
  assert.equal(sink, null, "wrapper 外必须为 null");
  assert.doesNotThrow(() => {
    sink?.spawn("x");
    sink?.close(1, { code: 0, signal: null, stdout: "o", stderr: "e" });
    sink?.fail(1, "err");
    sink?.note("k", "v");
  });
});

test("⑤ 写盘失败（dir 是已存在文件）：原错误原样重抛，message 不含追加行", async (t) => {
  const root = makeSceneDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notADir = path.join(root, "not-a-dir");
  fs.writeFileSync(notADir, "占位文件");
  const original = new Error("原始错误 必须原样");

  const thrown = await caughtFrom(
    "写盘失败用例",
    () => {
      throw original;
    },
    { dir: notADir, now: scriptedClock([START, END]) },
  );

  assert.equal(thrown, original, "写盘失败也必须重抛同一对象");
  assert.equal((thrown as Error).message, "原始错误 必须原样", "写盘失败绝不追加路径行");
  assert.equal(fs.readFileSync(notADir, "utf8"), "占位文件", "已存在文件不得被改写");
});

test("⑥ 非 Error 抛出：原值重抛，现场文件仍写", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const thrown = await caughtFrom(
    "字符串抛出用例",
    () => {
      throw "字符串抛错";
    },
    { dir, now: scriptedClock([START, END]) },
  );

  assert.equal(thrown, "字符串抛错", "必须重抛原值（非 Error）");
  const { content } = readSingleScene(dir);
  assert.ok(content.includes("字符串抛错"), "非 Error 也要写现场并记下原值");
});

test("⑦ 真实子进程（真 exit 3 + 真 stderr）按接线模式喂 sink：现场含 exit 3 与 stderr 全文", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const childScript = "console.error('boom-stderr'); process.exit(3)";

  const thrown = await caughtFrom(
    "真子进程用例",
    async () => {
      const sink = activeSceneSink();
      assert.ok(sink !== null, "wrapper 内必须有激活 sink");
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ["-e", childScript]);
        let stdout = "";
        let stderr = "";
        const childId = sink.spawn("node -e", { pid: child.pid, args: ["-e", childScript] });
        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (err) => sink.fail(childId, String(err)));
        child.on("close", (code, signal) => {
          sink.close(childId, { code, signal, stdout, stderr });
          resolve();
        });
      });
      throw new Error("真子进程用例强制失败");
    },
    { dir, now: scriptedClock([START, SPAWN_AT, CLOSE_AT, END]) },
  );

  assert.ok(thrown instanceof Error);
  const { content } = readSingleScene(dir);
  assert.ok(content.includes("exit 3"), "close 行必须写真实退出码");
  assert.ok(content.includes("boom-stderr"), "stderr 全文（含注入文本）不得被截断");
});

test("⑧ 同 stamp 同名两次失败：第二个文件名带 -2（确定性取号）", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = "同名碰撞";

  await caughtFrom(
    name,
    () => {
      throw new Error("第一次");
    },
    { dir, now: () => START },
  );
  await caughtFrom(
    name,
    () => {
      throw new Error("第二次");
    },
    { dir, now: () => START },
  );

  const stamp = archiveStamp(START);
  const expected = [`${stamp}-同名碰撞-2.md`, `${stamp}-同名碰撞.md`].sort();
  assert.deepEqual(fs.readdirSync(dir).sort(), expected, "第二次碰撞必须写 -2 且不覆盖第一份");
  assert.ok(fs.readFileSync(path.join(dir, `${stamp}-同名碰撞.md`), "utf8").includes("第一次"));
  assert.ok(fs.readFileSync(path.join(dir, `${stamp}-同名碰撞-2.md`), "utf8").includes("第二次"));
});

test("⑨ notes 按记录顺序渲染进备注节", async (t) => {
  const dir = makeSceneDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await caughtFrom(
    "备注顺序用例",
    () => {
      const sink = activeSceneSink();
      assert.ok(sink !== null, "wrapper 内必须有激活 sink");
      sink.note("fixture root", "/tmp/fixture-甲");
      sink.note("剩余锁", "[]");
      sink.note("追加", "丙");
      throw new Error("备注后失败");
    },
    { dir, now: () => START },
  );

  const { content } = readSingleScene(dir);
  assert.ok(content.includes("## 备注"), "必须有备注节");
  const first = content.indexOf("fixture root");
  const second = content.indexOf("剩余锁");
  const third = content.indexOf("追加");
  assert.ok(first >= 0 && second > first && third > second, "notes 必须按记录顺序渲染");
});
