/**
 * dir-context 注入文本：格式、码点安全截断、预算。
 *
 * 纯函数（不读文件、不碰宿主），因此可以完全离线锁定行为——调用方负责读文件与
 * 记录「已注入」状态。
 *
 * 预算为何存在：上下文文件的成本随触碰目录数线性增长，而模型对超长指令的遵循度
 * 反而下降（Claude Code 官方建议每个 CLAUDE.md < 200 行）。单文件 32 KiB、单次注入
 * 128 KiB 是「够用且不会一次吃光窗口」的粗粒度上限。
 */

/** 单个上下文文件的注入上限。 */
export const MAX_FILE_BYTES = 32 * 1024;
/** 单次工具结果注入的合计上限。 */
export const MAX_TOTAL_BYTES = 128 * 1024;

export interface ContextFileContent {
  absolutePath: string;
  /** 展示用相对路径（正斜杠）。 */
  relativePath: string;
  content: string;
}

export interface InjectedFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export interface Injection {
  text: string;
  injected: InjectedFile[];
}

/** 按 UTF-8 **码点**边界截断：绝不劈开多字节字符或代理对。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let used = 0;
  let kept = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (used + size > maxBytes) break;
    kept += codePoint;
    used += size;
  }
  return { text: kept, truncated: true };
}

export function buildInjection(files: ContextFileContent[]): Injection {
  const injected: InjectedFile[] = [];
  const blocks: string[] = [];
  const skipped: string[] = [];
  let remaining = MAX_TOTAL_BYTES;

  for (const file of files) {
    const originalBytes = Buffer.byteLength(file.content, "utf8");
    const allowed = Math.min(MAX_FILE_BYTES, remaining);
    if (allowed <= 0) {
      skipped.push(file.relativePath);
      continue;
    }
    const { text, truncated } = truncateUtf8(file.content, allowed);
    const bytes = Buffer.byteLength(text, "utf8");
    remaining -= bytes;

    injected.push({ absolutePath: file.absolutePath, relativePath: file.relativePath, content: text, truncated, bytes });
    blocks.push(renderBlock(file.relativePath, text, truncated, bytes, originalBytes));
  }

  if (skipped.length > 0) blocks.push(`[skipped (injection budget exhausted): ${skipped.join(", ")}]`);
  return { text: blocks.join("\n"), injected };
}

function renderBlock(relativePath: string, content: string, truncated: boolean, bytes: number, originalBytes: number): string {
  const lines = [`Loaded ${relativePath}`, `<dir-context path="${relativePath}">`, content];
  if (truncated) lines.push(`[truncated to ${bytes} bytes of ${originalBytes} bytes]`);
  lines.push("</dir-context>");
  return lines.join("\n");
}
