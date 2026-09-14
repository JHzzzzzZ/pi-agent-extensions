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
 */

import * as path from "node:path";

/** 对齐文档必填的四个二级小节（顺序无关，各需一段非空正文）。 */
export const ALIGN_SECTIONS = ["意图", "范围", "验收标准", "人工确认"] as const;

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;

/** 仓库相对路径（消息与测试的规范形态，如 `todos/align/todo-cli-todo#11.md`）。 */
export function alignDocRelPath(name: string, id: number): string {
  return `todos/align/${name}#${id}.md`;
}

/** 绝对路径（调用方拿它做存在性检查与读取）。 */
export function alignDocPath(repoRoot: string, name: string, id: number): string {
  return path.join(repoRoot, "todos", "align", `${name}#${id}.md`);
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
