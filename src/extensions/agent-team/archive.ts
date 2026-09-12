/**
 * agent-team — run record archiving (终态自动归档)
 *
 * 每个 run 的工作记录落在运行项目的 `<项目根>/.pi/team-runs/<runId>/`
 * （目录形态，平铺文件）和/或 `.pi/team-runs/<runId>.md`（单文件形态）。
 * worktree 团队的 run worktree 会被 `git worktree remove` 整体删除——只有主
 * 工作区存活，所以终态（completed/failed/aborted）当场把记录复制到
 * `<主会话 cwd>/history/team-runs/<runId>/`：
 *
 * - 记录源 = `<worktreeRoot>/<runId>/` 的一层子目录（team 共享 worktree 与
 *   各成员 worktree）与主会话 cwd 两处；只复制，源永不删除，不做任何 git 操作；
 * - 冲突不覆盖：目标已有同名文件且字节不同 → 保留既有，新记录改名
 *   `<名>.conflict-<UTC 紧凑时间戳><扩展名>` 落盘；字节相同 → 幂等跳过；
 * - 全程异常隔离：任何 fs 失败只进 `failures` 诊断，永不 throw；调用方只
 *   告警，绝不改 run 终态。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeRunId } from "./transcript.ts";

export interface ArchiveOptions {
  runId: string;
  /** 主会话 cwd（归档目标 history/team-runs/ 挂在这里）。 */
  baseCwd: string;
  /** `<worktreeRoot>/<runId>`，其一层子目录逐个作为记录源项目根。 */
  worktreeRunRoot?: string;
  /** 冲突后缀时钟（默认真实 UTC；测试注入固定值）。 */
  now?: () => Date;
}

export interface ArchiveResult {
  /** 已复制到主工作区的文件（目标绝对路径）。 */
  archived: string[];
  /** 冲突副本（目标绝对路径；既有文件保留不动）。 */
  conflicts: string[];
  /** 失败诊断（静态模板 + fs 错误信息），非空即有失败。 */
  failures: string[];
}

/** UTC 紧凑时间戳：`20260210T031405Z`（冲突后缀，文件名安全）。 */
export function compactUtcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `a.md` → `a.conflict-<stamp>.md`；无扩展名则追加在末尾。 */
export function conflictFileName(name: string, stamp: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base}.conflict-${stamp}${ext}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 两个路径字节相同；任一读取失败（不存在/是目录）返回 null。 */
function sameFileContents(a: string, b: string): boolean | null {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return null;
  }
}

/** 候选项目根：worktree 一层子目录（排序保证确定性）在前，主会话 cwd 在后。 */
function candidateProjectRoots(options: ArchiveOptions): string[] {
  const roots: string[] = [];
  const worktreeRunRoot = options.worktreeRunRoot;
  if (worktreeRunRoot) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(worktreeRunRoot, { withFileTypes: true });
    } catch {
      /* run 没用 worktree（或已被清理）→ 没有候选 */
    }
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      roots.push(path.join(worktreeRunRoot, entry.name));
    }
  }
  roots.push(options.baseCwd);
  return roots;
}

/** 一个项目根下的记录源文件：目录形态平铺 + `<runId>.md` 单文件形态。 */
function sourceFiles(root: string, runId: string): string[] {
  const teamRuns = path.join(root, ".pi", "team-runs");
  const files: string[] = [];
  try {
    const dir = path.join(teamRuns, runId);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(dir, entry.name));
    }
  } catch {
    /* 无目录形态 */
  }
  const single = path.join(teamRuns, `${runId}.md`);
  try {
    if (fs.statSync(single).isFile()) files.push(single);
  } catch {
    /* 无单文件形态 */
  }
  return files;
}

interface ArchiveTarget {
  dir: string;
  /** mkdir -p 只在首次需要复制时尝试；一旦失败只记一条诊断。 */
  ensure: () => boolean;
}

function archiveTarget(baseCwd: string, runId: string, result: ArchiveResult): ArchiveTarget {
  const dir = path.join(baseCwd, "history", "team-runs", sanitizeRunId(runId));
  let ready = false;
  let failed = false;
  return {
    dir,
    ensure: () => {
      if (ready) return true;
      if (failed) return false;
      try {
        fs.mkdirSync(dir, { recursive: true });
        ready = true;
        return true;
      } catch (e) {
        failed = true;
        result.failures.push(`归档目标目录创建失败：${dir}（${errorText(e)}）`);
        return false;
      }
    },
  };
}

/** 冲突副本落盘（既有文件不动）；同字节副本已存在则幂等跳过并返回 null。 */
function writeConflictCopy(source: string, name: string, target: ArchiveTarget, now: () => Date): string | null {
  const stamp = compactUtcStamp(now());
  const base = conflictFileName(name, stamp);
  const ext = path.extname(name);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let attempt = 1; ; attempt++) {
    const candidate = path.join(target.dir, attempt === 1 ? base : `${stem}-${attempt}${ext}`);
    if (!fs.existsSync(candidate)) {
      fs.copyFileSync(source, candidate);
      return candidate;
    }
    if (sameFileContents(source, candidate) === true) return null;
  }
}

function archiveOne(source: string, target: ArchiveTarget, result: ArchiveResult, now: () => Date): void {
  const name = path.basename(source);
  const dest = path.join(target.dir, name);
  if (sameFileContents(source, dest) === true) return; // 字节相同 → 幂等跳过
  if (!target.ensure()) return;
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(source, dest);
    result.archived.push(dest);
    return;
  }
  const conflict = writeConflictCopy(source, name, target, now);
  if (conflict !== null) result.conflicts.push(conflict);
}

/**
 * 把一个终态 run 的记录归档到主工作区。永不 throw；失败与冲突都只进
 * 返回值的诊断清单（冲突不算失败）。
 */
export function archiveRunRecords(options: ArchiveOptions): ArchiveResult {
  const result: ArchiveResult = { archived: [], conflicts: [], failures: [] };
  try {
    const target = archiveTarget(options.baseCwd, options.runId, result);
    const now = options.now ?? (() => new Date());
    for (const root of candidateProjectRoots(options)) {
      for (const source of sourceFiles(root, options.runId)) {
        try {
          archiveOne(source, target, result, now);
        } catch (e) {
          result.failures.push(`归档失败：${source}（${errorText(e)}）`);
        }
      }
    }
  } catch (e) {
    result.failures.push(`归档异常终止：${errorText(e)}`);
  }
  return result;
}
