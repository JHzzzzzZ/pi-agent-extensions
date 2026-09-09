/**
 * deep-init - Pi 深度初始化扩展(参考 oh-my-openagent init-deep SKILL.md)
 *
 * `/deep-init` 扫描仓库结构并生成层级 AGENTS.md 项目知识库:
 *   根 AGENTS.md(项目全貌)+ 按复杂度评分选出的子目录 AGENTS.md。
 * 本插件为提示词驱动薄封装:只做参数解析、已有文件预检、
 * `--create-new` 二次确认门控;四阶段重活(Discovery→Scoring→
 * Generate→Review)由主 agent 按下发的提示词用自身 read/bash/
 * edit/write 工具执行,不派子 pi 进程,不硬依赖 LSP/ast-grep。
 *
 * 用法:
 *   /deep-init                       update 模式:增量合并已有文件
 *   /deep-init --create-new          全量重建:先读后删(需 --yes 二次确认)
 *   /deep-init --max-depth=2         限制扫描/生成深度(默认 3,钳制 1–5)
 *   /deep-init --yes <path>          确认覆盖 + 指定目标目录(默认会话 cwd)
 *
 * 安装:复制本目录到 ~/.pi/agent/extensions/deep-init/ 或
 *       <项目>/.pi/extensions/deep-init/,在 Pi 中执行 /reload。
 * 测试:npm test / npm run typecheck
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ===== 常量 =====

export const DEEP_INIT_COMMAND = "deep-init";
/** 下发四阶段提示词的自定义消息类型 */
export const DEEP_INIT_START_MESSAGE = "deep-init-start";

export const DEFAULT_MAX_DEPTH = 3;
export const MIN_MAX_DEPTH = 1;
export const MAX_MAX_DEPTH = 5;
/** 目标路径过长则拒绝(静态阈值) */
export const MAX_TARGET_LENGTH = 256;
/** 提示词内回显的已有文件上限,超出截断 */
export const MAX_EXISTING_ECHO = 20;

export const USAGE = [
  "用法：",
  "  /deep-init                       update 模式：增量合并已有 AGENTS.md",
  "  /deep-init --create-new          全量重建：先读后删再生成（需加 --yes 确认）",
  "  /deep-init --max-depth=2         限制扫描/生成深度（默认 3，范围 1–5）",
  "  /deep-init --yes <path>          确认覆盖 + 指定目标目录（默认会话 cwd）",
].join("\n");

// ===== 类型 =====

export type DeepInitMode = "update" | "create-new";

export interface DeepInitOptions {
  mode: DeepInitMode;
  maxDepth: number;
  confirmed: boolean;
  target: string;
  showHelp: boolean;
}

export type ParseDeepInitArgs =
  | { ok: true; value: DeepInitOptions }
  | { ok: false; code: "bad-target"; message: string };

export type DispatchDecision =
  | { kind: "help"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "dispatch"; prompt: string; notice: string };

export interface PromptMeta {
  generatedAt: string;
  commit: string;
  branch: string;
}

export interface GeneratedFile {
  path: string;
  lines: number;
  action: "created" | "updated";
}

/** 文件系统注入端口(测试用 fake,运行时用 node:fs) */
export interface DirScanner {
  readDir(dir: string): string[] | undefined;
  isDirectory(path: string): boolean;
}

export interface DeepInitDeps {
  scanner?: DirScanner;
  cwd?: string;
  nowIso?: () => string;
  gitInfo?: (cwd: string) => { commit: string; branch: string };
}

// ===== 纯函数:参数解析 =====

export function clampDepth(value: unknown): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : (value as number);
  if (!Number.isFinite(n)) return DEFAULT_MAX_DEPTH;
  if (n < MIN_MAX_DEPTH) return MIN_MAX_DEPTH;
  if (n > MAX_MAX_DEPTH) return MAX_MAX_DEPTH;
  return Math.floor(n);
}

export function parseDeepInitArgs(args: string): ParseDeepInitArgs {
  const tokens = (args ?? "").split(/\s+/).filter((t) => t.length > 0);
  let mode: DeepInitMode = "update";
  let maxDepth = DEFAULT_MAX_DEPTH;
  let confirmed = false;
  let showHelp = false;
  let target = ".";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "--create-new") mode = "create-new";
    else if (t === "--yes") confirmed = true;
    else if (t === "--help" || t === "-h") showHelp = true;
    else if (t === "--max-depth" && i + 1 < tokens.length) {
      maxDepth = clampDepth(tokens[i + 1]);
      i++;
    } else if (t.startsWith("--max-depth=")) maxDepth = clampDepth(t.slice("--max-depth=".length));
    else if (!t.startsWith("--")) target = t;
  }
  if (target.length > MAX_TARGET_LENGTH) {
    return { ok: false, code: "bad-target", message: "目标路径过长，已拒绝。" };
  }
  return { ok: true, value: { mode, maxDepth, confirmed, target, showHelp } };
}

// ===== 纯函数:已有文件扫描 =====

const SKIP_DIRS = ["node_modules", ".git"] as const;

export function findExistingAgentsMd(scanner: DirScanner, root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; depth: number };
    if (current.depth > maxDepth) continue;
    const entries = scanner.readDir(current.dir);
    if (!entries) continue;
    for (const name of entries) {
      if ((SKIP_DIRS as readonly string[]).includes(name)) continue;
      const full = `${current.dir}/${name}`;
      if (name === "AGENTS.md" || name === "CLAUDE.md") {
        found.push(full);
        continue;
      }
      if (current.depth < maxDepth && scanner.isDirectory(full)) queue.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return found.sort();
}

/** --create-new 全量重建门控:已有文件时必须带 --yes */
export function resolveCreateGate(
  existing: string[],
  mode: DeepInitMode,
  confirmed: boolean,
): { ok: true } | { ok: false; code: "confirm-required"; message: string } {
  if (mode === "create-new" && existing.length > 0 && !confirmed) {
    return {
      ok: false,
      code: "confirm-required",
      message: `检测到 ${existing.length} 个已有知识文件，全量重建会先删除它们。请确认后重带 --yes 执行。`,
    };
  }
  return { ok: true };
}

// ===== 纯函数:提示词与报告 =====

function echoExisting(existing: string[]): string {
  if (existing.length === 0) return "（未发现，可直接生成）";
  const shown = existing.slice(0, MAX_EXISTING_ECHO);
  const rest = existing.length - shown.length;
  return [...shown.map((p) => `  - ${p}`), ...(rest > 0 ? [`  - …还有 ${rest} 处`] : [])].join("\n");
}

export function buildDeepInitPrompt(input: {
  mode: DeepInitMode;
  maxDepth: number;
  target: string;
  existing: string[];
  meta: PromptMeta;
}): string {
  const modeText = input.mode === "create-new" ? "create-new（先读后删，全量重建）" : "update（增量合并已有）";
  return [
    `# deep-init：为目标仓库生成层级 AGENTS.md`,
    ``,
    `模式：${modeText} · 最大深度：${input.maxDepth} · 目标：${input.target}`,
    `已有知识文件：`,
    echoExisting(input.existing),
    ``,
    `按以下四阶段执行，全程只用 read/bash/grep/find/ls/glob 探索、用 edit/write 落盘。`,
    ``,
    `## 阶段 1：发现（Discovery）`,
    `- 用 bash 看骨架：目录深度与文件计数、Top 目录文件数、按扩展名统计代码集中度。`,
    `- 读掉每一个已有 AGENTS.md/CLAUDE.md，抽关键约定与反模式；--create-new 也要先读再删。`,
    `- 找入口（main/index/CLI）、配置（lint/构建/测试）、CI（.github/workflows/Makefile）、测试布局。`,
    `- grep 反模式注释：DO NOT / NEVER / ALWAYS / DEPRECATED。`,
    `- 无 LSP/ast-grep 时如实标记引用中心度“未测量”，不编造符号数据。`,
    ``,
    `## 阶段 2：评分与选址（Scoring）`,
    `| 因子 | 权重 | 高分线 |`,
    `|---|---|---|`,
    `| 文件数 | 3x | >20 |`,
    `| 子目录数 | 2x | >5 |`,
    `| 代码占比 | 2x | >70% |`,
    `| 独立配置/领域 | 1x | 有自有配置 |`,
    `| 模块边界 | 2x | 有 index.ts/__init__.py |`,
    `| 符号密度 | 2x | >30 符号 |`,
    `| 导出数 | 2x | >10 导出 |`,
    `| 引用中心度 | 3x | >20 引用 |`,
    `规则：根目录必建；>15 建；8–15 有独立领域才建；<8 跳过（由父级覆盖）。`,
    `深度超过 ${input.maxDepth} 的目录不建文件。先列出选址清单再动笔。`,
    ``,
    `## 阶段 3：生成（Generate）`,
    `写文件铁律：目标已存在用 edit，不存在用 write；绝不用 write 覆盖已有文件。`,
    `根 AGENTS.md（50–150 行）：`,
    `"# PROJECT KNOWLEDGE BASE / Generated: ${input.meta.generatedAt} / Commit: ${input.meta.commit} / Branch: ${input.meta.branch}`,
    `OVERVIEW（一两句）/ STRUCTURE（只注非 obvious 用途）/ WHERE TO LOOK（任务→位置表）/`,
    `CODE MAP（符号/类型/位置/引用/职责，无数据则跳过）/ CONVENTIONS（只写偏离常识的）/`,
    `ANTI-PATTERNS（本项目明令禁止）/ COMMANDS（dev/test/build）/ NOTES（坑）"。`,
    `子目录 AGENTS.md（30–80 行）：OVERVIEW 一行 + WHERE TO LOOK + 差异化 CONVENTIONS + ANTI-PATTERNS；`,
    `绝不重复父级内容。先写根，再写子目录。`,
    ``,
    `## 阶段 4：复核（Review）`,
    `- 删通用建议（放任何项目都成立的话）、删与父级重复、压到行数上限、电报体。`,
    `- 自检：每条约定都能指出“违反会怎样”；每条反模式都有仓库实证。`,
    ``,
    `## 完成报告（原文照发）`,
    `"=== init-deep Complete === / Mode: {update|create-new} / Files: [OK] <path> (<created|updated>, <N> lines) …`,
    `/ Dirs Analyzed: <N> / AGENTS.md Created: <N> / AGENTS.md Updated: <N> / Hierarchy: <树>"。`,
    ``,
    `反模式：固定 agent 数、串行等待、忽略已有文件、每个目录都建、子复父、通用废话、长句。`,
  ].join("\n");
}

export function buildFinalReport(input: {
  mode: DeepInitMode;
  files: GeneratedFile[];
  dirsAnalyzed: number;
}): string {
  const created = input.files.filter((f) => f.action === "created").length;
  const updated = input.files.length - created;
  const lines = [
    "=== init-deep Complete ===",
    ``,
    `Mode: ${input.mode}`,
    ``,
    "Files:",
    ...input.files.map((f) => `  [OK] ${f.path} (${f.action}, ${f.lines} lines)`),
    ``,
    `Dirs Analyzed: ${input.dirsAnalyzed}`,
    `AGENTS.md Created: ${created}`,
    `AGENTS.md Updated: ${updated}`,
    ``,
    "Hierarchy:",
    ...hierarchyTree(input.files.map((f) => f.path)),
  ];
  return lines.join("\n");
}

function hierarchyTree(paths: string[]): string[] {
  if (paths.length === 0) return ["  （无文件）"];
  const sorted = [...paths].sort();
  return sorted.map((p, i) => `  ${i === sorted.length - 1 ? "└──" : "├──"} ${p}`);
}

/** 纯决策：解析结果 + 已有文件 + 元信息 → 给 handler 的动作 */
export function planDispatch(
  parsed: DeepInitOptions,
  existing: string[],
  meta: PromptMeta,
): DispatchDecision {
  if (parsed.showHelp) return { kind: "help", message: USAGE };
  const gate = resolveCreateGate(existing, parsed.mode, parsed.confirmed);
  if (!gate.ok) return { kind: "blocked", message: gate.message };
  const prompt = buildDeepInitPrompt({
    mode: parsed.mode,
    maxDepth: parsed.maxDepth,
    target: parsed.target,
    existing,
    meta,
  });
  const modeText = parsed.mode === "create-new" ? "全量重建" : "增量更新";
  return {
    kind: "dispatch",
    prompt,
    notice: `deep-init 已启动（${modeText}，深度 ${parsed.maxDepth}，目标 ${parsed.target}）。按四阶段执行，完成后照发报告。`,
  };
}

// ===== 运行时适配器 =====

export function createNodeScanner(): DirScanner {
  return {
    readDir(dir: string) {
      try {
        return readdirSync(dir);
      } catch {
        return undefined;
      }
    },
    isDirectory(path: string) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export function getGitInfo(cwd: string): { commit: string; branch: string } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    return { commit: commit || "unknown", branch: branch || "unknown" };
  } catch {
    return { commit: "unknown", branch: "unknown" };
  }
}

// ===== 扩展工厂 =====

export function createDeepInitExtension(pi: ExtensionAPI, deps: DeepInitDeps = {}): void {
  const scanner = deps.scanner ?? createNodeScanner();
  const baseCwd = deps.cwd ?? process.cwd();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const gitInfo = deps.gitInfo ?? getGitInfo;

  function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  function runCommand(rawArgs: string, ctx: ExtensionCommandContext): void {
    const parsed = parseDeepInitArgs(rawArgs ?? "");
    if (!parsed.ok) {
      notify(ctx, parsed.message, "warning");
      return;
    }
    if (parsed.value.showHelp) {
      notify(ctx, USAGE);
      return;
    }
    const root = parsed.value.target === "." ? baseCwd : parsed.value.target;
    const existing = findExistingAgentsMd(scanner, root, parsed.value.maxDepth);
    const decision = planDispatch(parsed.value, existing, {
      generatedAt: nowIso(),
      ...gitInfo(root),
    });
    switch (decision.kind) {
      case "help": {
        notify(ctx, decision.message);
        return;
      }
      case "blocked": {
        notify(ctx, decision.message, "warning");
        return;
      }
      case "dispatch": {
        notify(ctx, decision.notice);
        try {
          pi.sendMessage(
            { customType: DEEP_INIT_START_MESSAGE, content: decision.prompt, display: true },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch {
          /* 送达失败仅通知，已在上方通知启动语 */
        }
        return;
      }
    }
  }

  pi.registerCommand(DEEP_INIT_COMMAND, {
    description: "深度初始化：扫描仓库并生成层级 AGENTS.md（默认增量；--create-new 全量重建需 --yes）",
    getArgumentCompletions: (prefix: string) => {
      const items = ["--create-new", "--max-depth=", "--yes", "--help"];
      return items.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      try {
        runCommand(args, ctx);
      } catch (e) {
        notify(ctx, `执行失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createDeepInitExtension(pi);
}
