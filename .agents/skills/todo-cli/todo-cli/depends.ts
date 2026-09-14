/**
 * todo-cli/depends.ts — 依赖引用与依赖图的纯函数层（todo-cli-todo:10 依赖门；决策见 ADR-0005）。
 *
 * 进出只有两种形态：规范引用字符串（`文件基名#id`）与条目投影
 * （file/id/status/dependsOn）。零 IO——不 import fs/lock/core，引用归一、环检测、
 * 阻塞判定都能在无文件系统环境下单独验证（测试见 test/depends.test.ts）。
 *
 * 三个消费方：
 *   - 写入路径（`add --dep` / `dep add`）用 checkDepWrite 在落盘前拒绝悬空/自引用/环；
 *   - 开工门（第二次 claim）用 blockingDeps 判定「在等谁」，非空即 fail-closed；
 *   - lint 用 findDepProblems 对全量台账兜底——跨分支合并能造出写路径没见过的图。
 *
 * 语义（ADR-0005）：依赖是一维直接约束（只报直接依赖的未完成状态，不展开下游）；
 * 目标 done 即解锁（含取消/搁置收口）；悬空引用按阻塞处理（前提无法证明 ⇒ 不开工），
 * 提示里标「不存在」。schema 层只管 dependsOn 的字段形态，存在性与环都在这里判。
 */

import { normalizeTodoName } from "./schema.ts";
import type { EntryStatus } from "./schema.ts";

/** 依赖引用：file 为 todo 文件基名（无 `.json`），id 为文件内稳定编号。 */
export interface DepRef {
  file: string;
  id: number;
}

/** 依赖图的节点投影（core 从全部 `todos/*.json` 拼出）。 */
export interface DepEntry {
  file: string;
  id: number;
  status: EntryStatus;
  dependsOn: string[];
}

export const DepProblemCodes = { notFound: "DEP_NOT_FOUND", self: "DEP_SELF", cycle: "DEP_CYCLE" } as const;
export type DepProblemCode = (typeof DepProblemCodes)[keyof typeof DepProblemCodes];

export interface DepProblem {
  /** 引用方（规范引用）。 */
  owner: string;
  code: DepProblemCode;
  /** 静态形态：缺失的引用 / 自引用本身 / 环路径（`a#1 → b#2 → a#1`）——不含用户自由文本。 */
  detail: string;
}

/** 规范引用：`文件基名#id`。 */
export function formatDepRef(ref: DepRef): string {
  return `${ref.file}#${ref.id}`;
}

/**
 * 解析 `名字#id`：名字接受与 `--file` 同口径的四种写法（`x` / `x-todo` / `x-todo.json` /
 * `x-todo.md`，归一为文件基名），id 必须是正整数；非法（无 `#`、id 非数字/为 0/带后缀、
 * 名字含路径）返回 null——调用方 fail-closed，不做「尽力解释」。
 */
export function parseDepRef(input: string): DepRef | null {
  const text = String(input).trim();
  const cut = text.lastIndexOf("#");
  if (cut <= 0) return null;
  const file = normalizeTodoName(text.slice(0, cut));
  const idText = text.slice(cut + 1).trim();
  if (file === null || !/^\d+$/.test(idText)) return null;
  const id = Number(idText);
  return id < 1 ? null : { file, id };
}

/** 归一为存储形态（规范引用）；非法返回 null。 */
export function normalizeDepRef(input: string): string | null {
  const ref = parseDepRef(input);
  return ref === null ? null : formatDepRef(ref);
}

/** 条目投影索引：规范引用 → 条目（同文件同 id 重复出现时以先到者为准）。 */
function indexEntries(entries: DepEntry[]): Map<string, DepEntry> {
  const index = new Map<string, DepEntry>();
  for (const entry of entries) {
    const key = formatDepRef(entry);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/** 稳定排序：file 升序 → id 升序（与 list / summary 同口径）。 */
function sortEntries(entries: DepEntry[]): DepEntry[] {
  return [...entries].sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.id - b.id));
}

/** 依赖图（只含存在的节点与边；自引用边排除——自引用单独归类为 DEP_SELF）。 */
function buildGraph(entries: DepEntry[], override?: { key: string; dependsOn: string[] }): Map<string, string[]> {
  const index = indexEntries(entries);
  const graph = new Map<string, string[]>();
  const edges = (key: string, dependsOn: string[]) => dependsOn.filter((ref) => ref !== key && index.has(ref));
  for (const entry of entries) {
    const key = formatDepRef(entry);
    graph.set(key, edges(key, override !== undefined && override.key === key ? override.dependsOn : entry.dependsOn));
  }
  if (override !== undefined && !graph.has(override.key)) graph.set(override.key, edges(override.key, override.dependsOn));
  return graph;
}

/** 从 start 出发找一条回到 target 的路径（含两端）；无路径返回 null。 */
function findPathTo(start: string, target: string, graph: Map<string, string[]>): string[] | null {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  const walk = (node: string): string[] | null => {
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (next === target) return [...stack, target];
      if (onStack.has(next) || done.has(next)) continue;
      const found = walk(next);
      if (found !== null) return found;
    }
    stack.pop();
    onStack.delete(node);
    done.add(node);
    return null;
  };
  return walk(start);
}

/** DFS 三色找环：每条回边报一个环，路径从回边起点收口回自身。 */
function findCycles(entries: DepEntry[]): DepProblem[] {
  const graph = buildGraph(entries);
  const state = new Map<string, "gray" | "black">();
  const stack: string[] = [];
  const problems: DepProblem[] = [];
  const visit = (node: string): void => {
    state.set(node, "gray");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const color = state.get(next);
      if (color === "gray") {
        problems.push({ owner: next, code: DepProblemCodes.cycle, detail: [...stack.slice(stack.indexOf(next)), next].join(" → ") });
      } else if (color === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "black");
  };
  for (const entry of sortEntries(entries)) {
    const key = formatDepRef(entry);
    if (!state.has(key)) visit(key);
  }
  return problems;
}

/**
 * 写入期校验：候选条目的 dependsOn（已归一）逐个检查目标存在、非自身、不成环。
 * 候选条目自身的边按新值替换（写语义 = 覆盖）。返回全部问题清单，空即通过。
 */
export function checkDepWrite(
  candidate: { file: string; id: number; dependsOn: string[] },
  entries: DepEntry[],
): DepProblem[] {
  // 快路径：无依赖（绝大多数登记）不建图——依赖校验不得给普通写路径（锁临界区）加成本。
  if (candidate.dependsOn.length === 0) return [];
  const index = indexEntries(entries);
  const key = formatDepRef({ file: candidate.file, id: candidate.id });
  const graph = buildGraph(entries, { key, dependsOn: candidate.dependsOn });
  const problems: DepProblem[] = [];
  for (const ref of candidate.dependsOn) {
    if (ref === key) {
      problems.push({ owner: key, code: DepProblemCodes.self, detail: ref });
      continue;
    }
    if (!index.has(ref)) {
      problems.push({ owner: key, code: DepProblemCodes.notFound, detail: ref });
      continue;
    }
    const path = findPathTo(ref, key, graph);
    if (path !== null) problems.push({ owner: key, code: DepProblemCodes.cycle, detail: [key, ...path].join(" → ") });
  }
  return problems;
}

/** 全量台账扫描：悬空引用 / 自引用 / 依赖环（供 lint）；顺序 = owner 稳定序 + 环后置。 */
export function findDepProblems(entries: DepEntry[]): DepProblem[] {
  const index = indexEntries(entries);
  const problems: DepProblem[] = [];
  for (const entry of sortEntries(entries)) {
    const owner = formatDepRef(entry);
    for (const ref of entry.dependsOn) {
      if (ref === owner) problems.push({ owner, code: DepProblemCodes.self, detail: ref });
      else if (!index.has(ref)) problems.push({ owner, code: DepProblemCodes.notFound, detail: ref });
    }
  }
  problems.push(...findCycles(entries));
  return problems;
}

/**
 * 单条判据：直接依赖里未完成的部分（顺序沿用 dependsOn）；目标不存在时 status 为 null。
 * 非空即该条目被阻塞——开工门与 list 标记的唯一判据。
 */
export function blockingDeps(
  entry: { dependsOn: string[] },
  entries: DepEntry[],
): Array<{ ref: string; status: EntryStatus | null }> {
  return blockingOf(entry, indexEntries(entries));
}

function blockingOf(
  entry: { dependsOn: string[] },
  index: Map<string, DepEntry>,
): Array<{ ref: string; status: EntryStatus | null }> {
  const blocking: Array<{ ref: string; status: EntryStatus | null }> = [];
  for (const ref of entry.dependsOn) {
    const target = index.get(ref);
    if (target === undefined) blocking.push({ ref, status: null });
    else if (target.status !== "done") blocking.push({ ref, status: target.status });
  }
  return blocking;
}

/**
 * 全量判据：规范引用 → 未完成的直接依赖引用清单（空 = 可开工）。一次建索引（O(n)），
 * 供 list 投影用——逐条调 blockingDeps 是 O(n²)（台账规模上来后可见）。
 */
export function blockedByMap(entries: DepEntry[]): Map<string, string[]> {
  const index = indexEntries(entries);
  const map = new Map<string, string[]>();
  for (const entry of entries) map.set(formatDepRef(entry), blockingOf(entry, index).map((item) => item.ref));
  return map;
}

/** 反查直接依赖 ref 的未完成条目（complete 提示用），稳定排序。 */
export function dependentsOf(ref: string, entries: DepEntry[]): DepEntry[] {
  return sortEntries(entries.filter((entry) => entry.status !== "done" && entry.dependsOn.includes(ref)));
}
