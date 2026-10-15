/*
 * params.ts 单测：`run_in_background` 的读取/剥离/描述注入/分派（timeout-bg-todo#5）
 *
 * 边界与动机：这层是「模型参数 → 哪份工具定义」的唯一翻译点，风险在**误判**（把畸形值
 * 当后台、把 true 漏成超时模式）与**泄漏**（我们自己的参数透传给宿主内置定义）。
 * 纯函数，零 IO、零进程；宿主工具定义用最小结构替身（真接线在 index.test.ts 验）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  RUN_IN_BACKGROUND_PARAM,
  createRunInBackgroundDispatch,
  requestsRunInBackground,
  stripRunInBackground,
  withOwnParamDescriptions,
} from "../params.ts";

test("requestsRunInBackground：只有严格 true 算数（畸形值 fail-safe 回既有语义）", () => {
  assert.equal(requestsRunInBackground({ run_in_background: true }), true);
  for (const value of [false, "true", 1, null, undefined, 0, {}]) {
    assert.equal(requestsRunInBackground({ run_in_background: value }), false, `不得当作后台：${JSON.stringify(value)}`);
  }
  assert.equal(requestsRunInBackground({ command: "echo hi" }), false);
  assert.equal(requestsRunInBackground(null), false);
  assert.equal(requestsRunInBackground("params"), false);
});

test("stripRunInBackground：剥掉本参数、保留其余，且不改原对象", () => {
  const params = { command: "echo hi", timeout: 30, [RUN_IN_BACKGROUND_PARAM]: true };
  const stripped = stripRunInBackground(params);
  assert.deepEqual(stripped, { command: "echo hi", timeout: 30 });
  assert.equal(params[RUN_IN_BACKGROUND_PARAM], true, "原对象不得被改（分派给远端时还要用）");
  assert.deepEqual(stripRunInBackground({ command: "x" }), { command: "x" });
});

test("withOwnParamDescriptions：注入 run_in_background 并改写宿主那句 no default timeout", () => {
  const parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
    },
  };
  const next = withOwnParamDescriptions(parameters, 300) as { properties: Record<string, { type?: string; description?: string }> };
  assert.equal(next.properties[RUN_IN_BACKGROUND_PARAM]?.type, "boolean");
  assert.match(next.properties[RUN_IN_BACKGROUND_PARAM]?.description ?? "", /background/i);
  assert.equal(next.properties.timeout?.description, "Timeout in seconds (optional, default 300s when omitted). On timeout the command is moved to the background instead of being killed. Ignored when run_in_background is true.");
  assert.equal(next.properties.command?.description, "Shell command to execute", "其余属性原样保留");

  // 形状不可辨识时原样返回：不为一个注入把工具注册搞崩。
  assert.equal(withOwnParamDescriptions(null, 300), null);
  assert.deepEqual(withOwnParamDescriptions({ type: "object" }, 300), { type: "object" });
  const noTimeout = withOwnParamDescriptions({ type: "object", properties: {} }, undefined) as { properties: Record<string, unknown> };
  assert.ok(RUN_IN_BACKGROUND_PARAM in noTimeout.properties);
});

test("createRunInBackgroundDispatch：true 走后台定义、其余走超时定义，且两边都拿到剥掉本参数的 params", async () => {
  const seen: Array<{ kind: string; params: unknown }> = [];
  /** 分派只关心「选了哪份定义、给了什么 params」：ctx 不在测试范围（宿主交互）。 */
  const ctx = undefined as unknown as ExtensionToolContext;
  const record = (kind: string): ToolDefinition["execute"] =>
    (async (_id: string, params: unknown) => {
      seen.push({ kind, params });
      return { content: [] };
    }) as unknown as ToolDefinition["execute"];
  const dispatch = createRunInBackgroundDispatch({ timeout: record("timeout"), background: record("background") });

  await dispatch("call-1", { command: "echo hi", run_in_background: true }, undefined, undefined, ctx);
  await dispatch("call-2", { command: "echo hi" }, undefined, undefined, ctx);
  await dispatch("call-3", { command: "echo hi", run_in_background: false }, undefined, undefined, ctx);

  assert.deepEqual(seen, [
    { kind: "background", params: { command: "echo hi" } },
    { kind: "timeout", params: { command: "echo hi" } },
    { kind: "timeout", params: { command: "echo hi" } },
  ]);
});
