import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode, PwrError, errorResult } from "../src/errors.ts";
import { computeDigest } from "../src/digest.ts";
import { truncateSummary } from "../src/notify.ts";

test("error results carry code + message and never source content", () => {
	const result = errorResult(ErrorCode.APPROVAL_STALE, { runId: "r1", stageId: "s1", taskId: "t1" });
	assert.equal(result.code, "APPROVAL_STALE");
	assert.equal(result.runId, "r1");
	assert.equal(result.stageId, "s1");
	assert.equal(result.taskId, "t1");
	assert.ok(!result.message.includes("secret"));
});

test("PwrError -> toResult includes context", () => {
	const err = new PwrError(ErrorCode.RUN_NOT_FOUND, { runId: "abc" });
	const result = err.toResult();
	assert.equal(result.code, "RUN_NOT_FOUND");
	assert.equal(result.runId, "abc");
});

test("error messages are static templates (no source embedding)", () => {
	const err = new PwrError(ErrorCode.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(err.message, "Script uses syntax or APIs forbidden by the PWR sandbox.");
});

test("digest is stable for identical sources and changes on edits", () => {
	const a = "export const meta = { name: 'x' };";
	const b = "export const meta = { name: 'y' };";
	assert.equal(computeDigest(a), computeDigest(a));
	assert.notEqual(computeDigest(a), computeDigest(b));
});

test("digest normalizes CRLF vs LF", () => {
	assert.equal(computeDigest("a\nb"), computeDigest("a\r\nb"));
});

test("summary truncation respects the size cap", () => {
	const big = "x".repeat(20 * 1024);
	const out = truncateSummary(big);
	assert.ok(Buffer.byteLength(out, "utf8") <= 8 * 1024 + 64);
	assert.ok(out.endsWith("[Summary truncated.]"));
});
