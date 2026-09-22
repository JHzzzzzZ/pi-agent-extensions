/**
 * timeout-bg — 后台日志文件的落盘与清理（timeout-bg-todo#1）
 *
 * 布局：`<logRoot>/<pi pid>/<jobId>.log`（每次 pi 会话一个子目录，多会话互不覆盖）。
 * 保留策略：7 天 / 最多 50 个（按 mtime 新的优先），在 session_start 与每次新开
 * 后台任务时清理——否则日志会无限增长。
 *
 * 读日志尾部：给超时结果与完成通知附最近输出；二进制控制字符直接剔除，
 * 不让终端控制序列进模型上下文。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_KEEP_MAX = 50;

/** 剔除除 \n \t 外的控制字符（含 ESC 序列开头）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 去掉终端控制字符（日志尾部与超时结果共用同一口径）。 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** 读文件尾部最多 maxBytes 字节，剔除控制字符、丢掉可能被截断的首行。 */
export function tailFileSync(filePath: string, maxBytes: number): string {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = stripControlChars(buffer.toString("utf8"));
  if (start > 0) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return text.trimEnd();
}

/**
 * 清理后台日志：超过保留期或超出数量上限的文件被删除；空目录一并收掉。
 * 返回删除的文件数。
 */
export function pruneJobLogs(
  logRoot: string,
  nowMs: number,
  options: { retentionMs?: number; keepMax?: number } = {},
): number {
  const retentionMs = options.retentionMs ?? LOG_RETENTION_MS;
  const keepMax = options.keepMax ?? LOG_KEEP_MAX;
  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(logRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return 0;
  }

  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of sessionDirs) {
    const dirPath = path.join(logRoot, dir);
    let names: string[];
    try {
      names = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      const file = path.join(dirPath, name);
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        /* 并发删除/无权限：跳过 */
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  files.forEach((entry, index) => {
    const tooOld = nowMs - entry.mtimeMs > retentionMs;
    if (!tooOld && index < keepMax) return;
    try {
      fs.rmSync(entry.file, { force: true });
      removed += 1;
    } catch {
      /* 删不掉不影响会话 */
    }
  });

  for (const dir of sessionDirs) {
    const dirPath = path.join(logRoot, dir);
    try {
      if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
    } catch {
      /* 目录非空或不可读：留着 */
    }
  }
  return removed;
}
