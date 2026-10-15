/**
 * btw 上下文组装单测（纯函数边界）。
 *
 * 被测对象就是「条目 → 侧模型看到的文本」这一层：宿主条目用最小结构对象构造
 * （只提供被测代码读取的字段），预算/截断/省略标注是断言核心。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextText, type TranscriptEntry } from "../context.ts";
import { MAX_TOOL_ARGS_CHARS, MAX_TOOL_RESULT_CHARS } from "../spec.ts";

function user(text: string): TranscriptEntry {
  return { type: "message", message: { role: "user", content: text } };
}
function assistantText(text: string): TranscriptEntry {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}
function assistantToolCall(name: string, args: unknown): TranscriptEntry {
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
}
function toolResult(toolName: string, text: string): TranscriptEntry {
  return { type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }] } };
}

test("三种角色都带角色标记，且按时间顺序（旧 → 新）拼接", () => {
  const context = buildContextText([
    user("帮我修 bug"),
    assistantText("好的，先看代码"),
    toolResult("read", "file contents"),
  ]);
  assert.equal(context.included, 3);
  assert.equal(context.omitted, 0);
  assert.match(context.text, /\[用户\] 帮我修 bug/);
  assert.match(context.text, /\[助手\] 好的，先看代码/);
  assert.match(context.text, /\[工具结果\] read file contents/);
  assert.ok(context.text.indexOf("[用户]") < context.text.indexOf("[助手]"));
  assert.ok(context.text.indexOf("[助手]") < context.text.indexOf("[工具结果]"));
});

test("assistant 的工具调用以 `[工具调用] name(args)` 呈现，参数按上限截断", () => {
  const context = buildContextText([assistantToolCall("write", { path: "a.txt", content: "x".repeat(1000) })]);
  const match = /\[工具调用\] write\((.*)\)$/m.exec(context.text);
  assert.ok(match, "工具调用行必须存在");
  assert.ok(Array.from(match[1]!).length <= MAX_TOOL_ARGS_CHARS, "参数预览受 MAX_TOOL_ARGS_CHARS 约束");
  assert.ok(match[1]!.endsWith("…"), "截断必须带省略号（不静默砍）");
});

test("工具结果按 MAX_TOOL_RESULT_CHARS 截断，不会一口吃光预算", () => {
  const context = buildContextText([toolResult("bash", "y".repeat(MAX_TOOL_RESULT_CHARS * 3))]);
  assert.ok(Array.from(context.text).length < MAX_TOOL_RESULT_CHARS + 100);
  assert.ok(context.text.endsWith("…"));
});

test("空工具结果给 (空结果) 占位", () => {
  const context = buildContextText([toolResult("read", "")]);
  assert.match(context.text, /\[工具结果\] read \(空结果\)/);
});

test("超预算：丢最旧条目、保留最新，并如实标注省略条数", () => {
  const context = buildContextText(
    [user(`最早的消息${"a".repeat(200)}`), assistantText(`中间的消息${"b".repeat(200)}`), user("最新的消息")],
    60,
  );
  assert.ok(context.omitted >= 1);
  assert.match(context.text, /（更早的 \d+ 条已省略）/);
  assert.match(context.text, /最新的消息/);
  assert.ok(!context.text.includes("最早的消息"), "最旧的先丢");
  assert.equal(context.included + context.omitted, 3);
});

test("单块超预算：只留最新块并截到预算（绝不返回超长文本）", () => {
  const context = buildContextText([assistantText("z".repeat(500))], 100);
  assert.equal(context.included, 1);
  assert.ok(Array.from(context.text).length <= 100);
});

test("压缩摘要与分支摘要参与上下文（侧模型知道更早的事）", () => {
  const context = buildContextText([
    { type: "compaction", summary: "之前修了 X" },
    { type: "branch_summary", summary: "另一条分支试过 Y" },
  ]);
  assert.match(context.text, /\[更早对话的压缩摘要\]\n之前修了 X/);
  assert.match(context.text, /\[分支摘要\]\n另一条分支试过 Y/);
});

test("custom_message 参与；custom / model_change / label 等非对话条目不进", () => {
  const context = buildContextText([
    { type: "model_change" },
    { type: "custom" },
    { type: "label" },
    { type: "thinking_level_change" },
    { type: "custom_message", content: "继续推进" },
  ]);
  assert.equal(context.included, 1);
  assert.match(context.text, /\[扩展消息\] 继续推进/);
});

test("bashExecution 呈现命令 + exit code + 截断输出", () => {
  const context = buildContextText([
    { type: "message", message: { role: "bashExecution", command: "npm test", output: "all green", exitCode: 0 } },
  ]);
  assert.match(context.text, /\[命令\] npm test → exit 0\nall green/);
});

test("system 消息不进上下文；空条目集返回空文本", () => {
  assert.equal(buildContextText([]).text, "");
  const context = buildContextText([{ type: "message", message: { role: "system", content: "base prompt" } }]);
  assert.equal(context.text, "");
  assert.equal(context.included, 0);
});

test("图片块折叠为 [图片]，文本块照常", () => {
  const context = buildContextText([
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张" },
          { type: "image" },
        ],
      },
    },
  ]);
  assert.match(context.text, /\[用户\] 看这张\n\[图片\]/);
});

test("assistant 的 thinking 块不进入上下文（只取 text 与 toolCall）", () => {
  const context = buildContextText([
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "对外结论" }] } },
  ]);
  assert.ok(!context.text.includes("内部推理"));
  assert.match(context.text, /对外结论/);
});
