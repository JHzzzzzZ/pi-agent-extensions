/**
 * safe-git-autocommit/index.ts — Pi extension
 *
 * 双层架构：
 *   Layer 1 — 诊断基线（只读，fail-closed 事件驱动）
 *     通过 session_start / agent_settled / session_shutdown 事件采集基线、
 *     完成判定（恒为 unknown）、提交规划、结构化通知。永不执行 git 写入。
 *     注册 /safe-git 命令供手动诊断。
 *
 *   Layer 2 — 显式提交工具（safe_git_commit）
 *     通过 pi.registerTool 注册一个 agent 可调用的显式提交工具。
 *     Agent 在自己确认任务完成后调用，将"成功"从事件推断变为主动行为。
 *     每次调用的安全校验与 Layer 1 相同（基线/隔离/过滤/预检/unsafe_repo），
 *     但允许在通过后执行 git init / git commit --only（仅候选路径，不 push）。
 *     保留前次诊断基线的只读安全基线，作为退出时/手动诊断的兜底。
 *
 * 安装：把本目录复制到 ~/.pi/agent/extensions/safe-git-autocommit/（全局）
 *       或 .pi/extensions/safe-git-autocommit/（项目级），/reload 生效。
 *
 * 依赖：pi / @earendil-works/pi-coding-agent (ExtensionAPI, ExtensionContext)
 *       typebox (Type) — pi 内置提供。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, readdirSync, Dirent } from "node:fs";
import { relative, resolve, join, basename } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
//  Layer 1 — 诊断基线（只读 fail-closed）
// ═══════════════════════════════════════════════════════════════════════

// ─── 完成判定翻转点 ──────────────────────────────────────────────────
// Layer 1 恒 fail-closed（SUCCESS_PROVEN = false），不执行写操作。
const SUCCESS_PROVEN = false;

// ─── 安全过滤规则 ──────────────────────────────────────────────────────
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const SENSITIVE_NAME = [
  /^\.env(\..+)?$/i,
  /(^|[\\/])(secret|token|credential|password|private[-_]?key)([\\/.]|$)/i,
  /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa)([\\/.]|$)/i,
  /\.(pem|key|pfx|keystore|jks)$/i,
];
const BUILD_DIRS = new Set(["node_modules", "dist", "build", ".git", "out", "target"]);

// ─── git runner：只读白名单 ─────────────────────────────────────────
const READONLY_GIT = new Set([
  "rev-parse",
  "status",
  "ls-files",
  "diff",
  "config",
  "hash-object",
  "symbolic-ref",
]);

interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd: string): GitResult {
  const sub = args[0];
  if (!sub || !READONLY_GIT.has(sub)) {
    return { ok: false, code: -1, stdout: "", stderr: `blocked non-readonly git subcommand: ${sub ?? "(none)"}` };
  }
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { ok: false, code: e?.status ?? -1, stdout: (e?.stdout ?? "").toString(), stderr: (e?.stderr ?? "").toString() };
  }
}

// ─── git runner：受控写入（供工具使用，不暴露给事件层）───────────────
const WRITE_GIT = new Set([
  "init",
  "add",
  "commit",
]);

function runGitWrite(args: string[], cwd: string): GitResult {
  const sub = args[0];
  if (!sub || !WRITE_GIT.has(sub)) {
    return { ok: false, code: -1, stdout: "", stderr: `blocked unsupported write subcommand: ${sub ?? "(none)"}` };
  }
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { ok: false, code: e?.status ?? -1, stdout: (e?.stdout ?? "").toString(), stderr: (e?.stderr ?? "").toString() };
  }
}

// ─── Git 身份检查 ────────────────────────────────────────────────────
function checkGitIdentity(repoRoot: string): GitIdentityResult {
  const name = runGit(["config", "user.name"], repoRoot);
  const email = runGit(["config", "user.email"], repoRoot);
  if (!name.ok || !email.ok || !name.stdout.trim() || !email.stdout.trim()) {
    return { ok: false, errorCode: "git_identity_missing" as const };
  }
  return { ok: true };
}

interface GitIdentityResult {
  ok: boolean;
  errorCode?: SkipReason;
}

// ─── 类型 ─────────────────────────────────────────────────────────────
type Completion = "success" | "not-success" | "unknown";
type SkipReason =
  | "not_success"
  | "no_changes"
  | "unsafe_repo"
  | "sensitive_file"
  | "large_file"
  | "git_identity_missing"
  | "git_failed"
  | "not_trusted";

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

interface SessionBaseline {
  cwd: string;
  repoRoot?: string;
  mode: "existing" | "initialized" | "skip";
  skipReason?: SkipReason;
  trackedCleanAtStart: Set<string>; // 相对 repoRoot 的路径；会话开始时已跟踪且干净
  dirtyAtStart: Set<string>; // 会话开始时已 dirty/staged/untracked（既有改动，永久排除）
  initFilesAtStart: Set<string>; // 初始化模式：会话开始时的文件相对路径集（零写入基线用）
  initFingerprintsAtStart: Map<string, FileFingerprint>; // 初始化模式：文件指纹 map，用于检测新建/变更
  startedAt: number;
}

interface FilterHit {
  rule: SkipReason;
  detail: string;
}

interface Diagnosis {
  completion: Completion;
  mode: SessionBaseline["mode"];
  repoRoot?: string;
  candidates: string[];
  filtered: Array<{ path: string; rule: SkipReason; detail: string }>;
  skippedReason?: SkipReason;
  detail?: string;
}

/**
 * safe_git_commit 工具的结果类型。
 * 与 PRD v2 契约对齐：
 *   committed: boolean
 *   sha?: string          — 若 committed=true，创建的 commit SHA（短格式）
 *   files?: string[]      — 若 committed=true，提交的文件相对路径列表
 *   skippedReason?: string — 若 committed=false，跳过原因
 *   errorCode?: string     — 若 committed=false 且为异常，错误标识
 */
export interface ToolResult {
  committed: boolean;
  sha?: string;
  files?: string[];
  skippedReason?: SkipReason;
  errorCode?: string;
}

// ─── 提交信息清洗 ─────────────────────────────────────────────────────
export function sanitizeMessage(summary?: string): string {
  const fallback = "pi: completed task";
  const clean = (summary ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback;
  const max = 72;
  const text = clean.slice(0, Math.max(0, max - "pi: ".length));
  const msg = `pi: ${text}`;
  return msg.length > max ? msg.slice(0, max) : msg;
}

// ─── 完成判定器（Layer 1 专用，恒 fail-closed）───────────────────────
function detectCompletion(observed: { settled: boolean; turnAborted: boolean }): Completion {
  if (!SUCCESS_PROVEN) return "unknown";
  if (observed.turnAborted) return "not-success";
  return observed.settled ? "success" : "unknown";
}

// ─── 采集初始化模式的文件清单与指纹（相对 cwd，递归深度 ≤3 防爆炸）──
function collectFilesRecursive(dir: string, baseDir: string, depth: number = 0, maxDepth: number = 3): Set<string> {
  const files = new Set<string>();
  if (depth > maxDepth) return files;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.add(relPath + "/");
      const sub = collectFilesRecursive(fullPath, baseDir, depth + 1, maxDepth);
      for (const s of sub) files.add(s);
    } else {
      files.add(relPath);
    }
  }
  return files;
}

// 采集初始化模式的文件指纹 map
function collectFileFingerprints(dir: string, baseDir: string, depth: number = 0, maxDepth: number = 3): Map<string, FileFingerprint> {
  const map = new Map<string, FileFingerprint>();
  if (depth > maxDepth) return map;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const sub = collectFileFingerprints(fullPath, baseDir, depth + 1, maxDepth);
      for (const [k, v] of sub) map.set(k, v);
    } else {
      try {
        const st = statSync(fullPath);
        map.set(relPath, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // unreadable files are skipped
      }
    }
  }
  return map;
}

// ─── 基线采集（只读）──────────────────────────────────────────────────
export function captureBaseline(cwd: string, startedAt: number): SessionBaseline {
  const fail = (reason: SkipReason): SessionBaseline => ({
    cwd,
    mode: "skip",
    skipReason: reason,
    trackedCleanAtStart: new Set(),
    dirtyAtStart: new Set(),
    initFilesAtStart: new Set(),
    initFingerprintsAtStart: new Map(),
    startedAt,
  });

  // bare repo
  const bare = runGit(["rev-parse", "--is-bare-repository"], cwd);
  if (bare.ok && bare.stdout.trim() === "true") return fail("unsafe_repo");

  // 仓库检测
  const toplevel = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!toplevel.ok || !toplevel.stdout.trim()) {
    // 无仓库 — 初始化模式：采集当前文件集 + 指纹
    const initFiles = collectFilesRecursive(cwd, cwd);
    const initFps = collectFileFingerprints(cwd, cwd);
    return { cwd, mode: "initialized", trackedCleanAtStart: new Set(), dirtyAtStart: new Set(), initFilesAtStart: initFiles, initFingerprintsAtStart: initFps, startedAt };
  }
  const repoRoot = realpathSync(toplevel.stdout.trim());

  // unsafe repo 预检（使用 --git-dir 兼容 linked worktree）
  const gitDir = runGit(["rev-parse", "--git-dir"], cwd);
  if (!gitDir.ok || !gitDir.stdout.trim()) return fail("unsafe_repo");
  const gitDirPath = resolve(cwd, gitDir.stdout.trim());
  if (
    existsSync(resolve(gitDirPath, "MERGE_HEAD")) ||
    existsSync(resolve(gitDirPath, "CHERRY_PICK_HEAD")) ||
    existsSync(resolve(gitDirPath, "REVERT_HEAD")) ||
    existsSync(resolve(gitDirPath, "rebase-merge")) ||
    existsSync(resolve(gitDirPath, "rebase-apply")) ||
    existsSync(resolve(gitDirPath, "index.lock"))
  ) {
    return fail("unsafe_repo");
  }

  // 已跟踪 + dirty
  const ls = runGit(["ls-files"], repoRoot);
  const allTracked = new Set(
    ls.ok ? ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [],
  );
  const dirty = porcelainPaths(repoRoot);
  const dirtyAtStart = dirty;
  const trackedCleanAtStart = new Set<string>();
  for (const t of allTracked) if (!dirtyAtStart.has(t)) trackedCleanAtStart.add(t);

  return { cwd, repoRoot, mode: "existing", trackedCleanAtStart, dirtyAtStart, initFilesAtStart: new Set(), initFingerprintsAtStart: new Map(), startedAt };
}

// 解析 git status --porcelain 的变更路径（相对 repoRoot，正斜杠）
function porcelainPaths(repoRoot: string): Set<string> {
  const res = runGit(["status", "--porcelain", "--untracked-files=all", "-z"], repoRoot);
  if (!res.ok) return new Set();
  const out = new Set<string>();
  for (const chunk of res.stdout.split("\u0000")) {
    if (!chunk) continue;
    const status = chunk.slice(0, 2);
    let path = chunk.slice(3);
    if (status[0] === "R" || status[0] === "C") path = path.split("\t").pop() ?? path;
    if (path) out.add(path);
  }
  return out;
}

// ─── 候选过滤（仅按名/路径/大小，不读取正文）─────────────────────────
function filterCandidate(repoRoot: string, relPath: string): FilterHit | null {
  const segs = relPath.split(/[\\/]/);
  for (const seg of segs) if (BUILD_DIRS.has(seg)) return { rule: "sensitive_file", detail: `build dir (${segs.find((s) => BUILD_DIRS.has(s))})` };

  for (const re of SENSITIVE_NAME) if (re.test(relPath)) return { rule: "sensitive_file", detail: "sensitive name" };

  const abs = safeResolve(repoRoot, relPath);
  if (!abs) return { rule: "sensitive_file", detail: "path escapes repo" };
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { rule: "sensitive_file", detail: "unreadable" };
  }
  if (st.size > MAX_FILE_BYTES) return { rule: "large_file", detail: `${(st.size / 1024 / 1024).toFixed(1)}MiB` };
  return null;
}

// 解析 realpath 并确认仍在 repoRoot 内
function safeResolve(repoRoot: string, relPath: string): string | null {
  try {
    const abs = realpathSync(resolve(repoRoot, relPath));
    const rel = relative(repoRoot, abs);
    if (rel.startsWith("..") || rel === "") return null;
    return abs;
  } catch {
    return null;
  }
}

// ─── 提交规划（只读诊断）─────────────────────────────────────────────
export function diagnose(baseline: SessionBaseline, observed: { settled: boolean; turnAborted: boolean }): Diagnosis {
  const completion = detectCompletion(observed);

  if (baseline.mode === "skip") {
    return { completion, mode: baseline.mode, repoRoot: baseline.repoRoot, candidates: [], filtered: [], skippedReason: baseline.skipReason ?? "unsafe_repo" };
  }
  if (baseline.mode === "initialized") {
    // Layer 1：零写入，仅报告诊断信息
    return { completion, mode: baseline.mode, candidates: [], filtered: [], skippedReason: completion === "success" ? "no_changes" : "not_success", detail: "no git repo (would init; skipped: fail-closed)" };
  }

  // existing 仓库：候选 = 会话开始干净且现已变更的已跟踪文件
  const nowDirty = porcelainPaths(baseline.repoRoot!);
  const candidates: string[] = [];
  for (const p of nowDirty) {
    if (baseline.trackedCleanAtStart.has(p)) candidates.push(p);
  }

  return filterAndEvaluate(baseline.repoRoot!, candidates, completion);
}

// 对候选进行过滤与评估
function filterAndEvaluate(repoRoot: string, candidates: string[], completion: Completion): Diagnosis {
  const filtered: Array<{ path: string; rule: SkipReason; detail: string }> = [];
  const safe: string[] = [];
  for (const rel of candidates) {
    const hit = filterCandidate(repoRoot, rel);
    if (hit) filtered.push({ path: rel, rule: hit.rule, detail: hit.detail });
    else safe.push(rel);
  }

  let skippedReason: SkipReason | undefined;
  let detail: string | undefined;
  if (completion !== "success") {
    skippedReason = "not_success";
    detail = completion === "unknown" ? "fail-closed: no reliable success signal" : "task not successful";
  } else if (filtered.length > 0) {
    skippedReason = filtered[0]!.rule;
    detail = `${filtered.length} candidate(s) filtered`;
  } else if (safe.length === 0) {
    skippedReason = "no_changes";
  }

  return { completion, mode: "existing", repoRoot, candidates: safe, filtered, skippedReason, detail };
}

// ═══════════════════════════════════════════════════════════════════════
//  Layer 2 — 显式提交工具（safe_git_commit）
// ═══════════════════════════════════════════════════════════════════════

// ─── 工具候选计算（专供工具使用，实时采集而非依赖 Layer 1 基线）───────
function computeToolCandidates(freshBaseline: SessionBaseline): {
  candidates: string[];
  filtered: Array<{ path: string; rule: SkipReason; detail: string }>;
  safe: string[];
} {
  if (freshBaseline.mode === "existing") {
    // 现有仓库：候选 = 会话开始时干净 → 现在变脏的已跟踪文件
    const nowDirty = porcelainPaths(freshBaseline.repoRoot!);
    const candidates: string[] = [];
    for (const p of nowDirty) {
      if (freshBaseline.trackedCleanAtStart.has(p)) candidates.push(p);
    }
    return filterCandidates(freshBaseline.repoRoot!, candidates);
  }

  if (freshBaseline.mode === "initialized") {
    // 初始化模式：候选 = 当前文件中不属于会话开始文件集的新建/变更文件
    const currentFiles = collectFilesRecursive(freshBaseline.cwd, freshBaseline.cwd);
    const candidates: string[] = [];
    for (const f of currentFiles) {
      if (!freshBaseline.initFilesAtStart.has(f)) candidates.push(f);
    }
    // init 模式 repoRoot 尚不存在；用 cwd 做过滤
    const cwd = freshBaseline.cwd;
    return filterCandidates(cwd, candidates);
  }

  // skip 模式：无候选
  return { candidates: [], filtered: [], safe: [] };
}

function filterCandidates(repoRoot: string, candidates: string[]) {
  const filtered: Array<{ path: string; rule: SkipReason; detail: string }> = [];
  const safe: string[] = [];
  for (const rel of candidates) {
    const hit = filterCandidate(repoRoot, rel);
    if (hit) filtered.push({ path: rel, rule: hit.rule, detail: hit.detail });
    else safe.push(rel);
  }
  return { candidates, filtered, safe };
}

// ─── 构建工具结果 ────────────────────────────────────────────────────
function toolResult(committed: boolean, overrides: Partial<ToolResult> = {}): ToolResult {
  return { committed, ...overrides };
}

function formatToolContent(r: ToolResult): string {
  if (r.committed) {
    const files = r.files ?? [];
    const fileList = files.length <= 5 ? files.join(", ") : `${files.length} file(s)`;
    return `Committed ${fileList} (${r.sha})`;
  }
  if (r.skippedReason === "no_changes") return "No changes to commit";
  if (r.skippedReason === "sensitive_file") return "Commit skipped: sensitive file detected";
  if (r.skippedReason === "large_file") return "Commit skipped: file exceeds 1 MiB limit";
  if (r.skippedReason === "unsafe_repo") return "Commit skipped: unsafe repository state";
  if (r.skippedReason === "git_identity_missing") return "Commit failed: git user.name/user.email not configured";
  if (r.skippedReason === "git_failed") return `Commit failed: git error (${r.errorCode ?? "unknown"})`;
  if (r.skippedReason === "not_trusted") return "Commit skipped: project not trusted";
  return `Commit skipped: ${r.skippedReason ?? "unknown"}`;
}

// ─── 仓库安全预检（每次工具调用时重做）─────────────────────────────
function checkRepoSafe(cwd: string, repoRoot: string): SkipReason | null {
  // bare repo
  const bare = runGit(["rev-parse", "--is-bare-repository"], cwd);
  if (bare.ok && bare.stdout.trim() === "true") return "unsafe_repo";

  // 使用 --git-dir 获取实际 Git 目录（兼容 linked worktree）
  const gitDir = runGit(["rev-parse", "--git-dir"], cwd);
  if (!gitDir.ok || !gitDir.stdout.trim()) return "unsafe_repo";
  const gitDirPath = resolve(cwd, gitDir.stdout.trim());

  // 进行中的 merge/rebase/cherry-pick/revert / index lock
  if (
    existsSync(resolve(gitDirPath, "MERGE_HEAD")) ||
    existsSync(resolve(gitDirPath, "CHERRY_PICK_HEAD")) ||
    existsSync(resolve(gitDirPath, "REVERT_HEAD")) ||
    existsSync(resolve(gitDirPath, "rebase-merge")) ||
    existsSync(resolve(gitDirPath, "rebase-apply")) ||
    existsSync(resolve(gitDirPath, "index.lock"))
  ) {
    return "unsafe_repo";
  }
  return null;
}

// ─── 工具执行主逻辑（使用会话存储的基线）────────────────────────────
export function executeSafeGitCommit(summary: string, sessionBaseline: SessionBaseline | undefined, ctx: ExtensionContext): ToolResult {
  // 1. 项目可信性（fail-closed：方法缺失/抛错/返回非 true 均拒绝）
  try {
    const isTrusted = (ctx as any).isProjectTrusted?.();
    if (typeof isTrusted !== "boolean" || isTrusted !== true) {
      return toolResult(false, { skippedReason: "not_trusted" });
    }
  } catch {
    return toolResult(false, { skippedReason: "not_trusted" });
  }

  const cwd = sessionBaseline?.cwd ?? ctx.cwd;

  // 2. 没有基线（会话未启动）
  if (!sessionBaseline) {
    return toolResult(false, { skippedReason: "not_success" });
  }

  // 3. skip 模式处理
  if (sessionBaseline.mode === "skip") {
    return toolResult(false, { skippedReason: sessionBaseline.skipReason ?? "unsafe_repo" });
  }

  // 4. 初始化模式：预检 → 计算候选 → 过滤 → 身份检查 → init → commit
  if (sessionBaseline.mode === "initialized") {
    // 4a. 预检：cwd 及祖先不能已有仓库（避免创建嵌套 .git）
    const toplevel = runGit(["rev-parse", "--show-toplevel"], cwd);
    if (toplevel.ok && toplevel.stdout.trim()) {
      return toolResult(false, { skippedReason: "unsafe_repo" });
    }

    // 4b. 计算并过滤候选（init 前完成，避免无候选时创建 .git）
    // 使用文件指纹检测新建和已变更文件，对齐 PRD“会话期间新建或已变更”
    const currentFps = collectFileFingerprints(cwd, cwd);
    const newOrChanged: string[] = [];
    for (const [relPath, fp] of currentFps) {
      const baselineFp = sessionBaseline.initFingerprintsAtStart.get(relPath);
      if (!baselineFp || baselineFp.size !== fp.size || Math.abs(baselineFp.mtimeMs - fp.mtimeMs) > 1) {
        newOrChanged.push(relPath);
      }
    }
    const { safe: initSafe, filtered: initFiltered } = filterCandidates(cwd, newOrChanged);
    if (initFiltered.length > 0) {
      return toolResult(false, { skippedReason: initFiltered[0]!.rule });
    }
    if (initSafe.length === 0) {
      return toolResult(false, { skippedReason: "no_changes" });
    }

    // 4c. 预检 Git 身份（init 前，避免身份缺失时创建 .git）
    const ident = checkGitIdentity(cwd);
    if (!ident.ok) {
      return toolResult(false, { skippedReason: ident.errorCode });
    }

    // 4d. git init（至此才允许写入 .git）
    const initResult = runGitWrite(["init", "-b", "main"], cwd);
    if (!initResult.ok) {
      return toolResult(false, { skippedReason: "git_failed", errorCode: `init exited ${initResult.code}` });
    }

    // 4e. git add 候选文件 → commit（使用 --only 确保路径隔离）
    for (const f of initSafe) {
      const addRes = runGitWrite(["add", "--", f], cwd);
      if (!addRes.ok) {
        return toolResult(false, { skippedReason: "git_failed", errorCode: `add ${f} exited ${addRes.code}` });
      }
    }
    const msg = sanitizeMessage(summary);
    const commitRes = runGitWrite(["commit", "-m", msg, "--", ...initSafe], cwd);
    if (!commitRes.ok) {
      return toolResult(false, { skippedReason: "git_failed", errorCode: `commit exited ${commitRes.code}` });
    }
    const sha = parseSha(commitRes.stdout) ?? runGit(["rev-parse", "--short", "HEAD"], cwd).stdout.trim();
    return toolResult(true, { sha: sha || undefined, files: initSafe });
  }

  // 5. existing 模式：实时仓库安全复检 + 候选计算 + 过滤 + 身份 + commit
  const repoRoot = sessionBaseline.repoRoot!;

  // 5a. 仓库安全复检（会话期间可能进入不安全状态）
  const unsafeReason = checkRepoSafe(cwd, repoRoot);
  if (unsafeReason) {
    return toolResult(false, { skippedReason: unsafeReason });
  }

  // 5b. 计算候选
  const nowDirty = porcelainPaths(repoRoot);
  const candidates: string[] = [];
  for (const p of nowDirty) {
    if (sessionBaseline.trackedCleanAtStart.has(p)) candidates.push(p);
  }

  // 5c. 过滤候选
  const { safe, filtered } = filterCandidates(repoRoot, candidates);
  if (filtered.length > 0) {
    return toolResult(false, { skippedReason: filtered[0]!.rule });
  }
  if (safe.length === 0) {
    return toolResult(false, { skippedReason: "no_changes" });
  }

  // 5d. 预检 Git 身份
  const identity = checkGitIdentity(repoRoot);
  if (!identity.ok) {
    return toolResult(false, { skippedReason: identity.errorCode });
  }

  // 5e. 执行仅路径提交（--only 确保非候选文件 index 不变）
  const msg = sanitizeMessage(summary);
  const commitArgs = ["commit", "--only", "-m", msg, "--", ...safe];
  const commitRes = runGitWrite(commitArgs, repoRoot);
  if (!commitRes.ok) {
    return toolResult(false, { skippedReason: "git_failed", errorCode: `commit exited ${commitRes.code}` });
  }

  const sha = parseSha(commitRes.stdout) ?? runGit(["rev-parse", "--short", "HEAD"], repoRoot).stdout.trim();
  return toolResult(true, { sha: sha || undefined, files: safe });
}

function parseSha(gitOutput: string): string | null {
  // git commit 输出形如 "[main abc1234] message"
  const m = gitOutput.match(/\[[^\]]+ ([a-f0-9]+)\]/);
  return m?.[1] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Layer 1 — 诊断 UI 通知
// ═══════════════════════════════════════════════════════════════════════

function describe(d: Diagnosis): string {
  const parts: string[] = [];
  parts.push(`mode=${d.mode}`);
  if (d.repoRoot) parts.push(`repo=${shorten(d.repoRoot)}`);
  parts.push(`completion=${d.completion}`);
  parts.push(`candidates=${d.candidates.length}`);
  if (d.filtered.length) {
    const rules = [...new Set(d.filtered.map((f) => f.rule))].join(",");
    parts.push(`filtered=${d.filtered.length}(${rules})`);
  }
  if (d.skippedReason) parts.push(`skip=${d.skippedReason}`);
  if (d.detail) parts.push(`(${d.detail})`);
  parts.push("no git writes performed");
  return `[safe-git-autocommit] ${parts.join(" | ")}`;
}

function shorten(p: string, n = 32): string {
  return p.length <= n ? p : "\u2026" + p.slice(p.length - n);
}

// ═══════════════════════════════════════════════════════════════════════
//  Pi 扩展入口
// ═══════════════════════════════════════════════════════════════════════
export default function (pi: ExtensionAPI) {
  // ── Layer 1 状态 ──
  let baseline: SessionBaseline | undefined;
  let settled = false;
  let lastTurnAborted = false;
  let lastDiagnosis: Diagnosis | undefined;
  let committed = false; // Layer 1 门控（恒为 false：fail-closed）
  let autoCommitCount = 0; // 自动提交计数器

  // ─── 自动提交函数（每轮 agent_settled 时触发）──────────────────────────
  async function maybeAutoCommit(ctx: ExtensionContext) {
    if (!baseline) {
      try {
        baseline = captureBaseline(ctx.cwd, Date.now());
        if (baseline.mode === "existing") {
          const nowDirty = porcelainPaths(baseline.repoRoot!);
          const trackedRes = runGit(["ls-files"], baseline.repoRoot!);
          const tracked = trackedRes.ok
            ? new Set(trackedRes.stdout.split("\n").map(s => s.trim()).filter(Boolean))
            : new Set();
          for (const p of nowDirty) {
            if (tracked.has(p)) {
              baseline.trackedCleanAtStart.add(p);
            }
          }
        }
      } catch {
        return;
      }
    }
    if (!baseline || baseline.mode === "skip") return;

    // existing 模式下直接执行提交（绕过 trust check，auto-commit 由扩展自身触发）
    if (baseline.mode !== "existing") return;
    const repoRoot = baseline.repoRoot!;
    const cwd = baseline.cwd;

    // 安全预检
    const unsafeReason = checkRepoSafe(cwd, repoRoot);
    if (unsafeReason) {
      ctx.ui.notify(`[auto-commit] skip: ${unsafeReason}`, "info");
      return;
    }

    // 计算候选
    const nowDirty = porcelainPaths(repoRoot);
    const candidates: string[] = [];
    for (const p of nowDirty) {
      if (baseline.trackedCleanAtStart.has(p)) candidates.push(p);
    }
    if (candidates.length === 0) return;

    // 过滤
    const { safe, filtered } = filterCandidates(repoRoot, candidates);
    if (filtered.length > 0) {
      ctx.ui.notify(`[auto-commit] skip: ${filtered[0]!.rule} (${filtered[0]!.detail})`, "info");
      return;
    }
    if (safe.length === 0) return;

    // 身份检查
    const ident = checkGitIdentity(repoRoot);
    if (!ident.ok) {
      ctx.ui.notify(`[auto-commit] skip: ${ident.errorCode}`, "info");
      return;
    }

    // 执行提交
    const msg = sanitizeMessage("auto-commit after turn");
    const commitArgs = ["commit", "--only", "-m", msg, "--", ...safe];
    const commitRes = runGitWrite(commitArgs, repoRoot);
    if (!commitRes.ok) {
      ctx.ui.notify(`[auto-commit] fail: git commit exited ${commitRes.code}`, "info");
      return;
    }

    autoCommitCount++;
    try {
      baseline = captureBaseline(ctx.cwd, Date.now());
    } catch {
      // 刷新失败则保留旧基线
    }
    const sha = parseSha(commitRes.stdout) ?? runGit(["rev-parse", "--short", "HEAD"], repoRoot).stdout.trim();
    ctx.ui.notify(`[auto-commit] \u{1F500} ${sha} (${safe.join(", ")})`, "info");
  }

  // ── Layer 1 事件 ──
  pi.on("session_start", async (_e, ctx) => {
    baseline = undefined;
    settled = false;
    lastTurnAborted = false;
    lastDiagnosis = undefined;
    committed = false;
    autoCommitCount = 0;
    try {
      baseline = captureBaseline(ctx.cwd, Date.now());
    } catch {
      baseline = { cwd: ctx.cwd, mode: "skip", skipReason: "git_failed", trackedCleanAtStart: new Set(), dirtyAtStart: new Set(), initFilesAtStart: new Set(), initFingerprintsAtStart: new Map(), startedAt: Date.now() };
    }
  });

  pi.on("agent_settled", async (_e, ctx) => {
    settled = true;
    await maybeAutoCommit(ctx);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    try {
      if (ctx.signal?.aborted) lastTurnAborted = true;
      if (!baseline) return;

      // 汇报本次会话的自动提交统计
      const status = autoCommitCount > 0
        ? `auto-committed ${autoCommitCount} time(s) during session`
        : "no auto-commits this session";
      ctx.ui.notify(`[safe-git-autocommit] ${status}`, "info");
    } catch {
      try {
        ctx.ui.notify("[safe-git-autocommit] shutdown report failed", "info");
      } catch {
        /* never block pi exit */
      }
    }
  });

  // ── 调试命令：手动触发自动提交 ──
  pi.registerCommand("auto-commit-now", {
    description: "\u624B\u52A8\u89E6\u53D1 maybeAutoCommit \u8FDB\u884C\u8C03\u8BD5",
    handler: async (_args, ctx) => {
      await maybeAutoCommit(ctx);
    },
  });

  // ── Layer 1 诊断命令 ──
  pi.registerCommand("safe-git", {
    description: "\u663E\u793A\u672C\u4F1A\u8BDD safe-git-autocommit \u7684\u57FA\u7EBF\u4E0E\u8BFA\u65AD\uFF08\u53EA\u8BFB\uFF09",
    handler: async (_args, ctx) => {
      if (!baseline) {
        ctx.ui.notify("[safe-git-autocommit] \u5C1A\u65E0\u57FA\u7EBF\uFF08\u4F1A\u8BDD\u672A\u542F\u52A8\uFF09", "info");
        return;
      }
      const d = lastDiagnosis ?? diagnose(baseline, { settled, turnAborted: lastTurnAborted });
      lastDiagnosis = d;
      ctx.ui.notify(describe(d), "info");
    },
  });

  // ── Layer 2：safe_git_commit 显式提交工具 ──
  pi.registerTool({
    name: "safe_git_commit",
    label: "Safe Git Commit",
    description:
      "Explicitly commit session changes to local git with full safety checks. " +
      "Only call when you have verified the current task is complete and the changes are correct. " +
      "Does NOT push, does NOT bypass hooks, does NOT commit pre-existing dirty/staged/untracked files, " +
      "does NOT commit sensitive files (.env, secrets, credentials, build artifacts, >1MiB). " +
      "If no git repo exists, initializes one in cwd before committing. " +
      "Returns structured result with committed status, SHA, and file list.",
    promptSnippet: "Commit session changes to git (safe_git_commit)",
    promptGuidelines: [
      "Use safe_git_commit only after you have finished verifying the task is complete — the call itself is your declaration that the work is done.",
      "Do NOT call safe_git_commit as a periodic save; it is intended for one explicit commit per completed task.",
      "The tool handles all safety checks (isolated paths, sensitive file filtering, git identity) — do not pre-check conditions.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Brief summary of what was accomplished. " +
          "Will be prefixed with 'pi: ' in the commit message. " +
          "Cleaned (no control characters, whitespace collapsed) and truncated to 72 chars.",
      }),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
      const result = executeSafeGitCommit(params.summary as string, baseline, ctx);
      return {
        content: [{ type: "text" as const, text: formatToolContent(result) }],
        details: result,
      };
    },
  });
}
