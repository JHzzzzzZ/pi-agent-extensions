/**
 * agent-team — 对话线：同一成员多轮追问的前文注入与用量计数
 * （agent-team-todo #4）
 *
 * 真实模块接线：ChatCoordinator + transcript.ts 的真实 JSONL 读写（临时 run
 * 目录），只有 resolveTeam / startRun 是进程边界替身（不派真实子进程）。
 * 锁定三件事：
 * ① 前文注入内容——第 3 轮的任务里能读到第 1 轮的提问与成员答复；
 * ② 注入规模——只取最近 CHAT_DIALOGUE_MAX_ROUNDS 轮，单轮答复按字节截断；
 * ③ 用量计数——每轮用量（run 记录口径）落该轮 run 转录，并在注入头累计；
 *    注入成本随该轮 run 计入既有 run 预算，不新增预算类型。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CHAT_DIALOGUE_ANSWER_BYTES,
  CHAT_DIALOGUE_MAX_ROUNDS,
  ChatCoordinator,
  buildChatTask,
  buildDialogueBlock,
  dialogueAnswerExcerpt,
  transcriptContextTail,
  type ChatSession,
  type ChatTarget,
} from "../chat.ts";
import {
  FileTranscriptSink,
  LEADER_ACTOR,
  readTranscript,
  type TranscriptEntry,
  type TranscriptEntryKind,
} from "../transcript.ts";
import { fixtureTeam } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// 对话线宿主替身：真实 transcript 文件读写，只 fake 进程边界
// ---------------------------------------------------------------------------

interface DialogueHarness {
  chat: ChatCoordinator;
  /** 每次 startRun 的 task（按派单顺序）。 */
  tasks: string[];
  /** 转录根目录（真实 JSONL）。 */
  root: string;
  session: ChatSession;
  /** 模拟该 run 里某个 actor 留下的转录行（真实格式）。 */
  append: (runId: string, actor: string, kind: TranscriptEntryKind, text: string) => void;
  running: (value: boolean) => void;
  cleanup: () => void;
}

function setupDialogue(): DialogueHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-dialogue-"));
  const tasks: string[] = [];
  let running = false;
  const chat = new ChatCoordinator({
    resolveTeam: (name) => ({ ok: true, value: fixtureTeam({ name }) }),
    isRunning: () => running,
    startRun: (_ctx, _team, task) => {
      tasks.push(task);
      return { ok: true, runId: `run-${tasks.length}` };
    },
    contextTail: (runId, actor) => transcriptContextTail(readTranscript(root, runId, actor)),
    roundAnswer: (runId, actor) => dialogueAnswerExcerpt(readTranscript(root, runId, actor)),
    appendEntry: (runId, actor, kind, text) => new FileTranscriptSink(root, runId).append(actor, kind, text),
  });
  return {
    chat,
    tasks,
    root,
    session: { teamName: "dev-team", ctx: undefined, notify: () => {} },
    append: (runId, actor, kind, text) => new FileTranscriptSink(root, runId).append(actor, kind, text),
    running: (value) => {
      running = value;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** 成员目标（actor 与显示名同源，与 viewer 传参一致）。 */
function memberTarget(runId = "run-base"): ChatTarget {
  return { actor: "frontend", label: "frontend", isLeader: false, runId };
}

/** 该 run 的 system 行（按写入顺序）。 */
function systemLines(root: string, runId: string, actor: string = LEADER_ACTOR): string[] {
  return readTranscript(root, runId, actor)
    .filter((e) => e.kind === "system")
    .map((e) => e.text);
}

/** task 里的对话线注入块（截到「最近会话尾部」段之前；无块时返回空串）。 */
function injectedBlock(task: string): string {
  const start = task.indexOf("【对话线前文");
  if (start < 0) return "";
  const rest = task.slice(start);
  const tail = rest.indexOf("\n\n【");
  return tail >= 0 ? rest.slice(0, tail) : rest;
}

// ---------------------------------------------------------------------------
// 前文注入内容：3 轮往返
// ---------------------------------------------------------------------------

test("对话线：第 3 轮注入含第 1 轮的提问与成员答复（真实转录读写）", () => {
  const h = setupDialogue();
  try {
    assert.deepEqual(h.chat.submit(h.session, memberTarget(), "第 3 个文件为什么这么改？"), {
      kind: "started",
      runId: "run-1",
    });
    h.append("run-1", "frontend", "assistant", "因为要保持与旧接口兼容。");
    h.chat.onRunFinalized("run-1", "completed", { cost: 0.01, tokens: 4200 });

    h.chat.submit(h.session, memberTarget(), "那就改成新接口。");
    const task2 = h.tasks[1] ?? "";
    const block2 = injectedBlock(task2);
    assert.match(block2, /【对话线前文·第 2 轮】/);
    assert.match(block2, /已完成 1 轮，本块注入最近 1 轮/);
    assert.match(block2, /第 3 个文件为什么这么改？/);
    assert.match(block2, /因为要保持与旧接口兼容。/);
    assert.match(block2, /原文转派给 frontend/);
    assert.match(block2, /累计用量：\$0\.0100 · 4200 tokens/);

    h.append("run-2", "frontend", "assistant", "已按新接口改好。");
    h.chat.onRunFinalized("run-2", "completed", { cost: 0.02, tokens: 1000 });
    h.chat.submit(h.session, memberTarget(), "再解释一遍第 3 个文件。");

    const block3 = injectedBlock(h.tasks[2] ?? "");
    assert.match(block3, /【对话线前文·第 3 轮】/);
    assert.match(block3, /已完成 2 轮，本块注入最近 2 轮/);
    assert.match(block3, /第 3 个文件为什么这么改？/, "第 1 轮提问仍在第 3 轮注入里");
    assert.match(block3, /因为要保持与旧接口兼容。/, "第 1 轮答复仍在第 3 轮注入里");
    assert.match(block3, /已按新接口改好。/);
    assert.match(block3, /累计用量：\$0\.0300 · 5200 tokens/);
  } finally {
    h.cleanup();
  }
});

test("对话线：注入只取最近 N 轮，更早的轮次不注入", () => {
  const h = setupDialogue();
  try {
    for (let i = 1; i <= CHAT_DIALOGUE_MAX_ROUNDS + 2; i++) {
      h.chat.submit(h.session, memberTarget(), `第 ${i} 轮的提问`);
      h.append(`run-${i}`, "frontend", "assistant", `第 ${i} 轮的答复`);
      h.chat.onRunFinalized(`run-${i}`, "completed", { cost: 0.001, tokens: 10 });
    }
    const last = injectedBlock(h.tasks[h.tasks.length - 1] ?? "");
    assert.match(last, /【对话线前文·第 5 轮】/, "轮号按派单次数续编，不因裁剪回退");
    assert.match(last, /已完成 4 轮，本块注入最近 3 轮/);
    assert.match(last, /第 2 轮的提问/, "最近 N 轮仍在");
    assert.match(last, /第 4 轮的答复/);
    assert.doesNotMatch(last, /第 1 轮的提问/, "更早轮次不再注入");
    assert.doesNotMatch(last, /第 1 轮的答复/);
  } finally {
    h.cleanup();
  }
});

test("对话线：排队追问链式派出时，前一轮答复已收尾（先收尾再派出）", () => {
  const h = setupDialogue();
  try {
    h.running(true);
    // 前一个 run（非对话轮）在跑，第 1 轮进入队列。
    h.chat.submit(h.session, memberTarget("run-base"), "第 1 轮：这个文件为什么这么改？");
    assert.equal(h.tasks.length, 0, "run 在跑，不立即派单");
    h.running(false);
    h.chat.onRunFinalized("run-base", "completed");
    assert.deepEqual(h.tasks.length, 1);
    const round1Run = "run-1";
    h.append(round1Run, "frontend", "assistant", "因为要保持兼容。");

    // 第 1 轮的 run 在跑：第 2 轮排队 —— 链式派出时必须已经看到第 1 轮答复。
    h.running(true);
    h.chat.submit(h.session, memberTarget(round1Run), "第 2 轮：改成新接口。");
    h.running(false);
    h.chat.onRunFinalized(round1Run, "completed", { cost: 0.01, tokens: 100 });

    assert.equal(h.tasks.length, 2, "链式派出第 2 轮");
    const block = injectedBlock(h.tasks[1] ?? "");
    assert.match(block, /【对话线前文·第 2 轮】/);
    assert.match(block, /第 1 轮：这个文件为什么这么改？/);
    assert.match(block, /因为要保持兼容。/, "先收尾上一轮再用它组注入");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 用量计数：每轮落转录 + 注入头累计（预算口径不变）
// ---------------------------------------------------------------------------

test("对话线：每轮用量落该轮 run 转录，并累计进注入头", () => {
  const h = setupDialogue();
  try {
    h.chat.submit(h.session, memberTarget(), "追问一");
    h.append("run-1", "frontend", "assistant", "答复一");
    h.chat.onRunFinalized("run-1", "completed", { cost: 0.0132, tokens: 4200 });
    assert.ok(
      systemLines(h.root, "run-1").includes("第 1 轮完成 · $0.0132 · 4200 tokens"),
      `每轮成本应落该轮 run 转录：${JSON.stringify(systemLines(h.root, "run-1"))}`,
    );

    h.chat.submit(h.session, memberTarget(), "追问二");
    h.chat.onRunFinalized("run-2", "aborted");
    assert.ok(
      systemLines(h.root, "run-2").includes("第 2 轮未完成（aborted）"),
      `未完成的轮同样落结局行：${JSON.stringify(systemLines(h.root, "run-2"))}`,
    );

    h.chat.submit(h.session, memberTarget(), "追问三");
    const task3 = h.tasks[2] ?? "";
    assert.match(injectedBlock(task3), /（该轮无答复产出）/, "未完成的轮不注入答复");
    assert.match(injectedBlock(task3), /累计用量：\$0\.0132 · 4200 tokens/, "未完成轮不累计用量");
  } finally {
    h.cleanup();
  }
});

test("对话线：成果轮的用量按 run 记录口径累计（不新增预算口径）", () => {
  const h = setupDialogue();
  try {
    h.chat.submit(h.session, memberTarget(), "追问一");
    h.append("run-1", "frontend", "assistant", "答复一");
    h.chat.onRunFinalized("run-1", "completed", { cost: 0.5, tokens: 100 });
    h.chat.submit(h.session, memberTarget(), "追问二");
    h.append("run-2", "frontend", "assistant", "答复二");
    h.chat.onRunFinalized("run-2", "completed", { cost: 0.25, tokens: 50 });
    h.chat.submit(h.session, memberTarget(), "追问三");

    const task = h.tasks[2] ?? "";
    assert.match(injectedBlock(task), /累计用量：\$0\.7500 · 150 tokens/, "各轮用量求和（与 run 预算折叠同源）");
    assert.match(injectedBlock(task), /各轮已计入其所在 run 的预算/, "口径说明：不新建预算类型");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 纯函数：答复摘录与注入块措辞
// ---------------------------------------------------------------------------

test("dialogueAnswerExcerpt：取最后一条 assistant、扁平化、按字节截断", () => {
  const entries: TranscriptEntry[] = [
    { kind: "task", text: "追问", ts: "t" },
    { kind: "assistant", text: "第一版答复", ts: "t" },
    { kind: "tool", text: "edit a.ts", ts: "t" },
    { kind: "assistant", text: "最终答复\n带换行", ts: "t" },
  ];
  assert.equal(dialogueAnswerExcerpt(entries), "最终答复 带换行");
  assert.equal(dialogueAnswerExcerpt([{ kind: "task", text: "x", ts: "t" }]), "", "无 assistant 行 → 空摘录");
  const long = dialogueAnswerExcerpt([{ kind: "assistant", text: "长".repeat(5000), ts: "t" }]);
  assert.ok(Buffer.byteLength(long, "utf8") <= CHAT_DIALOGUE_ANSWER_BYTES, "摘录按字节上限截断");
});

test("buildChatTask：leader 目标同样注入前文（措辞为延续对话线）", () => {
  const task = buildChatTask(
    { actor: LEADER_ACTOR, label: "leader", isLeader: true, runId: "run-3" },
    "继续",
    {
      tail: "[assistant] 旧尾部",
      dialogue: [
        { round: 1, user: "第一问", answer: "第一答" },
        { round: 2, user: "第二问", answer: "第二答" },
      ],
      usage: { cost: 0.5, tokens: 100 },
    },
  );
  assert.match(task, /【用户消息】/);
  assert.match(task, /【对话线前文·第 3 轮】/);
  assert.match(task, /延续这条对话线/);
  assert.doesNotMatch(task, /原文转派给/);
  assert.match(task, /第 1 轮/);
  assert.match(task, /第一问/);
  assert.match(task, /第一答/);
  assert.match(task, /leader 最近会话尾部/);
  assert.match(task, /旧尾部/);
});

test("buildDialogueBlock：无前文 → 空串；无用量 → 省略累计行", () => {
  const target: ChatTarget = { actor: "frontend", label: "frontend", isLeader: false, runId: "run-1" };
  assert.equal(buildDialogueBlock(target, []), "");
  const block = buildDialogueBlock(target, [{ round: 1, user: "问", answer: "" }]);
  assert.match(block, /原文转派给 frontend/);
  assert.match(block, /（该轮无答复产出）/);
  assert.doesNotMatch(block, /累计用量/);
});
