/**
 * dir-context 路径工具：realpath 归一与「是否在根之下」判定。
 *
 * 为什么单独一层：锚点解析（anchor.ts）与发现（discover.ts）必须用**同一套**
 * 包含判定，否则「锚点被接受、发现阶段又认为越界」会静默吞掉注入。
 *
 * 不变量：
 * - `canonicalize` 对**不存在的路径**也成立：取最深的已存在祖先做 realpath，再把
 *   剩下的尾巴拼回去（write 新文件场景必须能解析）。
 * - `isInside` 用 `path.relative` 而非字符串前缀：`repo` 与 `repo-evil` 必须区分，
 *   Windows 的大小写差异由宿主 `path` 实现承担。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 归一化路径：已存在部分走 realpath（解析链接、规范大小写），不存在部分原样接回。 */
export function canonicalize(target: string): string {
  const tail: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      // 走到文件系统根仍解析不了（不可达/无权限）：退回字面量，交给 isInside 判定。
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** `target` 是否等于 `root` 或位于其下。两者都必须已 canonicalize。 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 展示用相对路径：统一正斜杠，跨平台 transcript 一致。 */
export function toDisplayPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}
