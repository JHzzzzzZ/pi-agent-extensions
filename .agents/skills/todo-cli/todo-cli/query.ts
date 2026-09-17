/**
 * todo-cli/query.ts — list 结构化查询的纯函数层（方案 C 适配，todos/todo-cli-todo.md:17）。
 *
 * 输入只有 JSON 条目的投影与过滤条件，输出只有行对象/字符串：不 import fs / lock /
 * migrate / core，保证查询逻辑可在无文件系统环境下单独验证。方案 C 后 branch/tags/
 * 三时间戳都是 schema 原生字段，不再有「文本派生 vs DB 列」双口径，也没有降级路径。
 *
 * 人读行格式：`${statusMark} ${file}#${id}  [p${priority}] ${text}`（file 为去 `.json` 的归属名，
 * id 为文件内稳定编号，id 与文本间两空格；priority 标记由 todo-cli-todo:15 引入，不零填充）；
 * 标记五态见 STATUS_MARKS；阻塞条目行尾追加 `（阻塞：等待 <引用清单>）`（todo-cli-todo:10）——
 * 阻塞与否由 core 算好（blockedBy 非空），query 层不查台账、不解析依赖图。
 * `--sort priority`（todo-cli-todo:15）是首个排序选项：priority 降序 → 默认序（file → id）。
 */

import type { EntryStatus } from "./schema.ts";

/** 查询行对象：JSON 条目的查询投影（无派生字段——branch/tags 原生）。 */
export interface QueryEntry {
  /** 归属文件名，无 `.json`（如 `general-todo`）。 */
  file: string;
  /** 文件内稳定 id。 */
  id: number;
  status: EntryStatus;
  /** 纯需求描述（不含标注；标注在 notes，不参与 --text/--match 匹配）。 */
  text: string;
  branch: string | null;
  tags: string[];
  /** 优先级 1-10（10 最高；schema 层保证内存态必有，缺失已兜底 5）。 */
  priority: number;
  /** 原生依赖引用（规范形态 `文件基名#id`，保序）。 */
  dependsOn: string[];
  /** 派生：未完成的直接依赖引用（空 = 可开工）；非空即阻塞。只有一个派生字段，不另设布尔位。 */
  blockedBy: string[];
  createdAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  alignedAt: string | null;
}

/** AND 组合过滤条件：未设字段不参与过滤；非法 status 沿旧 list 语义给空结果。 */
export interface EntryFilter {
  /** 精确匹配；非法值 → 空结果（同旧 `list --status` 语义，不报错）。 */
  status?: EntryStatus;
  /** 已归一 name（`general-todo`）；core 负责从 `--file` 归一。 */
  file?: string;
  /** 子串包含（`entry.branch !== null && entry.branch.includes(v)`）。 */
  branch?: string;
  /** tags 数组精确包含。 */
  tag?: string;
  /** `entry.text` 子串包含。 */
  text?: string;
  /** `YYYY-MM-DD`：`claimedAt !== null && claimedAt.slice(0, 10) >= v`。 */
  claimedSince?: string;
}

const STATUS_MARKS: Record<EntryStatus, string> = {
  done: "[x]",
  processing: "[~]",
  aligned: "[>]",
  aligning: "[?]",
  open: "[ ]",
};

/** 状态标记：人读行首列。 */
export function statusMark(status: EntryStatus): string {
  return STATUS_MARKS[status];
}

/** AND 组合过滤；保持输入序（排序由 sortQueryEntries 单独负责）。全字段 undefined → 原样返回。 */
export function applyEntryFilter(entries: QueryEntry[], filter: EntryFilter): QueryEntry[] {
  const { status, file, branch, tag, text, claimedSince } = filter;
  const hasFilter =
    status !== undefined ||
    file !== undefined ||
    branch !== undefined ||
    tag !== undefined ||
    text !== undefined ||
    claimedSince !== undefined;
  if (!hasFilter) return entries;
  return entries.filter(
    (entry) =>
      (status === undefined || entry.status === status) &&
      (file === undefined || entry.file === file) &&
      (branch === undefined || (entry.branch !== null && entry.branch.includes(branch))) &&
      (tag === undefined || entry.tags.includes(tag)) &&
      (text === undefined || entry.text.includes(text)) &&
      (claimedSince === undefined || (entry.claimedAt !== null && entry.claimedAt.slice(0, 10) >= claimedSince)),
  );
}

/** file 升序（UTF-16 码元比较，与 readdirSync 排序口径一致）→ id 升序；返回新数组。 */
export function sortQueryEntries(entries: QueryEntry[]): QueryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.id - b.id;
  });
}

/** `--sort priority`：priority 降序 → file 升序 → 文件内 id 升序（同值桶 = 默认序）；返回新数组。 */
export function sortByPriority(entries: QueryEntry[]): QueryEntry[] {
  // 先按默认序排、再以 priority 降序做稳定 sort：同值桶天然回落 file → id 序（ES2019 起 sort 稳定）。
  return sortQueryEntries(entries).sort((a, b) => b.priority - a.priority);
}

/**
 * json=true → `[JSON.stringify(sorted, null, 2)]`（整体一行交给 log）；否则每条
 * `${statusMark(s)} ${file}#${id}  [p${priority}] ${text}`，阻塞条目再追加
 * ` （阻塞：等待 a#1, b#2）`（非阻塞部分字节不变）。输出前按 opts.sort 统一排序
 * （缺省走 sortQueryEntries），任何输入序下与 list 排序一致。
 */
export function serializeEntries(entries: QueryEntry[], opts: { json: boolean; sort?: "priority" }): string[] {
  const sorted = opts.sort === "priority" ? sortByPriority(entries) : sortQueryEntries(entries);
  if (opts.json) return [JSON.stringify(sorted, null, 2)];
  return sorted.map(
    (entry) =>
      `${statusMark(entry.status)} ${entry.file}#${entry.id}  [p${entry.priority}] ${entry.text}${
        entry.blockedBy.length > 0 ? ` （阻塞：等待 ${entry.blockedBy.join(", ")}）` : ""
      }`,
  );
}

const BAD_CLAIMED_SINCE = "--claimed-since 需要 YYYY-MM-DD 日期";

/** 真实日期校验：格式 `^\d{4}-\d{2}-\d{2}$` + 月份/天数存在（含闰年），不借 Date 规避 0–99 年偏移。 */
function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

/** 读取非空字符串选项：非字符串与空串视作未提供（沿旧 list 对 flag 值的真值语义）。 */
function readOption(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * main 的 parseArgs 产物 → filter + json + sort。仅校验 `--claimed-since`（格式 + 真实日期）
 * 与 `--sort`（只支持 `priority`），失败返回 `{ok:false, code:"BAD_FILTER", message:...}`
 * （静态模板）；其余值不校验（沿旧语义，非法 status 由 applyEntryFilter 给空结果）。
 */
export function parseFilterOptions(
  opts: Record<string, unknown>,
):
  | { ok: true; filter: EntryFilter; json: boolean; sort: "priority" | undefined }
  | { ok: false; code: "BAD_FILTER"; message: string } {
  const claimedSince = opts["claimed-since"];
  if (claimedSince !== undefined && (typeof claimedSince !== "string" || !isValidDate(claimedSince))) {
    return { ok: false, code: "BAD_FILTER", message: BAD_CLAIMED_SINCE };
  }
  // 空串（parseArgs 的缺值语义）也落此分支：不静默默认。
  const sort = opts.sort;
  if (sort !== undefined && sort !== "priority") return { ok: false, code: "BAD_FILTER", message: "--sort 只支持 priority" };

  const filter: EntryFilter = {};
  const status = readOption(opts, "status");
  if (status !== undefined) filter.status = status as EntryStatus;
  const file = readOption(opts, "file");
  if (file !== undefined) filter.file = file;
  const branch = readOption(opts, "branch");
  if (branch !== undefined) filter.branch = branch;
  const tag = readOption(opts, "tag");
  if (tag !== undefined) filter.tag = tag;
  const text = readOption(opts, "text");
  if (text !== undefined) filter.text = text;
  if (typeof claimedSince === "string") filter.claimedSince = claimedSince;

  return { ok: true, filter, json: opts.json === true, sort: sort === "priority" ? "priority" : undefined };
}
