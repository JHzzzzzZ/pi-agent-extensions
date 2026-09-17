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
 *   - 时间戳（含 v2 的 alignedAt）ISO 字符串或 null（迁移的历史条目为 null，不回填假数据）。
 *
 * schema v2（todo-cli-todo:11 对齐门）：状态五态 open/aligning/aligned/processing/done，
 * 条目新增 alignedAt。历史兼容口径（当时读 v1 写 v2，现由 v4 段落统一接管）：parseTodoJson
 * 读入时在内存里归一成当前版本（v1 的 alignedAt 视为 null）；任一写操作重写整文件 =>
 * 该文件一次性升级，不做批量回填。旧版 CLI 读新版文件会明确报错（回滚路径见 ADR-0003）。
 *
 * schema v3（todo-cli-todo:10 依赖门）：条目新增 dependsOn（规范引用 `文件基名#id`，可跨文件，
 * 保序去重由写入方保证）。兼容口径（现由 v4 段落统一接管）：读 1|2|3 归一成当前版本
 * （旧版缺 dependsOn 视为 []）；v1/v2 文件被写一次即整体升版。schema 层不校验引用存在性/环——
 * 那是 depends.ts 的职责（这里只管字段形态）。
 *
 * schema v4（todo-cli-todo:16 统一全局 id）：条目新增 globalId（全台账唯一、永不回收的统一主键，
 * 计数器与写门禁在 globalid.ts/core.ts）。兼容口径：读 1|2|3|4 都归一成 4，写出一律 4；
 * v4 条目的 globalId 是必填正整数（缺失/非正整数即结构损坏，fail-closed）；v1-v3 缺字段归一为
 * null（未迁移的瞬态形态），出现则须为正整数（合并产物/手写混入也保全）。null 只在「读旧版文件」
 * 路径产生，落盘路径受 core 的 GLOBAL_ID_PENDING 门禁保护，永远写不出 v4+null。
 */

export const ENTRY_STATUSES = ["open", "aligning", "aligned", "processing", "done"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** 持久 schema 当前版本：写出一律此版本；读兼容 1 / 2 / 3。 */
export type TodoFileVersion = 1 | 2 | 3 | 4;

/** 单条待办：schema v4 的完整字段集（原生字段，无 rawText）。 */
export interface TodoEntry {
  /** 文件内稳定 id（max+1 分配，永不复用/重排）。 */
  id: number;
  /** 全台账唯一、永不回收的全局主键（v4 必填正整数；读 v1-v3 未迁移条目为 null）。 */
  globalId: number | null;
  /** 纯需求描述，不含标注括号内容。 */
  text: string;
  status: EntryStatus;
  /** claim --branch 写入的分支引用；triage 与 worktree 精确相等映射。 */
  branch: string | null;
  /** 标签（add --tag 写入，list --tag 精确匹配）。 */
  tags: string[];
  /** 依赖引用（规范形态 `文件基名#id`，可跨文件，保序）：被引用条目未 done 则本条目不得开工。 */
  dependsOn: string[];
  /** 注记池：完成备注、迁移的历史标注、缩进子行，保序。 */
  notes: string[];
  createdAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  /** 人工对齐确认时间（align 写入）；未确认/历史条目为 null。 */
  alignedAt: string | null;
}

/** 单个 todo 文件的持久形态（`todos/<名>.json` 的 JSON 根对象）。 */
export interface TodoFileData {
  version: 4;
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
function validateEntry(value: unknown, label: string, version: TodoFileVersion): string | null {
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
  // v3 的 dependsOn 是必填原生字段；v1/v2 无此字段（读入时归一为 []）。
  if (version >= 3 && stringArray(value.dependsOn) === undefined) return "条目 dependsOn 必须是字符串数组";
  // v2 的 alignedAt 是必填原生字段；v1 无此字段（读入时归一为 null）。
  if (version >= 2 && stringOrNull(value.alignedAt) === undefined) return "条目 alignedAt 必须是字符串或 null";
  // v4 的 globalId 是必填正整数（结构损坏先例：v3 缺 dependsOn 即拒绝）；
  // v1-v3 可选，但出现就须为正整数（保合并产物/手写混入）。
  if (value.globalId === undefined) {
    if (version >= 4) return "条目 globalId 必须是正整数";
  } else if (typeof value.globalId !== "number" || !Number.isInteger(value.globalId) || value.globalId < 1) {
    return "条目 globalId 必须是正整数";
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
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) return badSchema(label, "version 必须是 1、2、3 或 4");
  if (typeof parsed.title !== "string") return badSchema(label, "title 必须是字符串");
  if (!Array.isArray(parsed.entries)) return badSchema(label, "entries 必须是数组");
  const version: TodoFileVersion = parsed.version;
  const entries: TodoEntry[] = [];
  for (const raw of parsed.entries) {
    const reason = validateEntry(raw, label, version);
    if (reason !== null) return badSchema(label, reason);
    const record = raw as Record<string, unknown>;
    entries.push({
      id: record.id as number,
      // v4 保证是正整数；v1-v3 出现即正整数，缺失归一 null（未迁移的瞬态）。
      globalId: typeof record.globalId === "number" ? record.globalId : null,
      text: record.text as string,
      status: record.status as EntryStatus,
      branch: stringOrNull(record.branch) ?? null,
      tags: stringArray(record.tags) ?? [],
      dependsOn: version >= 3 ? (stringArray(record.dependsOn) ?? []) : [],
      notes: stringArray(record.notes) ?? [],
      createdAt: stringOrNull(record.createdAt) ?? null,
      claimedAt: stringOrNull(record.claimedAt) ?? null,
      completedAt: stringOrNull(record.completedAt) ?? null,
      alignedAt: version >= 2 ? (stringOrNull(record.alignedAt) ?? null) : null,
    });
  }
  return { ok: true, data: { version: 4, title: parsed.title, entries } };
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

/** 新建 todo 文件的空数据（title 沿旧 add 的 `# <名> TODO` 约定；v4 写下）。 */
export function emptyTodoData(name: string): TodoFileData {
  return { version: 4, title: `${name} TODO`, entries: [] };
}

/**
 * todo 文件名归一：`x` / `x-todo` / `x-todo.json` / `x-todo.md` → `x-todo`（无扩展名）。
 * 拒绝穿越（`/`、`\\`、`..`）与空串。两个消费方：core 的 resolveTodoPath（路径解析）与
 * depends 的引用解析（`x#3` → `x-todo#3`）——同一口径，避免「登记写全名、依赖写短名」分叉。
 */
export function normalizeTodoName(nameOrFile: string): string | null {
  const clean = String(nameOrFile).trim();
  if (clean === "" || clean.includes("/") || clean.includes("\\") || clean.includes("..")) return null;
  if (clean.endsWith(".json")) return clean.slice(0, -5);
  if (clean.endsWith(".md")) return clean.slice(0, -3);
  return clean.endsWith("-todo") ? clean : `${clean}-todo`;
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
