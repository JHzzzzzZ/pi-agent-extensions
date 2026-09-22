/**
 * config.ts 单测：默认超时解析与 timeout 校验（timeout-bg-todo#1）
 *
 * 边界：纯函数（零 IO、零进程），不接真实 spawn/fs。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMEOUT_ENV, DEFAULT_TIMEOUT_SECONDS, resolveDefaultTimeout, resolveTimeoutMs } from "../config.ts";

test("未设置环境变量 → 默认 300 秒", () => {
  const r = resolveDefaultTimeout({});
  assert.equal(r.seconds, DEFAULT_TIMEOUT_SECONDS);
  assert.equal(r.warning, null);
});

test("PI_TIMEOUT_BG_DEFAULT=0 → 关闭默认超时（不施加）", () => {
  const r = resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: "0" });
  assert.equal(r.seconds, undefined);
  assert.equal(r.warning, null);
});

test("合法正数（含小数、前后空白）→ 原样生效", () => {
  assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: "600" }).seconds, 600);
  assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: "12.5" }).seconds, 12.5);
  assert.equal(resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: " 90 " }).seconds, 90);
});

test("非法值 → 回退默认值 + 静态警告（不静默）", () => {
  for (const raw of ["abc", "-5", "", "   ", "Infinity", "NaN"]) {
    const r = resolveDefaultTimeout({ [DEFAULT_TIMEOUT_ENV]: raw });
    assert.equal(r.seconds, DEFAULT_TIMEOUT_SECONDS, `raw=${JSON.stringify(raw)}`);
    assert.ok(r.warning !== null && r.warning.includes(DEFAULT_TIMEOUT_ENV), `raw=${JSON.stringify(raw)}`);
  }
});

test("resolveTimeoutMs：显式优先 > 默认；两者都无 → undefined（不施加超时）", () => {
  assert.equal(resolveTimeoutMs(undefined, 300), 300_000);
  assert.equal(resolveTimeoutMs(5, 300), 5_000);
  assert.equal(resolveTimeoutMs(5, undefined), 5_000);
  assert.equal(resolveTimeoutMs(undefined, undefined), undefined);
});

test("resolveTimeoutMs：非法显式值 fail-closed（沿用宿主文案）", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveTimeoutMs(bad, 300), /Invalid timeout: must be a finite number of seconds/, `bad=${bad}`);
  }
  assert.throws(() => resolveTimeoutMs(2_147_484, 300), /Invalid timeout: maximum is 2147483\.647 seconds/);
});
