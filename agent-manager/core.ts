/**
 * agent-manager 核心：Pi 落盘会话（`~/.pi/agent/sessions/`）的只读浏览/检索 + 两段式写操作。
 *
 * 事实来源：宿主 docs/session-format.md（v3 JSONL，header + 树形 entry；会话目录按 cwd
 * 编码为 `--<path>--`）。本模块零运行时依赖，不引入宿主的 SessionManager——只读解析
 * 文件即可满足浏览/检索，也让全部逻辑可注入 fs 单测。
 *
 * 写操作语义（照抄宿主同名能力，来源：宿主 dist/core/session-manager.js 的 appendSessionInfo）：
 * - 重命名 = 文件末尾追加一条 `session_info` entry：name 清洗 `[\r\n]+` → 空格 + trim、
 *   id = randomUUID 前 8 位 hex 且对文件内已有 id 防碰撞（最多重试 100 次）、
 *   parentId = 文件最后一条 entry 的 id、timestamp = ISO 当前时间；不改文件名/header、不写 sidecar。
 * - 删除 = 移入工具自有 trash（`<epochMs>-<原文件名>` + `<同名>.meta.json` sidecar），可恢复；
 *   renameSync 跨盘抛错时 copyFileSync + unlinkSync 兜底。
 * - 两段式：`confirm` 缺省/false 时只返回计划（appendLine / trashName），零写副作用。
 *
 * 边界：list/search/preview 绝不写；接续/分支交给宿主 `pi --session <id>` / `pi --fork <id>`
 * （只输出命令，不 spawn）；一个坏文件不影响整次扫描。
 *
 * 结果联合沿用仓库约定：{ ok: true, value } | { ok: false, code, message }。
 * JHL-62 session-manager（用户 2026-09-11 形态纠正：注销 Pi 扩展、重构为独立 agent 管理工具）
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const SessionErrorCodes = {
  DIR_MISSING: "SESSION_DIR_MISSING",
  BAD_QUERY: "SESSION_BAD_QUERY",
  NOT_FOUND: "SESSION_NOT_FOUND",
  AMBIGUOUS: "SESSION_AMBIGUOUS",
  BAD_NAME: "SESSION_BAD_NAME",
  WRITE_FAILED: "SESSION_WRITE_FAILED",
  TARGET_EXISTS: "SESSION_TARGET_EXISTS",
  TRASH_MISSING: "SESSION_TRASH_MISSING",
} as const;
export type SessionErrorCode = (typeof SessionErrorCodes)[keyof typeof SessionErrorCodes];

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SessionErrorCode; message: string };

/** fs 注入缝：默认走 node:fs，测试用 fake 覆盖进程边界分支（读失败 / 跨盘 rename 失败）。 */
export interface SessionFsDeps {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
  readFileSync(p: string): string;
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  mkdirSync(p: string, options: { recursive: true }): void;
  utimesSync(p: string, atimeSec: number, mtimeSec: number): void;
}

const nodeFs: SessionFsDeps = {
  existsSync: (p) => existsSync(p),
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => statSync(p),
  readFileSync: (p) => readFileSync(p, "utf8"),
  appendFileSync: (p, data) => appendFileSync(p, data, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data, "utf8"),
  renameSync: (from, to) => renameSync(from, to),
  copyFileSync: (from, to) => copyFileSync(from, to),
  unlinkSync: (p) => unlinkSync(p),
  mkdirSync: (p, options) => {
    mkdirSync(p, options);
  },
  utimesSync: (p, atimeSec, mtimeSec) => utimesSync(p, atimeSec, mtimeSec),
};

export interface FileFacts {
  path: string;
  file: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SessionMeta {
  path: string;
  file: string;
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
  model: string;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  firstUserText: string;
  parentSession: string;
}

export interface SearchHit {
  meta: SessionMeta;
  hits: number;
  snippets: string[];
}

export interface PreviewLine {
  role: string;
  text: string;
}

export interface SessionPreview {
  meta: SessionMeta;
  tail: PreviewLine[];
  resumeCommand: string;
  forkCommand: string;
}

export interface SessionFilter {
  cwd?: string;
  limit?: number;
}

export interface WriteOptions {
  confirm?: boolean;
  now?: () => string;
  idFactory?: () => string;
  trashDir?: string;
}

export interface RenameOutcome {
  confirmed: boolean;
  file: string;
  currentName: string;
  newName: string;
  appendLine: string;
}

export interface DeleteOutcome {
  confirmed: boolean;
  file: string;
  sizeBytes: number;
  trashDir: string;
  trashName: string;
}

export interface TrashEntry {
  name: string;
  origPath: string;
  deletedAt: string;
  sizeBytes: number;
}

export interface RestoreOutcome {
  confirmed: boolean;
  trashName: string;
  restoredPath: string;
}

const PREVIEW_TAIL = 6;
const PREVIEW_TEXT_MAX = 400;
const SNIPPET_MAX = 2;
const DEFAULT_SEARCH_LIMIT = 20;
const ID_COLLISION_RETRIES = 100;
const SIDECAR_SUFFIX = ".meta.json";

/** 数组内容块 → 纯文本（只取 text 块；图片/思考/工具调用不参与检索与预览）。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** 压成单行并截断（列表标题/摘要用）。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 单行 JSON 解析：非对象/坏行/空行 → undefined（坏行容忍的唯一入口）。 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 解析一份会话 JSONL 文本：坏行/未知 entry 一律跳过，绝不让一份坏文件崩掉调用方。 */
export function parseSessionText(text: string, facts: FileFacts): SessionMeta {
  let id = "";
  let cwd = "";
  let createdAt = "";
  let parentSession = "";
  let name = "";
  let model = "";
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let firstUserText = "";

  for (const raw of text.split("\n")) {
    const entry = parseJsonObject(raw);
    if (!entry) continue;
    switch (entry.type) {
      case "session": {
        if (typeof entry.id === "string") id = entry.id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.timestamp === "string") createdAt = entry.timestamp;
        if (typeof entry.parentSession === "string") parentSession = entry.parentSession;
        break;
      }
      case "session_info": {
        if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
        break;
      }
      case "model_change": {
        if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
          model = `${entry.provider}/${entry.modelId}`; // 后出现的覆盖先出现的
        }
        break;
      }
      case "message": {
        const message = entry.message;
        if (!message || typeof message !== "object") break;
        const role = (message as { role?: unknown }).role;
        if (role === "user") {
          userMessages++;
          if (!firstUserText) firstUserText = contentText((message as { content?: unknown }).content);
        } else if (role === "assistant") {
          assistantMessages++;
          const provider = (message as { provider?: unknown }).provider;
          const msgModel = (message as { model?: unknown }).model;
          if (typeof provider === "string" && typeof msgModel === "string") model = `${provider}/${msgModel}`;
        } else if (role === "toolResult") {
          toolResults++;
        }
        break;
      }
    }
  }

  return {
    path: facts.path,
    file: facts.file,
    id,
    cwd,
    name,
    createdAt,
    modifiedAt: new Date(facts.mtimeMs).toISOString(),
    sizeBytes: facts.sizeBytes,
    model,
    userMessages,
    assistantMessages,
    toolResults,
    firstUserText: oneLine(firstUserText, 200),
    parentSession,
  };
}

/** 会话根目录两种形态都认：默认 `<root>/<--encoded-cwd-->/x.jsonl`，自定义目录 `<root>/x.jsonl`。 */
function jsonlFilesOf(rootDir: string, deps: SessionFsDeps): FileFacts[] {
  const out: FileFacts[] = [];
  let entries: string[] = [];
  try {
    entries = deps.readdirSync(rootDir);
  } catch {
    return out;
  }
  const collect = (dir: string, names: string[]): void => {
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        const st = deps.statSync(p);
        if (st.isDirectory()) continue;
        out.push({ path: p, file: name, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // stat 竞态/坏文件：跳过
      }
    }
  };
  for (const entry of entries) {
    if (entry.endsWith(".jsonl")) {
      collect(rootDir, [entry]);
      continue;
    }
    const dir = join(rootDir, entry);
    try {
      if (!deps.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      collect(dir, deps.readdirSync(dir));
    } catch {
      // 目录不可读：跳过
    }
  }
  return out;
}

/** 读取一份会话文本；失败返回 undefined（单文件坏点不拖垮扫描）。 */
function readSessionText(facts: FileFacts, deps: SessionFsDeps): string | undefined {
  try {
    return deps.readFileSync(facts.path);
  } catch {
    return undefined;
  }
}

function sameCwd(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  try {
    const ra = resolve(a);
    const rb = resolve(b);
    return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return a === b;
  }
}

/** 列出会话（按修改时间倒序）；目录不存在是显式错误，空目录返回空数组。 */
export function listSessions(rootDir: string, filter: SessionFilter = {}, deps: SessionFsDeps = nodeFs): SessionResult<SessionMeta[]> {
  if (!deps.existsSync(rootDir)) {
    return { ok: false, code: SessionErrorCodes.DIR_MISSING, message: `会话目录不存在：${rootDir}` };
  }
  const metas: SessionMeta[] = [];
  for (const facts of jsonlFilesOf(rootDir, deps)) {
    const text = readSessionText(facts, deps);
    if (text === undefined) continue;
    const meta = parseSessionText(text, facts);
    if (!meta.id) continue; // 没有 session header 的文件不是会话（宿主 discovery 同口径）
    if (filter.cwd && !sameCwd(meta.cwd, filter.cwd)) continue;
    metas.push(meta);
  }
  metas.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { ok: true, value: metas };
}

/** 在用户/助手文本与会话名上做大小写不敏感全文检索；工具输出不参与（噪音）。 */
export function searchSessions(rootDir: string, query: string, filter: SessionFilter = {}, deps: SessionFsDeps = nodeFs): SessionResult<SearchHit[]> {
  const needle = query.trim();
  if (!needle) {
    return { ok: false, code: SessionErrorCodes.BAD_QUERY, message: "检索词不能为空" };
  }
  if (!deps.existsSync(rootDir)) {
    return { ok: false, code: SessionErrorCodes.DIR_MISSING, message: `会话目录不存在：${rootDir}` };
  }
  const lower = needle.toLowerCase();
  const hits: SearchHit[] = [];
  for (const facts of jsonlFilesOf(rootDir, deps)) {
    const text = readSessionText(facts, deps);
    if (text === undefined) continue;
    const meta = parseSessionText(text, facts);
    if (!meta.id) continue;
    if (filter.cwd && !sameCwd(meta.cwd, filter.cwd)) continue;

    let count = 0;
    const snippets: string[] = [];
    const consider = (value: string): void => {
      const flat = oneLine(value, 4000);
      const idx = flat.toLowerCase().indexOf(lower);
      if (idx < 0) return;
      count++;
      if (snippets.length < SNIPPET_MAX) {
        const start = Math.max(0, idx - 40);
        snippets.push(`…${flat.slice(start, idx + needle.length + 80)}…`);
      }
    };

    if (meta.name) consider(meta.name);
    for (const raw of text.split("\n")) {
      const entry = parseJsonObject(raw);
      if (!entry || entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      const role = (message as { role?: unknown }).role;
      if (role !== "user" && role !== "assistant") continue;
      consider(contentText((message as { content?: unknown }).content));
    }
    if (count > 0) hits.push({ meta, hits: count, snippets });
  }
  hits.sort((a, b) => (b.hits - a.hits) || b.meta.modifiedAt.localeCompare(a.meta.modifiedAt));
  const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_SEARCH_LIMIT;
  return { ok: true, value: hits.slice(0, limit) };
}

function tailLines(text: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const raw of text.split("\n")) {
    const entry = parseJsonObject(raw);
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const body = oneLine(contentText((message as { content?: unknown }).content), PREVIEW_TEXT_MAX);
    if (!body) continue;
    lines.push({ role, text: body });
  }
  return lines.slice(-PREVIEW_TAIL);
}

/** AMBIGUOUS 提示用显示名：无 session_info 名时退回首条用户文本占位。 */
function sessionTitle(meta: SessionMeta): string {
  if (meta.name) return meta.name;
  if (meta.firstUserText) return meta.firstUserText;
  return "(无标题)";
}

interface LocatedSession {
  facts: FileFacts;
  meta: SessionMeta;
  text: string;
}

/**
 * preview/rename/delete 共用的唯一定位：id 前缀或文件名（前缀/包含）匹配；
 * 缺失 → NOT_FOUND、多候选 → AMBIGUOUS、目录缺失 → DIR_MISSING。
 */
function locateSession(rootDir: string, ref: string, deps: SessionFsDeps): SessionResult<LocatedSession> {
  const needle = ref.trim();
  if (!needle) {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "缺少会话引用（id 前缀或文件名前缀）" };
  }
  if (!deps.existsSync(rootDir)) {
    return { ok: false, code: SessionErrorCodes.DIR_MISSING, message: `会话目录不存在：${rootDir}` };
  }
  const lower = needle.toLowerCase();
  const matches: LocatedSession[] = [];
  for (const facts of jsonlFilesOf(rootDir, deps)) {
    const text = readSessionText(facts, deps);
    if (text === undefined) continue;
    const meta = parseSessionText(text, facts);
    if (!meta.id) continue;
    const fileHit = facts.file.toLowerCase().startsWith(lower) || facts.file.toLowerCase().includes(lower);
    const idHit = meta.id.toLowerCase().startsWith(lower);
    if (fileHit || idHit) matches.push({ facts, meta, text });
  }
  if (matches.length === 0) {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: `找不到会话：${needle}` };
  }
  if (matches.length > 1) {
    const shown = matches.slice(0, 5).map((m) => `${m.meta.id.slice(0, 8)}（${sessionTitle(m.meta)}）`).join("、");
    return {
      ok: false,
      code: SessionErrorCodes.AMBIGUOUS,
      message: `${matches.length} 个候选会话：${shown}${matches.length > 5 ? " …" : ""}；请用更长的 id 前缀`,
    };
  }
  return { ok: true, value: matches[0] };
}

/** 按会话 id 前缀 / 文件名前缀定位一份会话并给出预览与宿主接续命令。 */
export function previewSession(rootDir: string, ref: string, deps: SessionFsDeps = nodeFs): SessionResult<SessionPreview> {
  const located = locateSession(rootDir, ref, deps);
  if (!located.ok) return located;
  const { meta, text } = located.value;
  return {
    ok: true,
    value: {
      meta,
      tail: tailLines(text),
      resumeCommand: `pi --session ${meta.id.slice(0, 8)}`,
      forkCommand: `pi --fork ${meta.id.slice(0, 8)}`,
    },
  };
}

/** 文件内全部 entry id（重命名追加新 id 时防碰撞用）。 */
function entryIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const raw of text.split("\n")) {
    const entry = parseJsonObject(raw);
    if (entry && typeof entry.id === "string") ids.add(entry.id);
  }
  return ids;
}

/** 文件最后一条可解析 entry 的 id（宿主 open 后 leafId 的口径）；无则 null。 */
function lastEntryId(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonObject(lines[i]);
    if (!entry) continue;
    return typeof entry.id === "string" ? entry.id : null;
  }
  return null;
}

/** 生成不碰撞的短 id：最多重试 100 次，兜底全 UUID（复刻宿主 generateId）。 */
function freshId(idFactory: () => string, existing: Set<string>): string {
  for (let attempt = 0; attempt < ID_COLLISION_RETRIES; attempt++) {
    const id = idFactory();
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

type WriteOp = "mkdir" | "append" | "copy" | "unlink" | "sidecar" | "mtime";

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/** 写失败统一转 WRITE_FAILED：消息只含静态操作名与底层错误号，绝不插值用户输入/路径。 */
function writeFailed(op: WriteOp, error: unknown): { ok: false; code: SessionErrorCode; message: string } {
  const code = errorCodeOf(error);
  return {
    ok: false,
    code: SessionErrorCodes.WRITE_FAILED,
    message: code ? `会话写操作失败（${op}）：${code}` : `会话写操作失败（${op}）`,
  };
}

type MoveResult = { ok: true } | { ok: false; code: SessionErrorCode; message: string };

/** 移动文件：rename 优先；跨盘（EXDEV 等）rename 抛错时 copy + unlink 兜底。 */
function moveFile(from: string, to: string, deps: SessionFsDeps): MoveResult {
  try {
    deps.renameSync(from, to);
    return { ok: true };
  } catch {
    // 跨盘 rename 不支持：走 copy + unlink 兜底
  }
  try {
    deps.copyFileSync(from, to);
  } catch (error) {
    return writeFailed("copy", error);
  }
  try {
    deps.unlinkSync(from);
  } catch (error) {
    return writeFailed("unlink", error);
  }
  return { ok: true };
}

/** 默认 trash：`<home>/.pi/agent/agent-manager/trash`（server 显式传设置值；测试传临时目录）。 */
export function defaultTrashDir(): string {
  return join(homedir(), ".pi", "agent", "agent-manager", "trash");
}

/**
 * 重命名 = 文件末尾追加宿主语义的 `session_info` 行（不覆盖原内容、不改文件名）。
 * dry-run（默认）只返回 appendLine；`confirm: true` 才追加。
 * currentName 为最后一条 session_info 的显示名，从未命名过则为空串。
 */
export function renameSession(rootDir: string, ref: string, name: string, options: WriteOptions = {}, deps: SessionFsDeps = nodeFs): SessionResult<RenameOutcome> {
  const located = locateSession(rootDir, ref, deps);
  if (!located.ok) return located;

  const cleaned = name.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned) {
    return { ok: false, code: SessionErrorCodes.BAD_NAME, message: "会话名清洗后为空（换行会替换为空格）" };
  }

  const { facts, meta, text } = located.value;
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? (() => randomUUID().slice(0, 8));
  const appendLine = JSON.stringify({
    type: "session_info",
    id: freshId(idFactory, entryIds(text)),
    parentId: lastEntryId(text),
    timestamp: now(),
    name: cleaned,
  });
  const outcome: RenameOutcome = {
    confirmed: options.confirm === true,
    file: facts.path,
    currentName: meta.name,
    newName: cleaned,
    appendLine,
  };
  if (!outcome.confirmed) return { ok: true, value: outcome };

  try {
    const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    deps.appendFileSync(facts.path, `${separator}${appendLine}\n`);
  } catch (error) {
    return writeFailed("append", error);
  }
  return { ok: true, value: outcome };
}

/**
 * 可恢复删除 = 移入 trash + sidecar 元数据；跨盘（renameSync 抛错）兜底 copyFileSync + unlinkSync。
 * dry-run（默认）只返回计划，不创建 trash 目录。
 */
export function deleteSession(rootDir: string, ref: string, options: WriteOptions = {}, deps: SessionFsDeps = nodeFs): SessionResult<DeleteOutcome> {
  const located = locateSession(rootDir, ref, deps);
  if (!located.ok) return located;

  const { facts } = located.value;
  const trashDir = options.trashDir ?? defaultTrashDir();
  const deletedAt = (options.now ?? (() => new Date().toISOString()))();
  const stamp = Date.parse(deletedAt);
  const outcome: DeleteOutcome = {
    confirmed: options.confirm === true,
    file: facts.path,
    sizeBytes: facts.sizeBytes,
    trashDir,
    trashName: `${Number.isNaN(stamp) ? Date.now() : stamp}-${basename(facts.path)}`,
  };
  if (!outcome.confirmed) return { ok: true, value: outcome };

  try {
    deps.mkdirSync(trashDir, { recursive: true });
  } catch (error) {
    return writeFailed("mkdir", error);
  }
  const trashPath = join(trashDir, outcome.trashName);
  const moved = moveFile(facts.path, trashPath, deps);
  if (!moved.ok) return moved;
  try {
    const sidecar = { origPath: facts.path, sizeBytes: facts.sizeBytes, mtimeMs: facts.mtimeMs, deletedAt };
    deps.writeFileSync(`${trashPath}${SIDECAR_SUFFIX}`, JSON.stringify(sidecar, null, 2));
  } catch (error) {
    return writeFailed("sidecar", error);
  }
  return { ok: true, value: outcome };
}

/** 列 trash（按删除时间倒序）；目录不存在返回空数组（不是错误）。 */
export function listTrash(trashDir: string, deps: SessionFsDeps = nodeFs): SessionResult<TrashEntry[]> {
  if (!deps.existsSync(trashDir)) return { ok: true, value: [] };
  let files: string[] = [];
  try {
    files = deps.readdirSync(trashDir);
  } catch {
    return { ok: true, value: [] };
  }
  const entries: TrashEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(SIDECAR_SUFFIX)) continue;
    const name = file.slice(0, -SIDECAR_SUFFIX.length);
    if (!name || !deps.existsSync(join(trashDir, name))) continue; // 数据文件缺失：不列幽灵条目
    let raw = "";
    try {
      raw = deps.readFileSync(join(trashDir, file));
    } catch {
      continue;
    }
    const sidecar = parseJsonObject(raw);
    if (!sidecar) continue;
    const { origPath, deletedAt, sizeBytes } = sidecar;
    if (typeof origPath !== "string" || typeof deletedAt !== "string" || typeof sizeBytes !== "number") continue;
    entries.push({ name, origPath, deletedAt, sizeBytes });
  }
  entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { ok: true, value: entries };
}

/**
 * 恢复到 sidecar 记录的原路径（父目录缺失则重建），恢复原 mtime；
 * 目标已存在 → TARGET_EXISTS；trash 目录缺失 → TRASH_MISSING；未知条目 → NOT_FOUND。
 */
export function restoreSession(trashDir: string, trashName: string, options: WriteOptions = {}, deps: SessionFsDeps = nodeFs): SessionResult<RestoreOutcome> {
  const name = trashName.trim();
  if (!name || basename(name) !== name) {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "回收站条目名不合法" };
  }
  if (!deps.existsSync(trashDir)) {
    return { ok: false, code: SessionErrorCodes.TRASH_MISSING, message: "回收站目录不存在" };
  }
  const trashPath = join(trashDir, name);
  if (!deps.existsSync(trashPath)) {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "回收站中找不到该条目" };
  }

  let rawSidecar = "";
  try {
    rawSidecar = deps.readFileSync(`${trashPath}${SIDECAR_SUFFIX}`);
  } catch {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "回收站条目的元数据缺失或损坏" };
  }
  const sidecar = parseJsonObject(rawSidecar);
  const origPath = sidecar?.origPath;
  const mtimeMs = sidecar?.mtimeMs;
  if (typeof origPath !== "string" || typeof mtimeMs !== "number") {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "回收站条目的元数据缺失或损坏" };
  }
  if (deps.existsSync(origPath)) {
    return { ok: false, code: SessionErrorCodes.TARGET_EXISTS, message: "原路径已有文件，未覆盖" };
  }

  const outcome: RestoreOutcome = { confirmed: options.confirm === true, trashName: name, restoredPath: origPath };
  if (!outcome.confirmed) return { ok: true, value: outcome };

  try {
    deps.mkdirSync(dirname(origPath), { recursive: true });
  } catch (error) {
    return writeFailed("mkdir", error);
  }
  const moved = moveFile(trashPath, origPath, deps);
  if (!moved.ok) return moved;
  try {
    deps.utimesSync(origPath, mtimeMs / 1000, mtimeMs / 1000);
  } catch (error) {
    return writeFailed("mtime", error);
  }
  try {
    deps.unlinkSync(`${trashPath}${SIDECAR_SUFFIX}`);
  } catch (error) {
    return writeFailed("sidecar", error);
  }
  return { ok: true, value: outcome };
}

/** 会话根目录推断：默认会话目录是 `<根>/--<encoded-cwd>--` 时取父目录；自定义目录原样使用。 */
export function sessionRootOf(sessionDir: string): string {
  const name = basename(sessionDir);
  return name.startsWith("--") && name.endsWith("--") ? dirname(sessionDir) : sessionDir;
}
