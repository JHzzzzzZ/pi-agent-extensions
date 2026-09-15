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
 *
 * Hand-written files may use bare values containing ": "
 * (`description: 全栈开发: 小队`) — invalid YAML, which the host parser
 * rejects. Those files are tolerated by retrying once with the offending
 * values quoted (agent-team-todo #63); see `parseTeamFile`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  err,
  EXTERNAL_BACKENDS,
  ok,
  type ExternalBackend,
  type Result,
  type RunBudgetConfig,
  type TeamConfig,
  type TeamErrorCode,
  type TeamMemberConfig,
  TeamErrorCodes,
} from "./types.ts";

const NAME_PATTERN = /^[^\s/\\]+$/;

/**
 * Host `VALID_THINKING_LEVELS`（pi coding agent `--model provider/id:level`）。
 * 手动同步，扩展不 import 宿主内部模块。
 */
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * 拆分 `provider/id[:level]` 声明模型：仅当**最后一个** `:` 后缀是宿主的有效
 * 思考级别时剥离，否则原样返回（模型 id 本身可能含冒号）。空值/undefined 安全。
 */
export function splitModelThinking(model?: string): { model?: string; thinkingLevel?: string } {
  if (!model) return {};
  const colonIndex = model.lastIndexOf(":");
  // `<= 0`：剥完会得到空模型（裸后缀 `:high`）不剥，它不是可解析的模型引用。
  if (colonIndex <= 0) return { model };
  const suffix = model.slice(colonIndex + 1);
  if (!VALID_THINKING_LEVELS.has(suffix)) return { model };
  return { model: model.slice(0, colonIndex), thinkingLevel: suffix };
}

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
 * Validates an optional `backend:` value against the v1 external CLI list.
 * Exact string match (no trimming); a present-but-invalid value (unknown
 * name, number, empty string, null) is INVALID_TEAM_FILE and the message
 * names every legal value.
 */
function normalizeBackend(value: unknown, owner: string): Result<ExternalBackend | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value === "string" && EXTERNAL_BACKENDS.some((backend) => backend === value)) {
    return ok(value as ExternalBackend);
  }
  const shown = typeof value === "string" ? `"${value}"` : String(value);
  return invalid(`invalid ${owner}.backend ${shown}: expected one of ${EXTERNAL_BACKENDS.join(", ")}`);
}

/** Recognized budget cap keys (unknown keys are rejected — typo protection). */
const BUDGET_KEYS = new Set(["maxDispatchCalls", "maxMemberRuns", "maxCostUsd", "maxTotalTokens"]);

/** Validates the frontmatter `budget:` block (all caps optional, positive numbers). */
function normalizeBudget(value: unknown): Result<RunBudgetConfig | undefined> {
  if (value === undefined) return ok(undefined);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("budget must be a mapping of numeric caps");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return invalid("budget must set at least one cap (maxDispatchCalls/maxMemberRuns/maxCostUsd/maxTotalTokens)");
  }
  const budget: RunBudgetConfig = {};
  for (const key of keys) {
    if (!BUDGET_KEYS.has(key)) {
      return invalid(`unknown budget cap "${key}" (expected maxDispatchCalls/maxMemberRuns/maxCostUsd/maxTotalTokens)`);
    }
    const num = raw[key];
    if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
      return invalid(`budget.${key} must be a positive finite number`);
    }
    (budget as Record<string, number>)[key] = num;
  }
  return ok(budget);
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
  const leaderBackend = normalizeBackend(leaderMap.backend, "leader");
  if (!leaderBackend.ok) return leaderBackend;
  const leaderModel =
    typeof leaderMap.model === "string" && leaderMap.model.trim().length > 0 ? leaderMap.model.trim() : undefined;
  if (leaderModel && /\s/.test(leaderModel)) {
    return invalid(`invalid leader.model "${leaderModel}": must not contain whitespace`);
  }

  // Team-level shared worktree (opt-in; members can override with their own).
  const worktree = rawMap.worktree === true;

  // Per-run budget caps (frontmatter `budget:` block).
  const budget = normalizeBudget(rawMap.budget);
  if (!budget.ok) return budget;

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
    const memberBackend = normalizeBackend(memberMap.backend, `members.${memberName}`);
    if (!memberBackend.ok) return memberBackend;
    const model =
      typeof memberMap.model === "string" && memberMap.model.trim().length > 0 ? memberMap.model.trim() : undefined;
    if (model && /\s/.test(model)) {
      return invalid(`invalid members.${memberName}.model "${model}": must not contain whitespace`);
    }
    members.push({
      name: memberName,
      ...(memberBackend.value ? { backend: memberBackend.value } : {}),
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
      ...(leaderBackend.value ? { backend: leaderBackend.value } : {}),
      model: leaderModel,
      tools: normalizeTools(leaderMap.tools),
      prompt: leaderMap.prompt,
    },
    members,
    ...(worktree ? { worktree: true } : {}),
    ...(budget.value !== undefined ? { budget: budget.value } : {}),
    notes: meta.body && meta.body.trim().length > 0 ? meta.body : undefined,
    filePath: meta.filePath,
    source: meta.source,
  });
}

// ---------------------------------------------------------------------------
// Bare ": " tolerance (agent-team-todo #63)
// ---------------------------------------------------------------------------

/**
 * 裸标量行：`key: value`（含列表项 `- key: value`、任意缩进）。键限 ASCII
 * 标识符——CJK 开头的列表项（`- 全栈开发: 小队`，值本身是映射）不会被误判。
 */
const BARE_SCALAR_LINE = /^([ \t]*(?:-[ \t]+)?[A-Za-z0-9_][\w.-]*[ \t]*:[ \t]+)(\S.*?)[ \t]*$/;

/** 块标量头（`key: |` / `key: >`，可带 chomping/缩进指示）。 */
const BLOCK_SCALAR_HEAD = /^[ \t]*(?:-[ \t]+)?[^ \t:][^:]*:[ \t]*[|>][+-]?[0-9]*[ \t]*$/;

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

interface BareColonValue {
  /** 团队文件里的 1-based 行号（首行 `---` 是第 1 行）。 */
  line: number;
  /** 行首（缩进 + `- ` + 键 + `: `），重写时原样保留。 */
  prefix: string;
  value: string;
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * frontmatter 块结束行（以 `---` 开头的第一个后续行），无块时 -1。按行口径
 * 等价于宿主 `extractFrontmatter` 的 `indexOf("\n---", 3)`（`utils/frontmatter.js`）:
 * 首行必须也以 `---` 开头，否则根本没有 frontmatter。重写只允许落在块内——
 * 正文（团队备注，会被追加进 leader prompt）里的冒号一个都不许动。
 */
function frontmatterBlockEnd(lines: string[]): number {
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "");
  if (!first.startsWith("---")) return -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("---")) return i;
  }
  return -1;
}

/**
 * frontmatter 块内「值含 `": "` 的裸标量行」——已加引号的值、`|`/`>` 块标量
 * 不需要（也不能）加引号，原样跳过。块标量**内容行**同样跳过：它们不是映射的
 * 裸标量，重写一行等于悄悄改 prompt 正文（即使这行长得像 `Note: 说明`）。
 */
function bareColonValues(content: string): BareColonValue[] {
  const lines = normalizeNewlines(content).split("\n");
  const end = frontmatterBlockEnd(lines);
  if (end < 0) return [];
  const found: BareColonValue[] = [];
  let blockIndent = -1; // 当前块标量头的缩进；< 0 = 不在块标量里
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (blockIndent >= 0) {
      if (line.trim().length === 0 || leadingWhitespace(line) > blockIndent) continue;
      blockIndent = -1;
    }
    if (BLOCK_SCALAR_HEAD.test(line)) {
      blockIndent = leadingWhitespace(line);
      continue;
    }
    const match = BARE_SCALAR_LINE.exec(line);
    if (!match) continue;
    const value = match[2] ?? "";
    if (!value.includes(": ") || /^["'|>]/.test(value)) continue;
    found.push({ line: i + 1, prefix: match[1] ?? "", value });
  }
  return found;
}

/** 重写：目标行值加引号（转义口径复用写盘路径的 `yamlScalar`）。 */
function quoteBareColonValues(content: string, values: BareColonValue[]): string {
  const lines = normalizeNewlines(content).split("\n");
  for (const entry of values) lines[entry.line - 1] = `${entry.prefix}${yamlScalar(entry.value)}`;
  return lines.join("\n");
}

/**
 * 解析失败文案：能定位到裸 `": "` 行时前置单行修法提示（行号按团队文件计），
 * 原始 YAML 错误原样保留作细节；没有这种行就不猜（避免给出误导性提示）。
 */
function frontmatterErrorMessage(error: unknown, values: BareColonValue[]): string {
  const detail = `failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`;
  if (values.length === 0) return detail;
  return `第 ${values[0].line} 行的值含 ": "，请加引号（"…"）或改用 | 块标量\n${detail}`;
}

/** Parses one team definition file's content. */
export function parseTeamFile(
  content: string,
  meta: { filePath: string; source: "global" | "project" },
): Result<TeamConfig> {
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    return validateTeam(parsed.frontmatter, { ...meta, body: parsed.body });
  } catch (e) {
    const values = bareColonValues(content);
    if (values.length > 0) {
      // 容忍裸 `": "`：整块加引号后重试一次；仍失败则回落原错误（细节以首次失败为准）。
      try {
        const retried = parseFrontmatter<Record<string, unknown>>(quoteBareColonValues(content, values));
        return validateTeam(retried.frontmatter, { ...meta, body: retried.body });
      } catch {
        /* fall through to the original error + hint */
      }
    }
    return invalid(frontmatterErrorMessage(e, values));
  }
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
  /** Files that exist but failed to parse/validate (surfaced by /team:list). */
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

/** 错误/原因文案首行（多行解析错误里首行才是可操作的那句）。 */
function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

/**
 * TEAM_NOT_FOUND 追加「另有 N 个定义不可用：<file>（<原因首行>）」(#63)：run/resume
 * 路径过去只报 available 列表，坏文件等于隐身（用户视角是「团队不见了」）。
 */
function invalidDefinitionsSuffix(invalid: TeamFileError[]): string {
  if (invalid.length === 0) return "";
  const listed = invalid.map((bad) => `${bad.file}（${firstLine(bad.message)}）`).join("；");
  return `；另有 ${invalid.length} 个定义不可用：${listed}`;
}

/** Finds a team by name across the requested scopes. */
export function findTeam(options: {
  cwd: string;
  scope: "global" | "both";
  name: string;
  globalDir?: string;
}): Result<TeamConfig> {
  const { teams, invalid } = discoverTeams(options);
  const team = teams.find((t) => t.name === options.name);
  if (!team) {
    const available = teams.map((t) => t.name).join(", ") || "none";
    const message = `team "${options.name}" not found (available: ${available})${invalidDefinitionsSuffix(invalid)}`;
    return err(TeamErrorCodes.TEAM_NOT_FOUND, message);
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
  if (team.worktree) lines.push("worktree: true");
  if (team.budget) {
    lines.push("budget:");
    const caps = team.budget as Record<string, number | undefined>;
    for (const key of ["maxDispatchCalls", "maxMemberRuns", "maxCostUsd", "maxTotalTokens"]) {
      const cap = caps[key];
      if (cap !== undefined) lines.push(`  ${key}: ${cap}`);
    }
  }
  lines.push("leader:");
  if (team.leader.backend) lines.push(`  backend: ${team.leader.backend}`);
  if (team.leader.model) lines.push(`  model: ${yamlScalar(team.leader.model)}`);
  if (team.leader.tools && team.leader.tools.length > 0) {
    lines.push(yamlStringList("tools", team.leader.tools, "  "));
  }
  lines.push(...yamlBlockScalar("prompt", team.leader.prompt, "  "));
  lines.push("members:");
  for (const member of team.members) {
    lines.push(`  - name: ${yamlScalar(member.name)}`);
    if (member.backend) lines.push(`    backend: ${member.backend}`);
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
  worktree?: boolean;
  leader: { backend?: ExternalBackend; model?: string; tools?: string[]; prompt: string };
  members: Array<{
    name: string;
    description?: string;
    backend?: ExternalBackend;
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
    ...(input.worktree ? { worktree: true } : {}),
    leader: { backend: input.leader.backend, model: input.leader.model, tools: input.leader.tools, prompt: input.leader.prompt },
    members: input.members,
  };
  return validateTeam(raw, { filePath: input.filePath, source: input.scope });
}
