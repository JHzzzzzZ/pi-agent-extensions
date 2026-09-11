/**
 * 模型口径归一纯函数单测：锁定 viewer「模型:」行与 /team:status 的
 * `provider/id` 展示规则。两个事实源——团队文件声明值（含 provider
 * 前缀）与子进程 message_end 实际上报值（pi 上报裸 id）——在这里组合；
 * runner.ts 的原始上报数据不变（事实源），归一只发生在展示/装配层。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelCaliber } from "../model-caliber.ts";

test("declared provider prefix + bare actual id → declared provider + actual id", () => {
  assert.equal(
    resolveModelCaliber("opencode-go/deepseek-flash", "deepseek-flash"),
    "opencode-go/deepseek-flash",
    "actual id equals the declared segment: composed caliber matches the declaration",
  );
});

test("actual id segment wins over the declared segment (runtime picked another model)", () => {
  assert.equal(
    resolveModelCaliber("opencode-go/deepseek-flash", "deepseek-v3"),
    "opencode-go/deepseek-v3",
    "provider prefix comes from the declaration, id segment from the child report",
  );
});

test("actual with its own provider prefix is used as-is (no double composition)", () => {
  assert.equal(
    resolveModelCaliber("chatanywhere/gpt-5.6", "anthropic/claude-sonnet-4-5"),
    "anthropic/claude-sonnet-4-5",
    "a fully-qualified actual value replaces the declared caliber entirely",
  );
});

test("no declared value → actual as-is (bare stays bare, no invented prefix)", () => {
  assert.equal(resolveModelCaliber(undefined, "deepseek-flash"), "deepseek-flash");
  assert.equal(resolveModelCaliber("", "deepseek-flash"), "deepseek-flash", "empty declaration counts as absent");
});

test("no actual value → declared as-is", () => {
  assert.equal(resolveModelCaliber("opencode-go/deepseek-flash", undefined), "opencode-go/deepseek-flash");
  assert.equal(resolveModelCaliber("opencode-go/deepseek-flash", ""), "opencode-go/deepseek-flash");
});

test("neither value → undefined (renderer keeps the （默认） fallback)", () => {
  assert.equal(resolveModelCaliber(undefined, undefined), undefined);
  assert.equal(resolveModelCaliber("", ""), undefined);
});

test("declared without a provider prefix cannot be composed → actual wins (fact over intent)", () => {
  assert.equal(
    resolveModelCaliber("deepseek-flash", "deepseek-v3"),
    "deepseek-v3",
    "no provider prefix to combine with; keep the reported value instead of inventing one",
  );
});
