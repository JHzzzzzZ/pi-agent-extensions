/**
 * jobs.ts 单测：后台任务注册表的状态机（timeout-bg-todo#1）
 *
 * 边界：纯内存状态 + 注入 now/killTree；不 spawn 进程、不碰真实 fs。
 * 语义要点：只有「超时被转入后台」的任务才进注册表；kill 是用户主动动作，
 * 不触发完成通知（onExit 只在自然退出时回调一次）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJobRegistry, type JobRecord } from "../jobs.ts";

function makeHarness() {
  let clock = 1_000;
  const killCalls: number[] = [];
  const exits: JobRecord[] = [];
  let changes = 0;
  const registry = createJobRegistry({
    now: () => clock,
    killTree: (pid) => killCalls.push(pid),
    onExit: (job) => exits.push(job),
    onChange: () => (changes += 1),
  });
  return { registry, killCalls, exits, tickClock: (ms: number) => (clock += ms), changes: () => changes };
}

test("background：登记 running 任务，pid/命令/日志路径就位", () => {
  const { registry } = makeHarness();
  const job = registry.background({ id: "bg-1", pid: 4321, command: "sleep 400\nsecond", logPath: "/tmp/bg-1.log" });
  assert.equal(job.status, "running");
  assert.equal(job.pid, 4321);
  assert.equal(job.exitCode, null);
  assert.equal(job.endedAtMs, null);
  assert.equal(job.startedAtMs, 1_000);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.running().length, 1);
});

test("markExited：转 exited + 退出码 + 结束时间，并回调 onExit 一次", () => {
  const h = makeHarness();
  h.registry.background({ id: "bg-1", pid: 1, command: "x", logPath: "/tmp/x.log" });
  h.tickClock(2_500);
  h.registry.markExited("bg-1", 3);
  const job = h.registry.get("bg-1")!;
  assert.equal(job.status, "exited");
  assert.equal(job.exitCode, 3);
  assert.equal(job.endedAtMs, 3_500);
  assert.equal(h.exits.length, 1);
  h.registry.markExited("bg-1", 3); // 幂等：不重复回调
  assert.equal(h.exits.length, 1);
  assert.equal(h.registry.running().length, 0);
});

test("markKilled：转 killed、无退出码、不触发完成通知", () => {
  const h = makeHarness();
  h.registry.background({ id: "bg-1", pid: 1, command: "x", logPath: "/tmp/x.log" });
  h.registry.markKilled("bg-1");
  assert.equal(h.registry.get("bg-1")!.status, "killed");
  assert.equal(h.exits.length, 0);
});

test("kill：running 才调 killTree(pid)；未知/已结束返回 false", () => {
  const h = makeHarness();
  h.registry.background({ id: "bg-1", pid: 777, command: "x", logPath: "/tmp/x.log" });
  assert.equal(h.registry.kill("bg-1"), true);
  assert.deepEqual(h.killCalls, [777]);
  h.registry.markKilled("bg-1");
  assert.equal(h.registry.kill("bg-1"), false, "已结束不再杀");
  assert.equal(h.registry.kill("bg-404"), false);
  assert.deepEqual(h.killCalls, [777]);
});

test("killAll：只杀 running，返回条数", () => {
  const h = makeHarness();
  h.registry.background({ id: "bg-1", pid: 1, command: "a", logPath: "/tmp/1.log" });
  h.registry.background({ id: "bg-2", pid: 2, command: "b", logPath: "/tmp/2.log" });
  h.registry.background({ id: "bg-3", pid: 3, command: "c", logPath: "/tmp/3.log" });
  h.registry.markExited("bg-2", 0);
  assert.equal(h.registry.killAll(), 2);
  assert.deepEqual(h.killCalls, [1, 3]);
});

test("远端 job：terminate 优先于 killTree，且 onChange 覆盖登记/结束/被杀/清理（timeout-bg#4）", () => {
  const h = makeHarness();
  const terminates: string[] = [];
  h.registry.background({
    id: "bg-1",
    pid: null,
    command: "sleep 400",
    logPath: "/tmp/1.log",
    target: "deploy@host",
    terminate: () => terminates.push("bg-1"),
  });
  const job = h.registry.get("bg-1")!;
  assert.equal(job.pid, null, "远端 job 没有本地 pid");
  assert.equal(job.target, "deploy@host");
  assert.equal(h.changes(), 1, "background 要触发 onChange（状态条段刷新）");

  assert.equal(h.registry.kill("bg-1"), true);
  assert.deepEqual(terminates, ["bg-1"], "远端 job 走自带终止钩子");
  assert.deepEqual(h.killCalls, [], "有 terminate 时不得拿 pid 兜底（远端 job 的 pid 是 null）");
  assert.equal(h.changes(), 2);

  // 已被 kill 的 job 再 settle：忽略（不重复通知、不改状态）。
  h.registry.markExited("bg-1", 0);
  assert.equal(h.registry.get("bg-1")!.status, "killed");
  assert.equal(h.exits.length, 0);
  assert.equal(h.changes(), 2, "无效变更不触发 onChange");

  assert.equal(h.registry.clear(), 1);
  assert.equal(h.changes(), 3, "清理也要刷新状态条段（段消失）");
});

/** 没有 terminate 的 job（本地）仍然走 killTree；异常钩子不得破坏命令面。 */
test("terminate 抛错被吞掉：kill/killAll 不因观察者异常失败", () => {
  const h = makeHarness();
  h.registry.background({
    id: "bg-1",
    pid: null,
    command: "x",
    logPath: "/tmp/1.log",
    target: "deploy@host",
    terminate: () => {
      throw new Error("remote kill boom");
    },
  });
  assert.equal(h.registry.kill("bg-1"), true);
  assert.equal(h.registry.get("bg-1")!.status, "killed");
  assert.equal(h.registry.killAll(), 0, "已 killed 不再重复终止");
});

test("list：最近登记在前；clear：只清已结束的记录", () => {
  const h = makeHarness();
  h.registry.background({ id: "bg-1", pid: 1, command: "a", logPath: "/tmp/1.log" });
  h.tickClock(10);
  h.registry.background({ id: "bg-2", pid: 2, command: "b", logPath: "/tmp/2.log" });
  assert.deepEqual(
    h.registry.list().map((j) => j.id),
    ["bg-2", "bg-1"],
  );
  h.registry.markExited("bg-1", 0);
  assert.equal(h.registry.clear(), 1);
  assert.deepEqual(
    h.registry.list().map((j) => j.id),
    ["bg-2"],
  );
});

test("origin：缺省为 timeout（既有调用点零改动），主动后台显式标 background", () => {
  const h = makeHarness();
  const byTimeout = h.registry.background({ id: "bg-1", pid: 1, command: "a", logPath: "/tmp/1.log" });
  h.tickClock(10);
  const byRequest = h.registry.background({ id: "bg-2", pid: 2, command: "b", logPath: "/tmp/2.log", origin: "background" });
  assert.equal(byTimeout.origin, "timeout");
  assert.equal(byRequest.origin, "background");
  assert.deepEqual(
    h.registry.list().map((j) => j.origin),
    ["background", "timeout"],
  );
});
