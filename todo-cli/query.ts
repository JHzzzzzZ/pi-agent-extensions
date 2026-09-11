/**
 * todo-cli/query.ts — L15 元数据化筛选查询的纯函数层（10-design §3.1，W2 白名单文件）。
 *
 * 输入只有文本派生的条目与过滤条件，输出只有行对象/字符串：不 import
 * node:fs / node:sqlite / store / migrate / core，保证查询逻辑可在无数据库、
 * 无文件系统的环境下单独验证。statusMark 与 parseBranchRef 两处口径独立于
 * core 实现，与 core.STATUS_MARK / core.PROCESSING_REF_RE 保持一致（W4 以
 * 对照测试锁定）；时间戳三字段由 store 的 DB 列填充，markdown 派生路径恒为
 * null（10-design §2.1 字段来源表）。
 *
 * 人读行格式与今日 list 输出字节一致：`${statusMark} ${file}:${line}  ${text}`
 * （`file` 为去 `.md` 的归属名，`line` 为 1-based 行号，行号与文本间两空格）。
 */

/** 条目三态：与 core.parseTodoFile 的 status 口径一致。 */
export type EntryStatus = "open" | "processing" | "done";

/** 查询行对象：文本派生字段（file/line/status/text/branch/tags）+ DB 时间戳列。 */
export interface QueryEntry {
  /** 归属文件名，无 `.md`（如 `general-todo`）。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  status: EntryStatus;
  /** 条目全文，含 `（processing…）`/`（完成…）` 标注，不做转义。 */
  text: string;
  /** 派生：`@` 分支引用（PROCESSING_REF_RE 口径）；无则 null。 */
  branch: string | null;
  /** 派生：`#词` 标签，保序去重；无 DB 亦可得到。 */
  tags: string[];
  /** DB 列：首次导入/登记时刻；markdown 派生时 null。 */
  createdAt: string | null;
  /** DB 列：claim 写入时刻；markdown 派生时 null。 */
  claimedAt: string | null;
  /** DB 列：complete 写入时刻；markdown 派生时 null。 */
  completedAt: string | null;
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

/** 与 core.STATUS_MARK 同表：done→`[x]` processing→`[~]` open→`[ ]`（core 私有常量不动，此处独立实现）。 */
const STATUS_MARKS: Record<EntryStatus, string> = { done: "[x]", processing: "[~]", open: "[ ]" };

/** 状态标记：人读行首列。 */
export function statusMark(status: EntryStatus): string {
  return STATUS_MARKS[status];
}

/** 分支引用探针：口径 = core.PROCESSING_REF_RE（首个捕获组，遇全/半角冒号逗号与右括号截断）。 */
const BRANCH_REF_RE = /@\s*([^\s：:，,）)]+)/;

/** 分支引用派生：`/@\s*([^\s：:，,）)]+)/` 首个捕获组；无则 null。 */
export function parseBranchRef(text: string): string | null {
  const match = BRANCH_REF_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * `#词` 词法：`/(^|[\s（(])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu`，保序去重。
 * 每次新建正则实例，避免 `/g` 的 lastIndex 状态在多次调用间泄漏。
 */
export function parseTags(text: string): string[] {
  const tagRe = /(^|[\s（(])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
  const tags: string[] = [];
  for (const match of text.matchAll(tagRe)) {
    const tag = match[2];
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** parseTodoFile 输出 → QueryEntry（时间戳三字段恒 null；branch/tags 派生）。 */
export function deriveQueryEntries(
  fileName: string,
  entries: Array<{ line: number; status: EntryStatus; text: string }>,
): QueryEntry[] {
  return entries.map((entry) => ({
    file: fileName,
    line: entry.line,
    status: entry.status,
    text: entry.text,
    branch: parseBranchRef(entry.text),
    tags: parseTags(entry.text),
    createdAt: null,
    claimedAt: null,
    completedAt: null,
  }));
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

/** file 升序（UTF-16 码元比较，与 readdirSync 排序口径一致）→ line 升序；返回新数组。 */
export function sortQueryEntries(entries: QueryEntry[]): QueryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

/**
 * json=true → `[JSON.stringify(sorted, null, 2)]`（整体一行交给 log）；否则每条
 * `${statusMark(s)} ${file}:${line}  ${text}`（与今日 list 人读行字节一致）。
 * 输出前复用 sortQueryEntries 的稳定排序，任何输入序下都与 list 排序字节一致。
 */
export function serializeEntries(entries: QueryEntry[], opts: { json: boolean }): string[] {
  const sorted = sortQueryEntries(entries);
  if (opts.json) return [JSON.stringify(sorted, null, 2)];
  return sorted.map((entry) => `${statusMark(entry.status)} ${entry.file}:${entry.line}  ${entry.text}`);
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
 * main 的 parseArgs 产物 → filter + json。仅校验 `--claimed-since`（格式 + 真实日期），
 * 失败返回 `{ok:false, code:"BAD_FILTER", message:"--claimed-since 需要 YYYY-MM-DD 日期"}`
 * （静态模板）；其余值不校验（沿旧语义，非法 status 由 applyEntryFilter 给空结果）。
 */
export function parseFilterOptions(
  opts: Record<string, unknown>,
): { ok: true; filter: EntryFilter; json: boolean } | { ok: false; code: "BAD_FILTER"; message: string } {
  const claimedSince = opts["claimed-since"];
  if (claimedSince !== undefined && (typeof claimedSince !== "string" || !isValidDate(claimedSince))) {
    return { ok: false, code: "BAD_FILTER", message: BAD_CLAIMED_SINCE };
  }

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

  return { ok: true, filter, json: opts.json === true };
}
