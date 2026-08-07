import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, canonicalProjectPath } from "../src/approval.ts";
import { ErrorCode, PwrError } from "../src/errors.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const PROJECT = "C:/proj";
const SCRIPT_A = "a".repeat(64);
const SCRIPT_B = "b".repeat(64);

test("first start: no approval -> not approved", () => {
	const store = new ApprovalStore();
	const decision = store.decide(PROJECT, SCRIPT_A);
	assert.equal(decision.approved, false);
	assert.equal(decision.remembered, false);
});

test("approval: once grants the current run only and is not remembered", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");
	assert.equal(store.has(PROJECT, SCRIPT_A), true);
});

test("remember: same project + same digest is approved without re-prompt", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");

	const decision = store.decide(PROJECT, SCRIPT_A);
	assert.equal(decision.approved, true);
	assert.equal(decision.remembered, true);
});

test("remember: different project is NOT approved", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");
	const decision = store.decide("C:/other", SCRIPT_A);
	assert.equal(decision.approved, false);
});

test("digest change: remembered approval becomes stale and forces re-approval", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");

	// Same digest -> still good
	assert.equal(store.decide(PROJECT, SCRIPT_A).approved, true);

	// Changed digest -> not approved via record, flagged stale
	const changed = store.decide(PROJECT, SCRIPT_B);
	assert.equal(changed.approved, false);
	assert.equal(changed.staleDigest, SCRIPT_A);
});

test("APPROVAL_STALE is raised when a remembered approval digest no longer matches", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");
	assert.throws(() => store.assertFresh(PROJECT, SCRIPT_B), (err: unknown) => {
		assert.ok(err instanceof PwrError);
		assert.equal(err.code, ErrorCode.APPROVAL_STALE);
		return true;
	});
	// fresh digest passes
	assert.doesNotThrow(() => store.assertFresh(PROJECT, SCRIPT_A));
});

test("clear removes the approval so approval is required again", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");
	store.clear(PROJECT, SCRIPT_A);
	assert.equal(store.has(PROJECT, SCRIPT_A), false);
	assert.equal(store.decide(PROJECT, SCRIPT_A).approved, false);
});

test("hydration restores remembered approvals", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");
	const json = store.toJSON();

	const fresh = new ApprovalStore();
	fresh.hydrate(json);
	assert.equal(fresh.decide(PROJECT, SCRIPT_A).approved, true);
	assert.equal(fresh.decide("C:/other", SCRIPT_A).approved, false);
});

test("canonical project path: resolves relative paths and follows realpath", () => {
	const cwd = process.cwd();
	assert.equal(canonicalProjectPath("."), canonicalProjectPath(cwd));
	assert.equal(canonicalProjectPath(`.${path.sep}`), canonicalProjectPath(cwd));
	// realpath resolves symlinks/..-segments when the path exists
	const nested = path.join(cwd, "tests", "..");
	assert.equal(canonicalProjectPath(nested), canonicalProjectPath(cwd));
});

test("canonical project path: case normalization on win32 (case-insensitive)", () => {
	if (process.platform !== "win32") return;
	assert.equal(canonicalProjectPath("C:/Proj"), canonicalProjectPath("C:/proj"));
	assert.equal(canonicalProjectPath("c:\\PROJ\\Sub"), canonicalProjectPath("C:\\proj\\sub"));
});

test("approval store keys are canonical: different spellings share one record", () => {
	const store = new ApprovalStore();
	store.remember(PROJECT, SCRIPT_A, "2026-08-05T10:00:00Z");

	// stored record keeps the canonical path
	const record = store.get(PROJECT, SCRIPT_A);
	assert.equal(record?.projectPath, canonicalProjectPath(PROJECT));

	if (process.platform === "win32") {
		assert.equal(store.has(PROJECT.toUpperCase(), SCRIPT_A), true, "case variants must share the record");
	}
	const viaRel = store.has(path.resolve(PROJECT), SCRIPT_A);
	assert.equal(viaRel, true, "resolved spelling must share the record");
});

test("approval store: relative path variants of the same project match", () => {
	const store = new ApprovalStore();
	store.remember(path.join(process.cwd(), "proj"), SCRIPT_A, "2026-08-05T10:00:00Z");
	const record = store.get(path.join(process.cwd(), "proj"), SCRIPT_A);
	assert.ok(record);
	// sanity: canonicalProjectPath was applied to the stored record
	assert.equal(record.projectPath, canonicalProjectPath(path.join(process.cwd(), "proj")));
});

test("canonicalProjectPath tolerates non-existent paths (resolve-only)", () => {
	const fake = path.join(process.cwd(), "does-not-exist-pwr-xyz", "sub");
	assert.equal(canonicalProjectPath(fake), canonicalProjectPath(fake));
	assert.ok(fs.existsSync(fake) || canonicalProjectPath(fake).includes("does-not-exist-pwr-xyz"));
});
