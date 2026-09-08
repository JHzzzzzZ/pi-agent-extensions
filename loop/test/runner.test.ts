import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BG_RUN_TIMEOUT_MS,
  findSessionFile,
  getPiInvocation,
  runBgAgent,
  type BgChildProcess,
  type BgSpawn,
} from "../runner.ts";

// ---------- 假子进程：测试手动喂 stdout / 触发 close ----------

class FakeBgChild {
  kills: string[] = [];
  private stdoutCbs: Array<(chunk: Buffer) => void> = [];
  private stderrCbs: Array<(chunk: Buffer) => void> = [];
  private closeCbs: Array<(code: number | null) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];

  stdout = {
    on: (_event: "data", cb: (chunk: Buffer) => void) => {
      this.stdoutCbs.push(cb);
    },
  };
  stderr = {
    on: (_event: "data", cb: (chunk: Buffer) => void) => {
      this.stderrCbs.push(cb);
    },
  };
  on(event: "close" | "error", cb: (arg: never) => void): void {
    if (event === "close") this.closeCbs.push(cb as (code: number | null) => void);
    else this.errorCbs.push(cb as (err: Error) => void);
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }

  writeStdout(s: string): void {
    for (const cb of [...this.stdoutCbs]) cb(Buffer.from(s));
  }
  writeStderr(s: string): void {
    for (const cb of [...this.stderrCbs]) cb(Buffer.from(s));
  }
  close(code: number | null): void {
    for (const cb of [...this.closeCbs]) cb(code);
  }
  fail(err: Error): void {
    for (const cb of [...this.errorCbs]) cb(err);
  }
}

interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
}

function makeSpawn(): { spawn: BgSpawn; records: SpawnRecord[]; children: FakeBgChild[] } {
  const records: SpawnRecord[] = [];
  const children: FakeBgChild[] = [];
  const spawn: BgSpawn = (command, args, opts) => {
    records.push({ command, args, cwd: opts.cwd });
    const child = new FakeBgChild();
    children.push(child);
    return child as unknown as BgChildProcess;
  };
  return { spawn, records, children };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 会话头 + assistant 消息（JSON 模式 stdout 行） */
const sessionHeader = '{"type":"session","version":3,"id":"sess-1234","timestamp":"2026-09-08T10:00:00Z","cwd":"/p"}';
const assistantLine = (text: string) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

// ---------- getPiInvocation ----------

describe("getPiInvocation", () => {
  it("测试进程内（argv[1] 存在）→ node + 当前脚本 + 参数", () => {
    const { command, args } = getPiInvocation(["--mode", "json"]);
    assert.equal(command, process.execPath);
    assert.equal(args[0], process.argv[1]);
    assert.deepEqual(args.slice(1), ["--mode", "json"]);
  });
});

// ---------- runBgAgent ----------

describe("runBgAgent — 命令行构造", () => {
  it("不带 --no-session：--mode json -p --name loop-<taskId>，prompt 收尾，cwd 透传", async () => {
    const { spawn, records, children } = makeSpawn();
    const p = runBgAgent({ taskId: "ab12cd34", prompt: "做事情", cwd: "/proj", spawn });
    children[0]!.writeStdout(`${sessionHeader}\n`);
    children[0]!.close(0);
    await p;

    const rec = records[0]!;
    assert.equal(rec.cwd, "/proj");
    assert.ok(!rec.args.includes("--no-session"), "绝不能带 --no-session（否则会话不落盘、无法 resume）");
    const nameAt = rec.args.indexOf("--name");
    assert.ok(nameAt >= 0);
    assert.equal(rec.args[nameAt + 1], "loop-ab12cd34");
    assert.deepEqual(rec.args.slice(rec.args.indexOf("--mode"), rec.args.indexOf("--mode") + 2), ["--mode", "json"]);
    assert.ok(rec.args.includes("-p"));
    assert.equal(rec.args[rec.args.length - 1], "做事情");
  });
});

describe("runBgAgent — 输出解析", () => {
  it("捕获会话头 id 与最后一条 assistant 文本", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    const c = children[0]!;
    c.writeStdout(`${sessionHeader}\n${assistantLine("第一轮回复")}\n`);
    c.writeStdout(`${assistantLine("最终回复")}\n`);
    c.close(0);
    const outcome = await p;

    assert.equal(outcome.status, "done");
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.sessionId, "sess-1234");
    assert.equal(outcome.summary, "最终回复");
  });

  it("跨 chunk 的半行缓冲：会话头分两段写入也能解析", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    const c = children[0]!;
    c.writeStdout(sessionHeader.slice(0, 20));
    c.writeStdout(`${sessionHeader.slice(20)}\n${assistantLine("ok")}\n`);
    c.close(0);
    const outcome = await p;
    assert.equal(outcome.sessionId, "sess-1234");
    assert.equal(outcome.summary, "ok");
  });

  it("无 assistant 输出时 stderr 兜底；再兜底 (无输出)", async () => {
    const { spawn, children } = makeSpawn();
    const p1 = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    children[0]!.writeStderr("boom happened\n");
    children[0]!.close(0);
    const o1 = await p1;
    assert.equal(o1.summary, "boom happened");

    const { spawn: spawn2, children: children2 } = makeSpawn();
    const p2 = runBgAgent({ taskId: "t2", prompt: "x", spawn: spawn2 });
    children2[0]!.close(0);
    assert.equal((await p2).summary, "(无输出)");
  });

  it("超长 summary 截断到 MAX_BG_SUMMARY_LEN", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    children[0]!.writeStdout(`${assistantLine("x".repeat(5000))}\n`);
    children[0]!.close(0);
    const outcome = await p;
    assert.ok(outcome.summary.length <= 501);
    assert.ok(outcome.summary.endsWith("…"));
  });
});

describe("runBgAgent — 退出状态", () => {
  it("非零退出码 → failed", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    children[0]!.close(1);
    const outcome = await p;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.exitCode, 1);
  });

  it("spawn 抛错 → failed，不悬挂", async () => {
    const spawn: BgSpawn = () => {
      throw new Error("EACCES");
    };
    const outcome = await runBgAgent({ taskId: "t1", prompt: "x", spawn });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.summary, /EACCES/);
  });

  it("spawn error 事件（如 ENOENT）→ failed", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn });
    children[0]!.fail(new Error("spawn ENOENT"));
    const outcome = await p;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.summary, /ENOENT/);
  });

  it("超时：SIGTERM → 宽限期后 SIGKILL，状态 timeout", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn, timeoutMs: 10, killGraceMs: 10 });
    await sleep(60);
    assert.deepEqual(children[0]!.kills, ["SIGTERM", "SIGKILL"]);
    children[0]!.close(null);
    const outcome = await p;
    assert.equal(outcome.status, "timeout");
  });

  it("正常结束不触发超时击杀", async () => {
    const { spawn, children } = makeSpawn();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn, timeoutMs: 30 });
    children[0]!.close(0);
    await p;
    await sleep(40);
    assert.equal(children[0]!.kills.length, 0, "结束后不得再发信号");
  });

  it("abort 信号：立即 SIGTERM，宽限后 SIGKILL", async () => {
    const { spawn, children } = makeSpawn();
    const controller = new AbortController();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn, signal: controller.signal, killGraceMs: 10 });
    await sleep(1);
    controller.abort();
    await sleep(30);
    assert.deepEqual(children[0]!.kills, ["SIGTERM", "SIGKILL"]);
    children[0]!.close(null);
    await p;
  });

  it("预中止的信号：spawn 后立即 SIGTERM", async () => {
    const { spawn, children } = makeSpawn();
    const controller = new AbortController();
    controller.abort();
    const p = runBgAgent({ taskId: "t1", prompt: "x", spawn, signal: controller.signal, killGraceMs: 10 });
    await sleep(30);
    assert.deepEqual(children[0]!.kills, ["SIGTERM", "SIGKILL"]);
    children[0]!.close(null);
    await p;
  });
});

describe("findSessionFile", () => {
  it("按 pi 会话目录布局定位 <ts>_<sessionId>.jsonl", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-sess-"));
    try {
      const dir = path.join(agentDir, "sessions", "--C--tmp-proj--");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "20260908_1234abcd.jsonl");
      fs.writeFileSync(file, "{}");
      assert.equal(findSessionFile("1234abcd", "C:\\tmp\\proj", agentDir), file);
      assert.equal(findSessionFile("missing", "C:\\tmp\\proj", agentDir), undefined);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("目录不存在 / 缺参 → undefined（不抛错）", () => {
    assert.equal(findSessionFile("x", "C:\\no\\such\\dir", path.join(os.tmpdir(), "loop-none-xyz")), undefined);
    assert.equal(findSessionFile("", "C:\\x", undefined), undefined);
    assert.equal(findSessionFile("x", "", undefined), undefined);
  });
});

describe("常量", () => {
  it("超时与宽限期默认值", () => {
    assert.equal(BG_RUN_TIMEOUT_MS, 30 * 60 * 1000);
  });
});
