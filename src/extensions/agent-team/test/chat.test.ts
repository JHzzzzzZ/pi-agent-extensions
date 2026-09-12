/**
 * agent-team — viewer 直接对话：派单语义纯函数与队列
 *
 * chat.ts 是纯逻辑层：buildChatTask（消息 → 新 run 的 task 模板）、
 * transcriptContextTail（上文尾部截断）、ChatCoordinator（FIFO 队列 +
 * 链式派出门控）。全部依赖注入（resolveTeam/startRun/contextTail/notify），
 * 不触进程与文件系统——宿主接线由 viewer-chat-host.test.ts 覆盖。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_CONTEXT_TAIL_BYTES,
  ChatCoordinator,
  buildChatTask,
  buildSteerMessage,
  chatSubmitNotice,
  transcriptContextTail,
  type ChatMessage,
} from "../chat.ts";
import { LEADER_ACTOR } from "../transcript.ts";
import type { TranscriptEntry } from "../transcript.ts";
import { fixtureTeam } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// buildChatTask
// ---------------------------------------------------------------------------

test("buildChatTask：目标 leader — 用户消息 + leader 上文尾部", () => {
  const task = buildChatTask(
    { actor: LEADER_ACTOR, label: "leader", isLeader: true, runId: "run-1" },
    "把 backend 的任务停一下",
    "[assistant] 收到，正在派发",
  );
  assert.match(task, /【用户消息】/);
  assert.match(task, /把 backend 的任务停一下/);
  assert.match(task, /leader 最近会话尾部/);
  assert.match(task, /\[assistant\] 收到，正在派发/);
});

test("buildChatTask：目标 leader — 无上文尾部时不出现尾部段", () => {
  const task = buildChatTask({ actor: LEADER_ACTOR, label: "leader", isLeader: true, runId: "run-1" }, "你好", "");
  assert.doesNotMatch(task, /最近会话尾部/);
  assert.match(task, /你好/);
});

test("buildChatTask：目标成员 — 指示 leader 转派并点名成员", () => {
  const task = buildChatTask(
    { actor: "frontend", label: "frontend", isLeader: false, runId: "run-1" },
    "你写的组件用一下 TypeScript",
    "[tool] edit src/App.tsx",
  );
  assert.match(task, /请转派/);
  assert.match(task, /frontend/);
  assert.match(task, /你写的组件用一下 TypeScript/);
  assert.match(task, /frontend 最近会话尾部/);
  assert.match(task, /\[tool\] edit src\/App\.tsx/);
});

// ---------------------------------------------------------------------------
// transcriptContextTail
// ---------------------------------------------------------------------------

function entry(kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
  return { kind, text, ts: "2026-09-10T12:00:00Z" };
}

test("transcriptContextTail：拼接为 [kind] text 行，按时间序", () => {
  const tail = transcriptContextTail([entry("task", "原始任务"), entry("assistant", "开工"), entry("tool", "edit a.ts")]);
  assert.match(tail, /\[task\] 原始任务\n\[assistant\] 开工\n\[tool\] edit a\.ts/);
});

test("transcriptContextTail：超出上限时从尾部保留（丢头部）", () => {
  const lines: TranscriptEntry[] = [];
  for (let i = 0; i < 100; i++) lines.push(entry("assistant", `第 ${i} 条消息，内容填充`.repeat(4)));
  const tail = transcriptContextTail(lines, 400);
  assert.ok(Buffer.byteLength(tail, "utf8") <= 400);
  assert.match(tail, /第 9\d 条消息/, "保留的是最后的条目");
  assert.doesNotMatch(tail, /第 0 条消息/, "头部条目被丢弃");
});

test("transcriptContextTail：空记录返回空串；默认上限常量为 2000 字节", () => {
  assert.equal(transcriptContextTail([]), "");
  assert.equal(CHAT_CONTEXT_TAIL_BYTES, 2000);
});

test("transcriptContextTail：文本内部换行折叠为单行", () => {
  const tail = transcriptContextTail([entry("assistant", "第一行\n第二行\n第三行")]);
  assert.equal(tail, "[assistant] 第一行 第二行 第三行");
});

// ---------------------------------------------------------------------------
// ChatCoordinator（fake deps）
// ---------------------------------------------------------------------------

interface FakeStartRecord {
  teamName: string;
  task: string;
}

function fakeDeps(overrides: {
  running?: boolean;
  team?: { ok: true; value: ReturnType<typeof fixtureTeam> } | { ok: false; message: string };
  startError?: string;
  tail?: string;
  steer?: (runId: string, message: string) => boolean;
} = {}) {
  const starts: FakeStartRecord[] = [];
  const notes: Array<{ text: string; level: string }> = [];
  const steers: Array<{ runId: string; message: string }> = [];
  const deps = {
    resolveTeam: (name: string) =>
      overrides.team ?? { ok: true as const, value: fixtureTeam({ name }) },
    isRunning: () => overrides.running ?? false,
    startRun: (_ctx: unknown, team: { name: string }, task: string) => {
      if (overrides.startError) return { ok: false as const, code: "X", message: overrides.startError };
      starts.push({ teamName: team.name, task });
      return { ok: true as const, runId: `run-${starts.length}` };
    },
    contextTail: (_runId: string, _actor: string) => overrides.tail ?? "[assistant] 旧上下文",
    ...(overrides.steer
      ? {
          steerLeader: (runId: string, message: string) => {
            steers.push({ runId, message });
            return overrides.steer!(runId, message);
          },
        }
      : {}),
  };
  return { deps, starts, notes, steers };
}

const leaderTarget = { actor: LEADER_ACTOR, label: "leader", isLeader: true, runId: "run-1" };
const memberTarget = { actor: "frontend", label: "frontend", isLeader: false, runId: "run-1" };

function session(fake: ReturnType<typeof fakeDeps>, teamName = "dev-team") {
  return {
    teamName,
    ctx: undefined,
    notify: (text: string, level: "info" | "warning" | "error") => fake.notes.push({ text, level }),
  };
}

test("submit：run 未运行 → 立即派单，task 含用户消息与上文尾部", () => {
  const fake = fakeDeps({ tail: "[assistant] 旧上下文" });
  const chat = new ChatCoordinator(fake.deps);
  const outcome = chat.submit(session(fake), leaderTarget, "改一下标题文案");
  assert.deepEqual(outcome, { kind: "started", runId: "run-1" });
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0]?.teamName, "dev-team");
  assert.match(fake.starts[0]?.task ?? "", /改一下标题文案/);
  assert.match(fake.starts[0]?.task ?? "", /\[assistant\] 旧上下文/);
});

test("submit：run 运行中 → 入队不派单，pending 计数 FIFO", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  assert.deepEqual(chat.submit(session(fake), leaderTarget, "第一条"), { kind: "queued", pending: 1 });
  assert.deepEqual(chat.submit(session(fake), leaderTarget, "第二条"), { kind: "queued", pending: 2 });
  assert.equal(fake.starts.length, 0);
  assert.equal(chat.size, 2);
});

test("onRunFinalized：completed → 按队列顺序链式派出一条", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), leaderTarget, "第一条");
  chat.submit(session(fake), leaderTarget, "第二条");
  fake.deps.isRunning = () => false;
  chat.onRunFinalized("run-1", "completed");
  assert.equal(fake.starts.length, 1, "一次只链发一条，下一条等本 run 落定");
  assert.match(fake.starts[0]?.task ?? "", /第一条/);
  assert.equal(chat.size, 1);
  assert.match(fake.notes[0]?.text ?? "", /自动续发/);
});

test("onRunFinalized：failed/aborted → 只丢弃该 run 的排队条目并通知丢弃条数", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), leaderTarget, "a");
  chat.submit(session(fake), leaderTarget, "b");
  fake.deps.isRunning = () => false;
  chat.onRunFinalized("run-1", "aborted");
  assert.equal(fake.starts.length, 0, "中止后不续发");
  assert.equal(chat.size, 0);
  assert.match(fake.notes[0]?.text ?? "", /aborted/);
  assert.match(fake.notes[0]?.text ?? "", /2 条/);
  assert.match(fake.notes[0]?.text ?? "", /run-1/);
});

test("onRunFinalized：failed 只丢弃属于该 run 的条目，其他 run 的排队保留", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), { ...leaderTarget, runId: "run-a" }, "给 run-a");
  chat.submit(session(fake), { ...leaderTarget, runId: "run-b" }, "给 run-b");
  chat.onRunFinalized("run-a", "failed");
  assert.equal(chat.size, 1, "run-b 的排队条目保留");
  assert.match(fake.notes[0]?.text ?? "", /run-a/);
  assert.match(fake.notes[0]?.text ?? "", /1 条/);

  // run-b 不受 run-a 失败影响，之后 completed 仍能链式派出。
  fake.deps.isRunning = () => false;
  chat.onRunFinalized("run-b", "completed");
  assert.equal(fake.starts.length, 1);
  assert.match(fake.starts[0]?.task ?? "", /给 run-b/);
});

test("onRunFinalized：队列空 → 什么都不做", () => {
  const fake = fakeDeps({ running: false });
  const chat = new ChatCoordinator(fake.deps);
  chat.onRunFinalized("run-1", "completed");
  chat.onRunFinalized("run-1", "failed");
  assert.equal(fake.starts.length, 0);
  assert.equal(fake.notes.length, 0);
});

test("submit：resolveTeam 失败 → rejected + 清空队列", () => {
  const fake = fakeDeps({ running: true, team: { ok: false, message: "没有团队 nope" } });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), leaderTarget, "先排队");
  fake.deps.isRunning = () => false;
  const outcome = chat.submit(session(fake, "nope"), leaderTarget, "再提交");
  assert.equal(outcome.kind, "rejected");
  assert.match((outcome as { message: string }).message, /nope/);
  assert.equal(chat.size, 0, "连先前的排队一并清空");
});

test("submit：startRun 失败（如 model 预检/RUN_IN_PROGRESS）→ rejected + 清空队列", () => {
  const fake = fakeDeps({ startError: "另一个 team run 正在进行中" });
  const chat = new ChatCoordinator(fake.deps);
  const outcome = chat.submit(session(fake), leaderTarget, "hello");
  assert.equal(outcome.kind, "rejected");
  assert.match((outcome as { message: string }).message, /RUN_IN_PROGRESS|进行中/);
  assert.equal(chat.size, 0);
});

test("clear：返回丢弃条数并清空", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), leaderTarget, "a");
  chat.submit(session(fake), leaderTarget, "b");
  assert.equal(chat.clear(), 2);
  assert.equal(chat.size, 0);
  assert.equal(chat.clear(), 0);
});

test("clearRun：只丢弃属于该 run 的排队条目", () => {
  const fake = fakeDeps({ running: true });
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), { ...leaderTarget, runId: "run-a" }, "a1");
  chat.submit(session(fake), { ...leaderTarget, runId: "run-b" }, "b1");
  chat.submit(session(fake), { ...leaderTarget, runId: "run-a" }, "a2");
  assert.equal(chat.clearRun("run-a"), 2);
  assert.equal(chat.size, 1);
  assert.equal(chat.clearRun("run-nope"), 0);

  fake.deps.isRunning = () => false;
  chat.onRunFinalized("run-b", "completed");
  assert.equal(fake.starts.length, 1);
  assert.match(fake.starts[0]?.task ?? "", /b1/);
});

test("chatSubmitNotice：三种结果映射为 notice 文案", () => {
  assert.equal(chatSubmitNotice({ kind: "started", runId: "run-9" }, "leader").kind, "success");
  assert.match(chatSubmitNotice({ kind: "started", runId: "run-9" }, "leader").text, /run-9/);
  assert.equal(chatSubmitNotice({ kind: "queued", pending: 2 }, "frontend").kind, "warning");
  assert.match(chatSubmitNotice({ kind: "queued", pending: 2 }, "frontend").text, /2/);
  assert.equal(chatSubmitNotice({ kind: "rejected", message: "boom" }, "frontend").kind, "error");
  assert.match(chatSubmitNotice({ kind: "rejected", message: "boom" }, "frontend").text, /boom/);
  const steered = chatSubmitNotice({ kind: "steered" }, "leader");
  assert.equal(steered.kind, "success");
  assert.match(steered.text, /已插话/);
  assert.match(steered.text, /不打断/);
});

test("submit：run 运行中 + leader 目标 + steer 可用 → 插话（不排队、不派单）", () => {
  const fake = fakeDeps({ running: true, steer: () => true });
  const chat = new ChatCoordinator(fake.deps);
  const outcome = chat.submit(session(fake), leaderTarget, "数数途中打个招呼");
  assert.deepEqual(outcome, { kind: "steered" });
  assert.equal(fake.starts.length, 0, "不派新 run");
  assert.equal(chat.size, 0, "不进队列");
  assert.equal(fake.steers.length, 1);
  assert.equal(fake.steers[0]?.runId, "run-1", "steer 定向到目标 actor 的 runId");
  assert.deepEqual(fake.steers[0]?.message, buildSteerMessage("数数途中打个招呼"));
  assert.match(fake.steers[0]?.message ?? "", /【用户消息·插话】/);
});

test("submit：目标 run 的 steer 不可用（如 runB 未活跃）→ 回退队列，不误插其他 run", () => {
  const fake = fakeDeps({ running: true, steer: (runId) => runId === "run-a" });
  const chat = new ChatCoordinator(fake.deps);
  const outcome = chat.submit(session(fake), { ...leaderTarget, runId: "run-b" }, "给 run-b");
  assert.deepEqual(outcome, { kind: "queued", pending: 1 });
  assert.equal(fake.steers.length, 1);
  assert.equal(fake.steers[0]?.runId, "run-b", "steer 尝试只发给目标 run");
  assert.equal(chat.size, 1, "回退到队列（带目标 runId）");
});

test("submit：steer 失败回退队列；成员目标不尝试 steer（无通道）", () => {
  const fake = fakeDeps({ running: true, steer: () => false });
  const chat = new ChatCoordinator(fake.deps);
  assert.deepEqual(chat.submit(session(fake), leaderTarget, "leader 消息"), { kind: "queued", pending: 1 });
  assert.equal(fake.steers.length, 1, "尝试过 steer 才回退");

  const memberFake = fakeDeps({ running: true, steer: () => true });
  const memberChat = new ChatCoordinator(memberFake.deps);
  assert.deepEqual(
    memberChat.submit(session(memberFake), memberTarget, "成员消息"),
    { kind: "queued", pending: 1 },
  );
  assert.equal(memberFake.steers.length, 0, "成员子进程无 steer 通道，走队列");
});

test("submit：run 未运行时不走 steer，直接派单", () => {
  const fake = fakeDeps({ running: false, steer: () => true });
  const chat = new ChatCoordinator(fake.deps);
  assert.equal(chat.submit(session(fake), leaderTarget, "hello").kind, "started");
  assert.equal(fake.steers.length, 0, "空闲时无插话通道");
});

test("submit：成员目标 — task 指示 leader 转派给该成员", () => {
  const fake = fakeDeps();
  const chat = new ChatCoordinator(fake.deps);
  chat.submit(session(fake), memberTarget, "跑一下测试");
  assert.match(fake.starts[0]?.task ?? "", /frontend/);
  assert.match(fake.starts[0]?.task ?? "", /请转派/);
});

test("ChatMessage 队列条目只存 runId/targetLabel 与 message（不缓存上下文）", () => {
  // 上下文在派出时经 deps.contextTail 现读——用 tail 变化验证。
  let tail = "旧上下文";
  const fake = fakeDeps({ running: true, tail: "占位" });
  const deps = { ...fake.deps, contextTail: (_runId: string, _actor: string): string => tail };
  const chat = new ChatCoordinator(deps);
  chat.submit(session(fake), leaderTarget, "排队消息");
  tail = "新上下文（派出时现读）";
  fake.deps.isRunning = () => false;
  chat.onRunFinalized("run-1", "completed");
  assert.match(fake.starts[0]?.task ?? "", /新上下文（派出时现读）/, "派出时刻才解析上文");
});

// 防止未使用导入告警（类型层面保留 ChatMessage 引用）。
type _Keep = ChatMessage;
