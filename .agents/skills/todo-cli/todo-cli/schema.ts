/**
 * todo-cli/schema.ts — todos JSON 存储的 schema 层（方案 C，todos/todo-cli-todo.md:17）
 *
 * 方案 C 之后 `todos/<名>.json` 是唯一持久真相（markdown 已退出，CLI 是唯一读写入口）。
 * 本模块只做 schema 的纯函数：解析+校验（fail-closed，损坏/合并冲突文件明确报错）、
 * 序列化（两空格缩进 + LF 尾换行，配 .gitattributes `todos/*.json text eol=lf` 防整文件
 * diff）、nextId（文件内 max+1 永不复用——append-only + 稳定 id 是分支合并冲突手工
 * 解析约定的一半，另一半写在 AGENTS.md 红线 2）。
 *
 * 字段口径（L17「状态/文本/注记/分支引用/标签/三时间戳为原生字段」）：
 *   - text 是纯需求描述，不含任何 `（processing…）`/`（完成…）` 标注；
 *   - 标注进 notes（注记与缩进子行同池，保序）；branch/tags 为结构化字段；
 *   - 三时间戳 ISO 字符串或 null（迁移的历史条目为 null，不回填假数据）。
 */

export const ENTRY_STATUSES = ["open", "processing", "done"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** 单条待办：schema v1 的完整字段集（原生字段，无 rawText——L17 待决策② 已定）。 */
export interface TodoEntry {
  /** 文件内稳定 id（max+1 分配，永不复用/重排）。 */
  id: number;
  /** 纯需求描述，不含标注括号内容。 */
  text: string;
  status: EntryStatus;
  /** claim --branch 写入的分支引用；triage 与 worktree 精确相等映射。 */
  branch: string | null;
  /** 标签（add --tag 写入，list --tag 精确匹配）。 */
  tags: string[];
  /** 注记池：完成备注、迁移的历史标注、缩进子行，保序。 */
  notes: string[];
  createdAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
}

/** 单个 todo 文件的持久形态（`todos/<名>.json` 的 JSON 根对象）。 */
export interface TodoFileData {
  version: 1;
  /** md 时代文件头标题（迁移保真；新建文件 = `<名> TODO`）。 */
  title: string;
  entries: TodoEntry[];
}

export type ParseTodoResult =
  | { ok: true; data: TodoFileData }
  | { ok: false; code: "BAD_JSON" | "BAD_SCHEMA"; message: string };

const BAD_JSON_PREFIX = "todo 文件不是合法 JSON";
const BAD_SCHEMA_PREFIX = "todo 文件结构不合法";

function badJson(label: string, conflict: boolean): { ok: false; code: "BAD_JSON"; message: string } {
  const suffix = conflict ? "（可能存在未解决的合并冲突）" : "";
  return { ok: false, code: "BAD_JSON", message: `${BAD_JSON_PREFIX}${suffix}：${label}` };
}

function badSchema(label: string, reason: string): { ok: false; code: "BAD_SCHEMA"; message: string } {
  return { ok: false, code: "BAD_SCHEMA", message: `${BAD_SCHEMA_PREFIX}（${reason}）：${label}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** 单条条目校验；返回错误 reason（静态模板）或 null。未知字段忽略（向前兼容）。 */
function validateEntry(value: unknown, label: string): string | null {
  if (!isRecord(value)) return "条目必须是对象";
  if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id < 1) return "条目 id 必须是正整数";
  if (typeof value.text !== "string") return "条目缺 text 字段";
  if (typeof value.status !== "string" || !ENTRY_STATUSES.includes(value.status as EntryStatus)) return "条目 status 非法";
  if (stringOrNull(value.branch) === undefined) return "条目 branch 必须是字符串或 null";
  if (stringArray(value.tags) === undefined) return "条目 tags 必须是字符串数组";
  if (stringArray(value.notes) === undefined) return "条目 notes 必须是字符串数组";
  for (const field of ["createdAt", "claimedAt", "completedAt"] as const) {
    if (stringOrNull(value[field]) === undefined) return `条目 ${field} 必须是字符串或 null`;
  }
  if (label === "") return "缺少文件标签";
  return null;
}

/**
 * 解析并校验一个 todo JSON 文件内容。任何损坏（非法 JSON / 合并冲突标记 / 字段缺失
 * 或类型错误）都返回明确失败——绝不猜、绝不静默修复（JSON 是权威，修不好就该停下）。
 */
export function parseTodoJson(content: string, label: string): ParseTodoResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const conflict = /<{7}|>{7}|={7}/.test(content);
    void error;
    return badJson(label, conflict);
  }
  if (!isRecord(parsed)) return badJson(label, false);
  if (parsed.version !== 1) return badSchema(label, "version 必须是 1");
  if (typeof parsed.title !== "string") return badSchema(label, "title 必须是字符串");
  if (!Array.isArray(parsed.entries)) return badSchema(label, "entries 必须是数组");
  const entries: TodoEntry[] = [];
  for (const raw of parsed.entries) {
    const reason = validateEntry(raw, label);
    if (reason !== null) return badSchema(label, reason);
    const record = raw as Record<string, unknown>;
    entries.push({
      id: record.id as number,
      text: record.text as string,
      status: record.status as EntryStatus,
      branch: stringOrNull(record.branch) ?? null,
      tags: stringArray(record.tags) ?? [],
      notes: stringArray(record.notes) ?? [],
      createdAt: stringOrNull(record.createdAt) ?? null,
      claimedAt: stringOrNull(record.claimedAt) ?? null,
      completedAt: stringOrNull(record.completedAt) ?? null,
    });
  }
  return { ok: true, data: { version: 1, title: parsed.title, entries } };
}

/** 序列化：两空格缩进 + LF + 尾换行（git 可 diff 的规范形态）。 */
export function serializeTodo(data: TodoFileData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 文件内下一个 id：max+1（空文件从 1 起；id 永不复用，缺口保留）。 */
export function nextId(entries: TodoEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    if (entry.id > max) max = entry.id;
  }
  return max + 1;
}

/** 新建 todo 文件的空数据（title 沿旧 add 的 `# <名> TODO` 约定）。 */
export function emptyTodoData(name: string): TodoFileData {
  return { version: 1, title: `${name} TODO`, entries: [] };
}

/**
 * 条目文本归一化：去掉标注括号、空白与句读，转小写——"同一需求换个说法"要能撞上。
 * 两个消费方：add 跨文件查重（core）与迁移时的旧索引时间戳回填匹配（migrate），
 * 因此放在 schema 层避免 core↔migrate 循环依赖。
 */
export function normalizeText(text: string): string {
  return String(text)
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[。！？!?.,，、;；:：]/g, "")
    .toLowerCase();
}
