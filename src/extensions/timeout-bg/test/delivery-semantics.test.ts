/**
 * timeout-bg — 完成通知「中途送达」的宿主投递语义（timeout-bg-todo#6）
 *
 * 边界与动机：本插件把结束通知交给宿主 `pi.sendMessage(..., { deliverAs: "steer" })`；
 * 「agent 连着干活时通知不再被压到它收工」这件事完全取决于宿主 agent loop 在哪一点消费队列，
 * 属宿主/进程边界。只断言 `deliverAs` 字面量是纸面正确：宿主哪天挪走消费点，字面量断言照样绿。
 * 所以这里驱动**宿主真实实现**（pi-agent-core 的 `Agent` + pi-ai 的 faux provider：官方给测试用的
 * 假模型流），只把模型输出换成脚本化假流（IO 边界），用真实事件序列证明两种投递的时机差。
 * 标记消息与 `AgentSession.sendCustomMessage` 造的形状一致（role: "custom"）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type, createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** 本插件送的那种消息（形状同 `AgentSession.sendCustomMessage` 里的 appMessage）。 */
function noticeMessage(text: string): AgentMessage {
  return { role: "custom", customType: "timeout-bg", content: text, display: true, timestamp: Date.now() };
}

/** 工具只为了让第 1 轮产生一个「工具批」——通知就在这一批里排队。 */
const probeTool: AgentTool = {
  name: "probe",
  label: "probe",
  description: "test probe",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

interface DeliveryMarks {
  assistantStart: number[];
  assistantEnd: number[];
  noticeStart: number[];
  agentEnd: number[];
}

/**
 * 脚本：第 1 轮出工具调用（工具执行前把标记消息排进队列），第 2 轮出文本（agent 到此本来要停），
 * 第 3 轮备用（followUp 被消费后还会再要一次响应）。事件下标即真实时间序。
 */
async function runScripted(deliver: "steer" | "followUp"): Promise<DeliveryMarks> {
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {})),
    fauxAssistantMessage("second"),
    fauxAssistantMessage("third"),
  ]);
  const events: AgentEvent[] = [];
  const holder: { agent?: Agent } = {};
  let queued = false;
  const agent = new Agent({
    streamFn: faux.stream,
    initialState: { model: faux.getModel(), tools: [probeTool], systemPrompt: "test" },
    beforeToolCall: async () => {
      if (!queued) {
        queued = true;
        const notice = noticeMessage("后台命令已结束");
        if (deliver === "steer") holder.agent!.steer(notice);
        else holder.agent!.followUp(notice);
      }
      return undefined;
    },
  });
  holder.agent = agent;
  agent.subscribe((event) => {
    events.push(event);
  });
  await agent.prompt("start");

  const marks: DeliveryMarks = { assistantStart: [], assistantEnd: [], noticeStart: [], agentEnd: [] };
  events.forEach((event, index) => {
    if (event.type === "message_start" && event.message.role === "assistant") marks.assistantStart.push(index);
    if (event.type === "message_end" && event.message.role === "assistant") marks.assistantEnd.push(index);
    if (event.type === "message_start" && event.message.role === "custom") marks.noticeStart.push(index);
    if (event.type === "agent_end") marks.agentEnd.push(index);
  });
  return marks;
}

test("宿主真实 loop：steer 通知在当前工具批结束时进上下文（不等 agent 收工）", async () => {
  const marks = await runScripted("steer");
  assert.equal(marks.noticeStart.length, 1, "通知被消费（不是留在队列里）");
  assert.ok(marks.assistantStart.length >= 2, "通知不终止本次 run：agent 接着出下一轮");
  assert.ok(
    marks.noticeStart[0]! > marks.assistantStart[0]! && marks.noticeStart[0]! < marks.assistantStart[1]!,
    "通知在第 2 轮助手响应之前注入 —— 第 2 轮请求就带上它",
  );
  assert.equal(marks.agentEnd.length, 1, "run 正常结束");
});

test("宿主真实 loop：followUp 通知要等 agent 本来要停（改动前的旧行为，作为对照）", async () => {
  const marks = await runScripted("followUp");
  assert.ok(marks.assistantEnd.length >= 2, "对照组同样跑到第 2 轮");
  assert.ok(
    marks.noticeStart[0]! > marks.assistantEnd[1]!,
    "followUp 通知排在第 2 轮助手响应结束之后 —— 连着干活的会话里等于一直不送",
  );
  assert.equal(marks.agentEnd.length, 1, "run 正常结束");
});
