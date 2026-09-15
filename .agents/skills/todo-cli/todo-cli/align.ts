/**
 * todo-cli/align.ts — 对齐文档契约（纯函数，零 IO；todo-cli-todo:11 对齐门）
 *
 * 门的两半：状态迁移顺序由 core.ts 保证，**对齐文档的存在与结构**由本模块校验。
 * 路径固定派生 `todos/align/<文件基名>#<id>.md`——不接受自由路径参数，因此没有
 * 路径穿越面；文档必须出现 `<名>#<id>` 标记（防串条目复制）且四个二级小节各有一段
 * 非空正文。CLI 无法证明文档是人写的，也无法证明人工确认真实发生过；本模块只做
 * 机器可验证的结构约束，人工留痕靠 `## 人工确认` 小节 + 审批记录（见 ADR-0003）。
 *
 * 模板单源在 `docs/tools/todo-cli.md`；`claim` 只打印路径与小节名，不代建文件。
 *
 * `reopen`（todo-cli-todo:14，ADR-0007）把在途条目退回未领取时，用 `archiveStamp` +
 * `reopenArchivePath` 把陈旧对齐文档改名归档——规范路径腾空，重新 claim 必须重写新文档。
 */

import * as path from "node:path";

/** 对齐文档必填的四个二级小节（顺序无关，各需一段非空正文）。 */
export const ALIGN_SECTIONS = ["意图", "范围", "验收标准", "人工确认"] as const;

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;

/** 对齐文档的仓库相对路径（消息与测试的规范形态，如 `todos/align/todo-cli-todo#11.md`）。 */
export function alignDocRelPath(name: string, id: number): string {
  return `todos/align/${name}#${id}.md`;
}

/** 对齐文档的绝对路径（调用方拿它做存在性检查与读取）。 */
export function alignDocPath(repoRoot: string, name: string, id: number): string {
  return path.join(repoRoot, "todos", "align", `${name}#${id}.md`);
}

/**
 * reopen 归档时间戳：ISO 8601 → `YYYYMMDDTHHMMSSZ`（UTC 紧凑、无冒号——跨平台文件名安全）。
 * 非 ISO 输入退化为去掉非数字字符（`now()` 的契约是 ISO，此处只为保持函数全定义）。
 */
export function archiveStamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(iso));
  if (match === null) return String(iso).replace(/\D/g, "");
  return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}Z`;
}

/**
 * reopen 归档的仓库相对路径（todo-cli-todo:14）：规范路径腾空、旧留痕留同目录，
 * 后缀仍为 `.md`（命中 `.gitattributes` 的 `todos/align/*.md` LF 锁，不新增 pattern）。
 */
export function reopenArchiveRelPath(name: string, id: number, stamp: string): string {
  return `todos/align/${name}#${id}.reopened-${stamp}.md`;
}

/** 归档绝对路径（调用方做存在性检查与改名）。 */
export function reopenArchivePath(repoRoot: string, name: string, id: number, stamp: string): string {
  return path.join(repoRoot, "todos", "align", `${name}#${id}.reopened-${stamp}.md`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AlignDocTarget {
  /** todo 文件基名（无 `.json`），来自 resolveTodoPath 的结果。 */
  name: string;
  id: number;
}

export type AlignDocValidation = { ok: true } | { ok: false; missing: string[] };

/**
 * 结构校验：条目标记 + 四小节（各需非空正文）齐全才算通过；否则返回缺项清单
 * （顺序 = 条目标记 → ALIGN_SECTIONS 声明序，供静态消息拼接）。
 */
export function validateAlignDoc(content: string, target: AlignDocTarget): AlignDocValidation {
  const missing: string[] = [];

  // `(?!\d)` 边界：id=11 的状态不得被 `#112` 误命中，id=1 也不得被 `#11` 误命中。
  const marker = `${target.name}#${target.id}`;
  if (!new RegExp(`${escapeRegExp(marker)}(?!\\d)`, "u").test(content)) missing.push(marker);

  // 小节正文：二级标题开段，任何更高级标题（# / ##）收段；有非空行才算有正文。
  const bodies = new Map<string, boolean>();
  let current: string | null = null;
  for (const raw of String(content).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const heading = SECTION_HEADING_RE.exec(line);
    if (heading) {
      current = heading[1].trim();
      if (!bodies.has(current)) bodies.set(current, false);
      continue;
    }
    if (ANY_HEADING_RE.test(line)) {
      current = null;
      continue;
    }
    if (current !== null && line.trim() !== "") bodies.set(current, true);
  }
  for (const section of ALIGN_SECTIONS) {
    if (bodies.get(section) !== true) missing.push(`## ${section}`);
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
