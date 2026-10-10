/**
 * dir-context 发现：锚点目录 → 该目录到 cwd 之间（**不含 cwd**）每级唯一一个上下文文件。
 *
 * - 候选文件名与优先级 = pi 原生（`docs/configuration.md`）：`AGENTS.override.md` >
 *   `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`；同目录只取第一个命中的。
 * - 顺序**由外向内**（祖先在前、最靠近锚点的最后）：模型读到的是「先总则后细则」，
 *   与 pi 原生 footer 到 cwd 的拼接顺序一致。
 * - cwd 自身排除：pi 启动时已把 cwd 的文件放进系统提示，重复注入纯浪费 token。
 * - 中间目录不存在（write 深层新文件）：向上找已存在的级即可，不抛错。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalize, isInside } from "./paths.ts";

/** 候选文件名，顺序即同目录优先级（与 pi 原生上下文文件集合保持一致）。 */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export interface DiscoverInput {
  anchorDir: string;
  rootDir: string;
}

/** 由外向内排列的上下文文件绝对路径（可能为空）。 */
export function discoverContextFiles(input: DiscoverInput): string[] {
  const root = canonicalize(input.rootDir);
  const anchor = canonicalize(input.anchorDir);
  if (!isInside(root, anchor) || anchor === root) return [];

  const found: string[] = [];
  let current = anchor;
  while (current !== root) {
    const hit = pickInDir(current, root);
    if (hit) found.push(hit);
    const parent = path.dirname(current);
    if (parent === current || !isInside(root, parent)) break;
    current = parent;
  }
  return found.reverse();
}

function pickInDir(dir: string, root: string): string | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      // Windows（含 macOS 默认卷）文件名大小写不敏感：探 `AGENTS.md` 会命中小写的
      // `AGENTS.MD`，而返回的探针名会让 transcript 里的 `Loaded` 行指向不存在的文件名。
      // realpath 拿回磁盘上的真实名字；若真实位置落在 cwd 之外（文件级链接逃逸），整个
      // 候选跳过——fail-closed，与「cwd 之外零注入」同一口径（既不注入外部内容，也不把
      // cwd 之外的路径展示出去）。同一目录的其它候选名照旧向下探。
      const real = fs.realpathSync.native(candidate);
      if (!isInside(root, real)) continue;
      return real;
    } catch {
      /* 不存在 / 无权限：继续试下一个候选名 */
    }
  }
  return null;
}
