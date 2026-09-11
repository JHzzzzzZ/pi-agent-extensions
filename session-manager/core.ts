/**
 * session-manager 核心：Pi 落盘会话（`~/.pi/agent/sessions/`）的只读浏览与检索。
 *
 * 事实来源：宿主 docs/session-format.md（v3 JSONL，header + 树形 entry；会话目录按 cwd
 * 编码为 `--<path>--`）。本模块零运行时依赖，不引入宿主的 SessionManager——只读解析
 * 文件即可满足浏览/检索，也让全部逻辑可注入 fs 单测。
 *
 * 边界：只读（list/search/preview 不写任何文件）；接续/分支交给宿主
 * `pi --session <id>` / `pi --fork <id>`（只输出命令，不 spawn）；一个坏文件不影响整次扫描。
 *
 * 结果联合沿用仓库约定：{ ok: true, value } | { ok: false, code, message }。
 * JHL-62 session-manager（用户 2026-09-11 需求）
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SessionErrorCodes = {
  DIR_MISSING: "SESSION_DIR_MISSING",
  BAD_QUERY: "SESSION_BAD_QUERY",
  NOT_FOUND: "SESSION_NOT_FOUND",
  AMBIGUOUS: "SESSION_AMBIGUOUS",
} as const;
export type SessionErrorCode = (typeof SessionErrorCodes)[keyof typeof SessionErrorCodes];

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SessionErrorCode; message: string };

/** fs 注入缝：默认走 node:fs，测试用 fake 覆盖进程边界分支。 */
export interface SessionFsDeps {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { size: number; mtimeMs: number; isDirectory(): boolean };
  readFileSync: (p: string) => string;
}

const nodeFs: SessionFsDeps = {
  existsSync,
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => statSync(p),
  readFileSync: (p) => readFileSync(p, "utf8"),
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

const PREVIEW_TAIL = 6;
const PREVIEW_TEXT_MAX = 400;
const SNIPPET_MAX = 2;
const DEFAULT_SEARCH_LIMIT = 20;

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
    const line = raw.trim(); // CRLF 容忍
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
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
      const line = raw.trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        entry = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
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

/** 按会话 id 前缀 / 文件名前缀定位一份会话并给出预览与宿主接续命令。 */
export function previewSession(rootDir: string, ref: string, deps: SessionFsDeps = nodeFs): SessionResult<SessionPreview> {
  const needle = ref.trim();
  if (!needle) {
    return { ok: false, code: SessionErrorCodes.NOT_FOUND, message: "缺少会话引用（id 前缀或文件名前缀）" };
  }
  if (!deps.existsSync(rootDir)) {
    return { ok: false, code: SessionErrorCodes.DIR_MISSING, message: `会话目录不存在：${rootDir}` };
  }
  const lower = needle.toLowerCase();
  const matches: Array<{ meta: SessionMeta; text: string }> = [];
  for (const facts of jsonlFilesOf(rootDir, deps)) {
    const text = readSessionText(facts, deps);
    if (text === undefined) continue;
    const meta = parseSessionText(text, facts);
    if (!meta.id) continue;
    const fileHit = facts.file.toLowerCase().startsWith(lower) || facts.file.toLowerCase().includes(lower);
    const idHit = meta.id.toLowerCase().startsWith(lower);
    if (fileHit || idHit) matches.push({ meta, text });
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
  const { meta, text } = matches[0];
  return { ok: true, value: { meta, tail: tailLines(text), resumeCommand: `pi --session ${meta.id.slice(0, 8)}`, forkCommand: `pi --fork ${meta.id.slice(0, 8)}` } };
}

function tailLines(text: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function sessionTitle(meta: SessionMeta): string {
  if (meta.name) return meta.name;
  if (meta.firstUserText) return meta.firstUserText;
  return "(无标题)";
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatList(metas: SessionMeta[]): string {
  if (metas.length === 0) return "没有找到任何会话。";
  const header = `会话 ${metas.length} 个（按最近修改排序）`;
  const rows = metas.map((m) => {
    const id = (m.id || m.file).slice(0, 8);
    return `  ${id}  ${formatLocalTime(m.modifiedAt)}  ${formatBytes(m.sizeBytes)}  ${m.model || "-"}  ` +
      `${oneLine(sessionTitle(m), 50)} · ${m.cwd || "(未知目录)"}`;
  });
  return [header, ...rows].join("\n");
}

export function formatSearch(hits: SearchHit[]): string {
  if (hits.length === 0) return "没有命中的会话。";
  const rows: string[] = [`命中 ${hits.length} 个会话`];
  for (const hit of hits) {
    rows.push(`  ${(hit.meta.id || hit.meta.file).slice(0, 8)}  ${hit.hits} 处  ${oneLine(sessionTitle(hit.meta), 40)} · ${hit.meta.cwd || "(未知目录)"}`);
    for (const snippet of hit.snippets) rows.push(`      ${snippet}`);
  }
  return rows.join("\n");
}

export function formatPreview(preview: SessionPreview): string {
  const m = preview.meta;
  const rows = [
    `会话 ${m.id}  ${sessionTitle(m)}`,
    `  目录：${m.cwd || "(未知目录)"}`,
    `  模型：${m.model || "-"}`,
    `  消息：用户 ${m.userMessages} · 助手 ${m.assistantMessages} · 工具 ${m.toolResults} · ${formatBytes(m.sizeBytes)}`,
    `  修改：${formatLocalTime(m.modifiedAt)}`,
    `  文件：${m.path}`,
    `  接续：${preview.resumeCommand}`,
    `  分支：${preview.forkCommand}`,
  ];
  if (m.parentSession) rows.push(`  来源：${m.parentSession}`);
  if (preview.tail.length > 0) {
    rows.push("  最近消息：");
    for (const line of preview.tail) rows.push(`    [${line.role}] ${line.text}`);
  }
  return rows.join("\n");
}

/** 会话根目录推断：默认会话目录是 `<根>/--<encoded-cwd>--` 时取父目录；自定义目录原样使用。 */
export function sessionRootOf(sessionDir: string): string {
  const name = basename(sessionDir);
  return name.startsWith("--") && name.endsWith("--") ? dirname(sessionDir) : sessionDir;
}
