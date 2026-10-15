/**
 * loop — 到期任务「中途送达」的宿主投递语义（loop-todo#12）
 *
 * 边界与动机：本插件把到期任务交给宿主 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`；
 * 「agent 连着干活时任务不再被压到它收工」这件事完全取决于宿主 agent loop 在哪一点消费队列，
 * 属宿主/进程边界。只断言 `deliverAs` 字面量是纸面正确：宿主哪天挪走消费点，字面量断言照样绿。
 * 所以这里驱动**宿主真实实现**：pi-agent-core 的 `Agent`（真队列 + 真 loop）、pi-coding-agent 的
 * `convertToLlm`（真转换：custom → user，模型真能看见任务文本）、pi-ai 的 faux provider（官方测试用假模型流）。
 * 两层断言：① 事件时序（任务在哪儿注入 transcript）；② 请求载荷（模型在第几次请求真看到它）。
 * 只把模型输出换成脚本化假流（IO 边界）。
 *
 * 未锁的一层（读码核实，非测试）：`AgentSession.sendCustomMessage` 的 6 行映射——流式中 + `triggerTurn ≠ false`
 * ⇒ `agent.steer`；非流式 + `triggerTurn` ⇒ 起一轮（与 deliverAs 无关）。搭 AgentSession
 * 脚手架（model runtime / session manager / resource loader）成本远超本条改动，故只记录，不假装已锁。
 * 另：`triggerTurn: true` 是 steer 分支的前提（`triggerTurn: false` 在流式中会走「回合末尾追加」的 defer 分支），
 * 这一条由 `index.test.ts` 的字面量断言（`{ triggerTurn: true, deliverAs: "steer" }`）兜住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type, createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

/** 到期任务文本：断言「模型真看到」时按它找（宿主 convertToLlm 会保留 content 文本）。 */
const DUE_TEXT = "喝水提醒";

/** 本插件送的那种消息（形状同 `index.ts` 的 deliver() 与 `AgentSession.sendCustomMessage` 里的 appMessage）。 */
function dueMessage(): AgentMessage {
  return {
    role: "custom",
    customType: "loop-task-due",
    content: `[loop 1] 定时任务触发（独立任务：先收尾手上的工作，再处理本条）\n\n${DUE_TEXT}`,
    display: true,
    timestamp: Date.now(),
  };
}

/** 工具只为了让第 1 轮产生一个「工具批」——任务就在这一批里排队。 */
const probeTool: AgentTool = {
  name: "probe",
  label: "probe",
  description: "test probe",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

interface DeliveryRun {
  /** 事件下标即真实时间序。 */
  marks: { assistantStart: number[]; assistantEnd: number[]; dueStart: number[]; agentEnd: number[] };
  /** 每次 LLM 请求的载荷（经宿主真实 convertToLlm 转换后的消息）——「模型看见了什么」。 */
  requests: string[];
}

/**
 * 脚本：第 1 轮出工具调用（工具执行前把任务消息排进队列），第 2 轮出文本（agent 到此本来要停），
 * 第 3 轮备用（followUp 被消费后还会再要一次响应）。
 */
async function runScripted(deliver: "steer" | "followUp"): Promise<DeliveryRun> {
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {})),
    fauxAssistantMessage("second"),
    fauxAssistantMessage("third"),
  ]);
  const events: AgentEvent[] = [];
  const requests: string[] = [];
  const holder: { agent?: Agent } = {};
  let queued = false;
  const agent = new Agent({
    // 宿主真品：默认的 `defaultConvertToLlm` 会丢 custom 消息，这里要的是生产链路的转换。
    convertToLlm,
    streamFn: (model, context, options) => {
      requests.push(JSON.stringify(context.messages));
      return faux.stream(model, context, options);
    },
    initialState: { model: faux.getModel(), tools: [probeTool], systemPrompt: "test" },
    beforeToolCall: async () => {
      if (!queued) {
        queued = true;
        if (deliver === "steer") holder.agent!.steer(dueMessage());
        else holder.agent!.followUp(dueMessage());
      }
      return undefined;
    },
  });
  holder.agent = agent;
  agent.subscribe((event) => {
    events.push(event);
  });
  await agent.prompt("start");

  const marks: DeliveryRun["marks"] = { assistantStart: [], assistantEnd: [], dueStart: [], agentEnd: [] };
  events.forEach((event, index) => {
    if (event.type === "message_start" && event.message.role === "assistant") marks.assistantStart.push(index);
    if (event.type === "message_end" && event.message.role === "assistant") marks.assistantEnd.push(index);
    if (event.type === "message_start" && event.message.role === "custom") marks.dueStart.push(index);
    if (event.type === "agent_end") marks.agentEnd.push(index);
  });
  return { marks, requests };
}

/** 第 n 次 LLM 请求（0 起）的载荷里有没有任务文本。 */
function dueInRequest(requests: string[], n: number): boolean {
  const payload = requests[n];
  assert.ok(payload !== undefined, `第 ${n + 1} 次请求存在`);
  return payload.includes(DUE_TEXT);
}

describe("宿主投递语义：到期任务在忙碌会话里的送达时机", () => {
  it("steer：任务在当前工具批结束时进上下文，模型在下一轮请求就看见它", async () => {
    const { marks, requests } = await runScripted("steer");
    assert.equal(marks.dueStart.length, 1, "任务被消费（不是留在队列里）");
    assert.ok(marks.assistantStart.length >= 2, "任务不终止本次 run：agent 接着出下一轮");
    assert.ok(
      marks.dueStart[0]! > marks.assistantStart[0]! && marks.dueStart[0]! < marks.assistantStart[1]!,
      "任务在第 2 轮助手响应之前注入 transcript",
    );
    assert.ok(dueInRequest(requests, 1), "第 2 次请求的载荷里带着任务（宿主 convertToLlm: custom → user）");
    assert.equal(marks.agentEnd.length, 1, "run 正常结束");
  });

  it("followUp：任务要等 agent 本来要停（改动前的旧行为，作为对照）", async () => {
    const { marks, requests } = await runScripted("followUp");
    assert.equal(marks.dueStart.length, 1, "任务最终也被消费（不是丢消息）");
    assert.ok(marks.assistantEnd.length >= 2, "对照组同样跑到第 2 轮");
    assert.ok(
      marks.dueStart[0]! > marks.assistantEnd[1]!,
      "followUp 任务排在第 2 轮助手响应结束之后 —— 连着干活的会话里等于一直不送",
    );
    assert.ok(!dueInRequest(requests, 1), "第 2 次请求里还没有它（这正是被改掉的旧行为）");
    assert.ok(dueInRequest(requests, 2), "要到第 3 次请求才带上");
    assert.equal(marks.agentEnd.length, 1, "run 正常结束");
  });
});
