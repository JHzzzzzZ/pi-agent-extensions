/**
 * PWR PiAgentRunner — agent discovery (JHL-14)
 *
 * Discovers agent definitions from the same locations the local `subagent`
 * extension uses (PRD §5.4: "复用本机 subagent 的 agent 定义"):
 *   - user scope:   ~/.pi/agent/agents/*.md          (public pi-coding-agent API)
 *   - project scope: <cwd-up>/.pi/agents/*.md         (CONFIG_DIR_NAME)
 *
 * PWR bundles the four P0 default agent definitions (scout / planner /
 * reviewer / worker) as builtin fallbacks so the defaults work even when
 * the user has not symlinked any agent files. Discovery precedence:
 * user > project > builtin. This module is PWR-owned: it uses only the
 * public @earendil-works/pi-coding-agent API and never imports subagent
 * extension code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

export type AgentScope = "user" | "project" | "both";

function loadAgentsFromDir(dir: string, source: AgentDefinition["source"]): AgentDefinition[] {
	const agents: AgentDefinition[] = [];
	if (!dir || !fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Builtin P0 default agents (PRD §5.4). Same definition format and content
 * as the pi repo's subagent sample agents, bundled so discovery always
 * yields the four defaults even before the user installs agent files.
 */
const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "scout",
		description: "Fast codebase recon that returns compressed context for handoff to other agents",
		tools: ["read", "grep", "find", "ls", "bash"],
		model: "claude-haiku-4-5",
		systemPrompt: [
			"You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.",
			"",
			"Your output will be passed to an agent who has NOT seen the files you explored.",
			"",
			"Thoroughness (infer from task, default medium):",
			"- Quick: Targeted lookups, key files only",
			"- Medium: Follow imports, read critical sections",
			"- Thorough: Trace all dependencies, check tests/types",
			"",
			"Strategy:",
			"1. grep/find to locate relevant code",
			"2. Read key sections (not entire files)",
			"3. Identify types, interfaces, key functions",
			"4. Note dependencies between files",
			"",
			"Output format:",
			"",
			"## Files Retrieved",
			"List with exact line ranges:",
			"1. `path/to/file.ts` (lines 10-50) - Description of what's here",
			"",
			"## Key Code",
			"Critical types, interfaces, or functions:",
			"",
			"```typescript",
			"interface Example {",
			"  // actual code from the files",
			"}",
			"```",
			"",
			"## Architecture",
			"Brief explanation of how the pieces connect.",
			"",
			"## Start Here",
			"Which file to look at first and why.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "planner",
		description: "Creates implementation plans from context and requirements",
		tools: ["read", "grep", "find", "ls"],
		model: "claude-sonnet-4-5",
		systemPrompt: [
			"You are a planning specialist. You receive context (from a scout) and requirements, then produce a clear implementation plan.",
			"",
			"You must NOT make any changes. Only read, analyze, and plan.",
			"",
			"Input format you'll receive:",
			"- Context/findings from a scout agent",
			"- Original query or requirements",
			"",
			"Output format:",
			"",
			"## Goal",
			"One sentence summary of what needs to be done.",
			"",
			"## Plan",
			"Numbered steps, each small and actionable:",
			"1. Step one - specific file/function to modify",
			"2. Step two - what to add/change",
			"",
			"## Files to Modify",
			"- `path/to/file.ts` - what changes",
			"",
			"## New Files (if any)",
			"- `path/to/new.ts` - purpose",
			"",
			"## Risks",
			"Anything to watch out for.",
			"",
			"Keep the plan concrete. The worker agent will execute it verbatim.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "reviewer",
		description: "Code review specialist for quality and security analysis",
		tools: ["read", "grep", "find", "ls", "bash"],
		model: "claude-sonnet-4-5",
		systemPrompt: [
			"You are a senior code reviewer. Analyze code for quality, security, and maintainability.",
			"",
			"Bash is for read-only commands only: `git diff`, `git log`, `git show`. Do NOT modify files or run builds.",
			"Assume tool permissions are not perfectly enforceable; keep all bash usage strictly read-only.",
			"",
			"Strategy:",
			"1. Run `git diff` to see recent changes (if applicable)",
			"2. Read the modified files",
			"3. Check for bugs, security issues, code smells",
			"",
			"Output format:",
			"",
			"## Files Reviewed",
			"- `path/to/file.ts` (lines X-Y)",
			"",
			"## Critical (must fix)",
			"- `file.ts:42` - Issue description",
			"",
			"## Warnings (should fix)",
			"- `file.ts:100` - Issue description",
			"",
			"## Suggestions (consider)",
			"- `file.ts:150` - Improvement idea",
			"",
			"## Summary",
			"Overall assessment in 2-3 sentences.",
			"",
			"Be specific with file paths and line numbers.",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "worker",
		description: "General-purpose subagent with full capabilities, isolated context",
		model: "claude-sonnet-4-5",
		systemPrompt: [
			"You are a worker agent with full capabilities. You operate in an isolated context window to handle delegated tasks without polluting the main conversation.",
			"",
			"Work autonomously to complete the assigned task. Use all available tools as needed.",
			"",
			"Output format when finished:",
			"",
			"## Completed",
			"What was done.",
			"",
			"## Files Changed",
			"- `path/to/file.ts` - what changed",
			"",
			"## Notes (if any)",
			"Anything the main agent should know.",
			"",
			"If handing off to another agent (e.g. reviewer), include:",
			"- Exact file paths changed",
			"- Key functions/types touched (short list)",
		].join("\n"),
		source: "builtin",
		filePath: "<builtin>",
	},
];

export function discoverAgents(cwd: string, scope: AgentScope): AgentDefinition[] {
	return discoverAgentsFrom({ cwd, scope, userDir: path.join(getAgentDir(), "agents") });
}

/**
 * Discovery core with injectable user dir (tests). The real entry point is
 * `discoverAgents`; this stays internal.
 */
export function discoverAgentsFrom(options: {
	cwd: string;
	scope: AgentScope;
	userDir: string;
}): AgentDefinition[] {
	const { cwd, scope, userDir } = options;
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const byName = new Map<string, AgentDefinition>();
	if (scope === "both") {
		// Precedence: user > project > builtin. Write project FIRST so a
		// same-name user definition overwrites it (user wins).
		for (const agent of projectAgents) byName.set(agent.name, agent);
		for (const agent of userAgents) byName.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) byName.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) byName.set(agent.name, agent);
	}
	// Builtin defaults fill gaps only (user/project definitions win).
	for (const agent of BUILTIN_AGENTS) {
		if (!byName.has(agent.name)) byName.set(agent.name, agent);
	}
	return Array.from(byName.values());
}

export function findAgent(agents: AgentDefinition[], agentId: string): AgentDefinition | undefined {
	return agents.find((a) => a.name === agentId);
}

export function formatAgentList(agents: AgentDefinition[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
}

export function defaultCwd(): string {
	return process.cwd();
}

export function agentDirPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "agents");
}
