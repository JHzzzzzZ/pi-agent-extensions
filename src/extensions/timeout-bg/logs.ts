/**
 * timeout-bg — 后台日志文件的落盘与清理（timeout-bg-todo#1）
 *
 * 布局：`<logRoot>/<pi pid>/<jobId>.log`（每次 pi 会话一个子目录，多会话互不覆盖）。
 * 保留策略：7 天 / 最多 50 个（按 mtime 新的优先），**只在 session_start 清理**（index.ts 唯一调用点）；
 * 活着的会话目录（包括本进程自己）不吃数量上限，只按保留期清——否则并发会话的 prune 会删掉别人正被
 * 通知引用的日志（timeout-bg#7）；死会话目录按数量 + 保留期清，避免陈年日志堆积。
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

/** 本会话的日志目录：`<logRoot>/<pi pid>`（一个 pi 进程一个子目录，多会话互不覆盖）。 */
export function sessionLogDir(logRoot: string): string {
  return path.join(logRoot, String(process.pid));
}

/** 日志路径的唯一算法：`<logRoot>/<pi pid>/<jobId>.log`（本地 job 与远端 job 同布局）。 */
export function resolveJobLogPath(logRoot: string, jobId: string): string {
  return path.join(sessionLogDir(logRoot), `${jobId}.log`);
}

/**
 * 下一个可用 job 编号：本会话目录里现有 `bg-<n>.log` 的最大 n + 1（取不到 → 1）。
 *
 * 为什么要扫盘（timeout-bg#7）：编号计数器是**实例内**状态，`/reload` 后从 1 重排，而日志是 append
 * 打开的——不接着旧最大号，新 job 就会写进同名旧日志，把两条命令的输出混进一个文件（通知的
 * 「末尾输出」也跟着混）。同一 pid 目录只属一个进程、实例内编号顺序分配，所以扫一次即无竞争。
 *
 * 残留窗口：旧实例刚 spawn 的 job 还来不及把文件落到盘上（`createWriteStream` 异步打开）时，
 * 新实例的扫描是看不到它的——需要「spawn → reload → 新命令」挤进几毫秒内，且后果不差于本修复前。
 */
export function nextJobSeq(logRoot: string, pid: number = process.pid): number {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(logRoot, String(pid)));
  } catch {
    // 读不出（ENOENT / EACCES / EMFILE…）都按「没有历史」从 1 起：宁可拿一个号，也不让命令失败。
    return 1;
  }
  let max = 0;
  for (const name of names) {
    const matched = /^bg-(\d+)\.log$/.exec(name);
    if (matched === null) continue;
    max = Math.max(max, Number(matched[1]));
  }
  return max + 1;
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

/** 进程是否还在（`kill(pid, 0)`：ESRCH = 死；EPERM/EACCES = 活着但无权探测）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 清理后台日志：超过保留期或超出数量上限的文件被删除；空目录一并收掉。
 * 返回删除的文件数。
 *
 * **活着的会话目录**（目录名是 pid 且进程还在，含本进程自己）只按保留期清、**不吃数量上限**：
 * 它的通知/`/bg` 还在引用这些路径，而每条命令（含前台）都占一个文件，50 上限会被迅速吃满。
 * 这一条必须按「进程是否活着」判，不能只看「是不是自己的目录」——并发的第二个 pi（另一个终端、
 * `pi --print`、子 agent）在它自己的 session_start 里看到的我们同样是「别家目录」（timeout-bg#7 评审）。
 * 死会话目录没有活引用，按数量 + 保留期清；名次只数非豁免文件，否则活会话的文件会把死目录的挤光。
 */
export function pruneJobLogs(
  logRoot: string,
  nowMs: number,
  options: { retentionMs?: number; keepMax?: number; isAlive?: (pid: number) => boolean } = {},
): number {
  const retentionMs = options.retentionMs ?? LOG_RETENTION_MS;
  const keepMax = options.keepMax ?? LOG_KEEP_MAX;
  const isAlive = options.isAlive ?? isProcessAlive;
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
  const liveDirs = new Set(sessionDirs.filter((dir) => /^\d+$/.test(dir) && isAlive(Number(dir))));
  let removed = 0;
  let rank = 0;
  for (const entry of files) {
    const live = liveDirs.has(path.basename(path.dirname(entry.file)));
    const withinCap = live || rank < keepMax;
    if (!live) rank += 1;
    const tooOld = nowMs - entry.mtimeMs > retentionMs;
    if (withinCap && !tooOld) continue;
    try {
      fs.rmSync(entry.file, { force: true });
      removed += 1;
    } catch {
      /* 删不掉不影响会话 */
    }
  }

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
