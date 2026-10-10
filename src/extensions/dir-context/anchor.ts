/**
 * dir-context 锚点解析：被触碰的路径 → 「从哪个目录开始向上找上下文文件」。
 *
 * 语义：
 * - 文件类触碰（read/write/edit/bash 单文件读）的锚点 = 该文件所在目录（write 到
 *   尚不存在的文件同样成立：canonicalize 会取最深的已存在祖先把尾巴接回）。
 * - 目录类触碰（ls）的锚点 = 该目录；若入参其实指向一个文件，则退到它的父目录。
 * - **cwd 之外一律没有锚点**（`anchorDir: null`）：pi 原生只加载 cwd 及祖先链，
 *   cwd 之外的子树上下文不属于本扩展的职责，也避免「读宿主包目录拖进一堆上下文」。
 *
 * fail-closed：realpath 之后仍不在 cwd 之下（符号链接逃逸、`repo` vs `repo-evil`
 * 前缀冒充、`../` 越界）⇒ 零注入。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DirContextError } from "./errors.ts";
import { ErrorCodes } from "./errors.ts";
import { canonicalize, isInside } from "./paths.ts";
import type { TouchKind } from "./touch.ts";

export interface AnchorInput {
  rawPath: string;
  kind: TouchKind;
  cwd: string;
}

export type AnchorResult = { ok: true; anchorDir: string | null } | DirContextError;

export function resolveAnchor(input: AnchorInput): AnchorResult {
  const root = canonicalize(input.cwd);

  let absolute: string;
  try {
    absolute = path.resolve(input.cwd, input.rawPath);
  } catch {
    return { ok: false, code: ErrorCodes.pathResolutionFailed, message: "路径无法解析（入参非法）" };
  }

  const anchorDir = canonicalize(directoryOf(absolute, input.kind));
  if (!isInside(root, anchorDir)) return { ok: true, anchorDir: null };
  return { ok: true, anchorDir };
}

/** 目录类触碰指向文件时退到父目录；其余情况目录就是自己。 */
function directoryOf(absolute: string, kind: TouchKind): string {
  if (kind === "file") return path.dirname(absolute);
  return isFile(absolute) ? path.dirname(absolute) : absolute;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
