/**
 * agent-team — team definition files
 *
 * A team lives in a Markdown file with YAML frontmatter:
 *
 *   ---
 *   name: dev-team
 *   description: 全栈开发小队
 *   leader:
 *     model: anthropic/claude-opus-4-5
 *     prompt: |
 *       你是技术负责人……
 *   members:
 *     - name: frontend
 *       model: chatanywhere/gpt-5.6
 *       prompt: |
 *         你是资深前端工程师……
 *   ---
 *
 * The markdown body under the frontmatter is team-level notes appended to
 * the leader system prompt. Discovery re-scans on every use (no caching) so
 * conversation-created teams and hand edits take effect on the next run.
 * Project scope files override global files on name conflicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  err,
  ok,
  type Result,
  type TeamConfig,
  type TeamErrorCode,
  type TeamMemberConfig,
  TeamErrorCodes,
} from "./types.ts";

const NAME_PATTERN = /^[^\s/\\]+$/;

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

/** Normalizes a `tools` value that may be a comma string or a string list. */
function normalizeTools(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const tools = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (Array.isArray(value)) {
    const tools = value.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}

function invalid(message: string): Result<never> {
  return err(TeamErrorCodes.INVALID_TEAM_FILE, message);
}

/**
 * Validates parsed frontmatter into a TeamConfig. `raw` is the frontmatter
 * object, `body` the markdown notes below it.
 */
export function validateTeam(
  raw: unknown,
  meta: { filePath: string; source: "global" | "project"; body?: string },
): Result<TeamConfig> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("frontmatter must be a YAML mapping");
  }
  const rawMap = raw as Record<string, unknown>;

  if (typeof rawMap.name !== "string" || rawMap.name.trim().length === 0) {
    return invalid("missing required field: name");
  }
  const name = rawMap.name.trim();
  if (!NAME_PATTERN.test(name)) {
    return invalid(`invalid team name "${name}": must not contain whitespace or slashes`);
  }
  const description = typeof rawMap.description === "string" ? rawMap.description.trim() : "";

  // Leader
  const rawLeader = rawMap.leader;
  if (rawLeader === null || typeof rawLeader !== "object" || Array.isArray(rawLeader)) {
    return invalid("missing required mapping: leader");
  }
  const leaderMap = rawLeader as Record<string, unknown>;
  if (typeof leaderMap.prompt !== "string" || leaderMap.prompt.trim().length === 0) {
    return invalid("leader.prompt is required and must not be empty");
  }
  const leaderModel =
    typeof leaderMap.model === "string" && leaderMap.model.trim().length > 0 ? leaderMap.model.trim() : undefined;
  if (leaderModel && /\s/.test(leaderModel)) {
    return invalid(`invalid leader.model "${leaderModel}": must not contain whitespace`);
  }

  // Members
  if (!Array.isArray(rawMap.members) || rawMap.members.length === 0) {
    return invalid("members must be a non-empty YAML list");
  }
  const members: TeamMemberConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawMap.members.length; i++) {
    const rawMember = rawMap.members[i];
    if (rawMember === null || typeof rawMember !== "object" || Array.isArray(rawMember)) {
      return invalid(`members[${i}] must be a mapping`);
    }
    const memberMap = rawMember as Record<string, unknown>;
    if (typeof memberMap.name !== "string" || memberMap.name.trim().length === 0) {
      return invalid(`members[${i}].name is required`);
    }
    const memberName = memberMap.name.trim();
    if (!NAME_PATTERN.test(memberName)) {
      return invalid(`invalid member name "${memberName}": must not contain whitespace or slashes`);
    }
    if (seen.has(memberName)) {
      return invalid(`duplicate member name "${memberName}"`);
    }
    seen.add(memberName);
    if (typeof memberMap.prompt !== "string" || memberMap.prompt.trim().length === 0) {
      return invalid(`members.${memberName}.prompt is required and must not be empty`);
    }
    const model =
      typeof memberMap.model === "string" && memberMap.model.trim().length > 0 ? memberMap.model.trim() : undefined;
    if (model && /\s/.test(model)) {
      return invalid(`invalid members.${memberName}.model "${model}": must not contain whitespace`);
    }
    members.push({
      name: memberName,
      description: typeof memberMap.description === "string" ? memberMap.description.trim() : undefined,
      model,
      tools: normalizeTools(memberMap.tools),
      worktree: memberMap.worktree === true,
      prompt: memberMap.prompt,
    });
  }

  return ok({
    name,
    description,
    leader: {
      model: leaderModel,
      tools: normalizeTools(leaderMap.tools),
      prompt: leaderMap.prompt,
    },
    members,
    notes: meta.body && meta.body.trim().length > 0 ? meta.body : undefined,
    filePath: meta.filePath,
    source: meta.source,
  });
}

/** Parses one team definition file's content. */
export function parseTeamFile(
  content: string,
  meta: { filePath: string; source: "global" | "project" },
): Result<TeamConfig> {
  let parsed: { frontmatter: unknown; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (e) {
    return invalid(`failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateTeam(parsed.frontmatter, { ...meta, body: parsed.body });
}

// ---------------------------------------------------------------------------
// Discovery (fresh scan on every call — no caching, by design)
// ---------------------------------------------------------------------------

export function globalTeamsDir(): string {
  return path.join(getAgentDir(), "teams");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest `<cwd-up>/.pi/teams` directory (same walk as pwr agent discovery). */
export function findNearestProjectTeamsDir(cwd: string): string | null {
  let currentDir = cwd;
  for (;;) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "teams");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export interface TeamFileError {
  file: string;
  message: string;
}

export interface DiscoveryResult {
  teams: TeamConfig[];
  /** Files that exist but failed to parse/validate (surfaced by /team). */
  invalid: TeamFileError[];
}

function loadTeamsFromDir(dir: string, source: "global" | "project"): { teams: TeamConfig[]; invalid: TeamFileError[] } {
  const teams: TeamConfig[] = [];
  const invalid: TeamFileError[] = [];
  if (!dir || !isDirectory(dir)) return { teams, invalid };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { teams, invalid };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      invalid.push({ file: filePath, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const parsed = parseTeamFile(content, { filePath, source });
    if (parsed.ok) teams.push(parsed.value);
    else invalid.push({ file: filePath, message: parsed.message });
  }
  return { teams, invalid };
}

/**
 * Discovers teams. Scope is decided by the caller (project files are only
 * included for trusted projects). Precedence on name conflicts:
 * project > global.
 */
export function discoverTeams(options: { cwd: string; scope: "global" | "both"; globalDir?: string }): DiscoveryResult {
  const globalDir = options.globalDir ?? globalTeamsDir();
  const global = loadTeamsFromDir(globalDir, "global");
  if (options.scope === "global") {
    return { teams: global.teams, invalid: global.invalid };
  }
  const projectDir = findNearestProjectTeamsDir(options.cwd);
  const project = projectDir ? loadTeamsFromDir(projectDir, "project") : { teams: [], invalid: [] };
  const byName = new Map<string, TeamConfig>();
  for (const team of global.teams) byName.set(team.name, team);
  for (const team of project.teams) byName.set(team.name, team); // project wins
  return { teams: Array.from(byName.values()), invalid: [...global.invalid, ...project.invalid] };
}

/** Finds a team by name across the requested scopes. */
export function findTeam(options: {
  cwd: string;
  scope: "global" | "both";
  name: string;
  globalDir?: string;
}): Result<TeamConfig> {
  const { teams } = discoverTeams(options);
  const team = teams.find((t) => t.name === options.name);
  if (!team) {
    const available = teams.map((t) => t.name).join(", ") || "none";
    return err(TeamErrorCodes.TEAM_NOT_FOUND, `team "${options.name}" not found (available: ${available})`);
  }
  return ok(team);
}

// ---------------------------------------------------------------------------
// YAML serialization (write path for conversation-created teams)
// ---------------------------------------------------------------------------

/** Quotes a scalar string as a YAML double-quoted scalar (JSON is valid YAML). */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Emits a block scalar (`key: |`) with the given indentation for content. */
function yamlBlockScalar(key: string, value: string, indent: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const out = [`${indent}${key}: |`];
  for (const line of lines) {
    out.push(line.trim().length > 0 ? `${indent}  ${line}` : "");
  }
  return out;
}

function yamlStringList(key: string, values: string[], indent: string): string {
  return `${indent}${key}: ${JSON.stringify(values)}`;
}

/**
 * Serializes a team into the definition file format. Prompts become block
 * scalars so multi-line system prompts stay readable and editable.
 */
export function serializeTeam(team: Omit<TeamConfig, "filePath" | "source" | "notes">, notes?: string): string {
  const lines: string[] = ["---", `name: ${yamlScalar(team.name)}`];
  if (team.description) lines.push(`description: ${yamlScalar(team.description)}`);
  lines.push("leader:");
  if (team.leader.model) lines.push(`  model: ${yamlScalar(team.leader.model)}`);
  if (team.leader.tools && team.leader.tools.length > 0) {
    lines.push(yamlStringList("tools", team.leader.tools, "  "));
  }
  lines.push(...yamlBlockScalar("prompt", team.leader.prompt, "  "));
  lines.push("members:");
  for (const member of team.members) {
    lines.push(`  - name: ${yamlScalar(member.name)}`);
    if (member.description) lines.push(`    description: ${yamlScalar(member.description)}`);
    if (member.model) lines.push(`    model: ${yamlScalar(member.model)}`);
    if (member.tools && member.tools.length > 0) lines.push(yamlStringList("tools", member.tools, "    "));
    if (member.worktree) lines.push("    worktree: true");
    lines.push(...yamlBlockScalar("prompt", member.prompt, "    "));
  }
  lines.push("---", "");
  if (notes && notes.trim().length > 0) {
    lines.push(notes.trim(), "");
  }
  return lines.join("\n");
}

/**
 * Writes a team definition file. Fails when the target file already exists
 * (teams are reusable assets; edits go through the file itself).
 */
export function createTeamFile(options: { dir: string; team: TeamConfig; notes?: string }): Result<string> {
  const target = path.join(options.dir, `${options.team.name}.md`);
  try {
    if (fs.existsSync(target)) {
      return err(TeamErrorCodes.TEAM_ALREADY_EXISTS, `team file already exists: ${target}`);
    }
    fs.mkdirSync(options.dir, { recursive: true });
    fs.writeFileSync(target, serializeTeam(options.team, options.notes), "utf-8");
    return ok(target);
  } catch (e) {
    return err(TeamErrorCodes.WRITE_FAILED, `failed to write team file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Builds the fully-qualified TeamConfig used by the team_create tool. */
export function buildTeamFromToolInput(input: {
  name: string;
  description?: string;
  leader: { model?: string; tools?: string[]; prompt: string };
  members: Array<{
    name: string;
    description?: string;
    model?: string;
    tools?: string[];
    worktree?: boolean;
    prompt: string;
  }>;
  scope: "global" | "project";
  filePath: string;
}): Result<TeamConfig> {
  const raw = {
    name: input.name,
    description: input.description ?? "",
    leader: { model: input.leader.model, tools: input.leader.tools, prompt: input.leader.prompt },
    members: input.members,
  };
  return validateTeam(raw, { filePath: input.filePath, source: input.scope });
}
