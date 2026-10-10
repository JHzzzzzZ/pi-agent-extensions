/**
 * dir-context — 「模型碰了哪个目录」的第一跳：工具 + 入参 → 被触碰的路径。
 *
 * 触发面（对齐 Claude Code 的 on-demand nested CLAUDE.md，另加 `ls`）：
 * - `read` / `write` / `edit`：`path` 是文件
 * - `ls`：`path` 是目录（省略 = 当前目录）
 * - `bash`：命令里**恰好一个**单文件读（`cat` / `head` / `tail`）的目标文件
 *
 * bash 是启发式：官方语义是「算作读的单文件命令」，这里取保守白名单——
 * 漏判只是少注入（不注入 ≠ 出错），误判最多多注入一个目录的上下文。
 * 因此凡是带重定向、变量展开、多文件、或非白名单命令的，一律不认。
 */

export type TouchKind = "file" | "directory";

export interface Touch {
  /** 工具入参里的原始路径（未 resolve）。 */
  rawPath: string;
  kind: TouchKind;
}

/** 直接携带路径的工具 → 路径语义。 */
const PATH_TOOLS: Record<string, TouchKind> = {
  read: "file",
  write: "file",
  edit: "file",
  ls: "directory",
};

/** bash 里算作「单文件读」的命令白名单。 */
const BASH_READ_COMMANDS = new Set(["cat", "head", "tail"]);

/** shell 分隔符：`|`、`||`、`&&`、`;`、换行都算段边界。 */
const SEGMENT_SEPARATOR = /[|;&\n]+/;

export function detectTouch(toolName: string, input: Record<string, unknown>): Touch | null {
  const kind = PATH_TOOLS[toolName];
  if (kind) return detectPathTouch(kind, input);
  if (toolName === "bash") return detectBashTouch(input);
  return null;
}

function detectPathTouch(kind: TouchKind, input: Record<string, unknown>): Touch | null {
  const rawPath = input.path;
  if (rawPath === undefined && kind === "directory") return { rawPath: ".", kind };
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  return { rawPath, kind };
}

function detectBashTouch(input: Record<string, unknown>): Touch | null {
  const command = input.command;
  if (typeof command !== "string") return null;
  const rawPath = readBashTarget(command);
  return rawPath ? { rawPath, kind: "file" } : null;
}

/**
 * 从 bash 命令里提取唯一的单文件读目标。
 * 返回 null 表示「拿不准」——调用方据此零注入。
 */
function readBashTarget(command: string): string | null {
  if (command.trim().length === 0) return null;
  // 重定向（写/读）、变量展开、命令替换都会让「读了哪个文件」不可静态判定。
  if (/[<>$`]/.test(command)) return null;

  const candidates: string[] = [];
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const tokens = tokenize(segment);
    const [program, ...args] = tokens;
    if (!program || !BASH_READ_COMMANDS.has(program)) continue;
    for (const arg of args) {
      // 选项（`-n`）与计数值（`20`、`+1`）不是路径。
      if (arg.startsWith("-") || /^\+?\d+$/.test(arg)) continue;
      candidates.push(arg);
    }
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** 按空白切词并剥掉成对引号（`cat "a b.ts"` 必须得到一个含空格的路径）。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
