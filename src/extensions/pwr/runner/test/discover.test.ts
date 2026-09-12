/**
 * Agent discovery tests (JHL-14): user/project scopes, frontmatter
 * parsing, precedence, and builtin default fallback.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { after, before } from "node:test";
import { discoverAgents, discoverAgentsFrom, findAgent } from "../discover.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-discover-test-"));
const userDir = path.join(tmpRoot, "pi-agent", "agents");
const projDir = path.join(tmpRoot, "project", ".pi", "agents");

before(() => {
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projDir, { recursive: true });
	fs.writeFileSync(
		path.join(userDir, "custom-user.md"),
		"---\nname: custom-user\ndescription: only user\ntools: read, grep\n---\nuser custom",
		"utf-8",
	);
	// same-name definition in BOTH scopes: precedence must be user > project
	fs.writeFileSync(
		path.join(userDir, "shared.md"),
		"---\nname: shared\ndescription: user shared\n---\nuser shared prompt",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(projDir, "shared.md"),
		"---\nname: shared\ndescription: project shared\n---\nproject shared prompt",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(projDir, "scout.md"),
		"---\nname: scout\ndescription: project scout override\n---\nproject scout prompt",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(projDir, "custom-project.md"),
		"---\nname: custom-project\ndescription: only project\n---\nproject custom",
		"utf-8",
	);
	// malformed file (no frontmatter name) must be skipped
	fs.writeFileSync(path.join(userDir, "broken.md"), "no frontmatter at all", "utf-8");
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("user scope: loads user agents, ignores project, fills builtins", () => {
	const agents = discoverAgentsFrom({ cwd: path.join(tmpRoot, "project"), scope: "user", userDir });
	const names = agents.map((a) => a.name);
	assert.ok(names.includes("custom-user"), "user agent loaded");
	assert.ok(!names.includes("custom-project"), "project agent excluded in user scope");
	assert.ok(!names.includes("broken"), "malformed file skipped");
	assert.ok(names.includes("scout"), "builtin scout present");
	assert.ok(names.includes("planner"));
	assert.ok(names.includes("reviewer"));
	assert.ok(names.includes("worker"));
	const scout = findAgent(agents, "scout")!;
	assert.equal(scout.source, "builtin", "builtin fills the gap when user scope has no scout");
});

test("project scope: loads project agents only, builtins fill gaps", () => {
	const agents = discoverAgentsFrom({ cwd: path.join(tmpRoot, "project"), scope: "project", userDir });
	const names = agents.map((a) => a.name);
	assert.ok(names.includes("custom-project"));
	assert.ok(names.includes("scout"));
	assert.equal(findAgent(agents, "scout")!.source, "project", "project scout overrides builtin");
	assert.ok(!names.includes("custom-user"), "user agent excluded in project scope");
});

test("both scope: precedence user > project > builtin (user wins same-name)", () => {
	const agents = discoverAgentsFrom({ cwd: path.join(tmpRoot, "project"), scope: "both", userDir });
	const names = agents.map((a) => a.name);
	assert.ok(names.includes("custom-user"));
	assert.ok(names.includes("custom-project"));
	const scout = findAgent(agents, "scout")!;
	assert.equal(scout.source, "project", "project-only scout still beats the builtin default");
	assert.equal(scout.systemPrompt, "project scout prompt");
	// same-name definition in BOTH scopes: the USER definition must win
	const shared = findAgent(agents, "shared")!;
	assert.equal(shared.source, "user", "user definition must win over the same-name project definition");
	assert.equal(shared.systemPrompt, "user shared prompt");
});

test("no project dir: project scope falls back to builtins only", () => {
	const agents = discoverAgentsFrom({ cwd: tmpRoot, scope: "both", userDir });
	const names = agents.map((a) => a.name);
	assert.ok(!names.includes("custom-project"));
	assert.ok(names.includes("scout"));
	assert.equal(findAgent(agents, "scout")!.source, "builtin");
});

test("builtin agent: scout definition has tools/model/systemPrompt", () => {
	// Hermetic: empty user dir so the builtin definition is returned even
	// when the real ~/.pi/agent/agents contains a user-scope scout.
	const agents = discoverAgentsFrom({ cwd: tmpRoot, scope: "user", userDir: path.join(tmpRoot, "empty-agents") });
	const scout = findAgent(agents, "scout");
	assert.ok(scout);
	assert.equal(scout.source, "builtin");
	assert.ok(Array.isArray(scout.tools) && scout.tools.length > 0);
	assert.ok(scout.model);
	assert.ok(scout.systemPrompt.length > 50);
	assert.ok(scout.description.length > 0);
});

test("unknown agent: findAgent returns undefined", () => {
	const agents = discoverAgents(process.cwd(), "user");
	assert.equal(findAgent(agents, "definitely-not-an-agent"), undefined);
});
