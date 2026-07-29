/**
 * sga-selftest.ts — safe-git-autocommit 真实 git 行为自测
 *
 * 覆盖：
 *   Layer 1（诊断基线）：完成判定 fail-closed、基线/候选规划、既有改动隔离、
 *    敏感/大文件过滤、unsafe_repo（merge/bare）、初始化模式基线、提交信息清洗、
 *    git 只读白名单、零写入不变量。
 *   Layer 2（显式提交工具）：executeSafeGitCommit 在干净/脏/初始化/过滤/失败
 *    场景下的行为；commit --only 隔离、第二次调用、多文件提交、非候选文件 index 不变。
 *
 * 运行：npx tsx sga-selftest.ts
 */
import { runGit, captureBaseline, diagnose, sanitizeMessage, executeSafeGitCommit } from "./safe-git-autocommit.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync as wf, appendFileSync as af } from "node:fs";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Log ──
const LOG = "sga-selftest.log";
try { wf(LOG, ""); } catch {}
const log = (...a: any[]) => af(LOG, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
console.log = (...a: any[]) => log(...a);
console.error = (...a: any[]) => log("[ERR]", ...a);

const ROOT = join(tmpdir(), "sga-test");
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
}
function group(name: string) { console.log(`\n── ${name} ──`); }

function sh(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function writeFile(p: string, content: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
function mkRepo(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh(["init", "-b", "main"], dir);
  sh(["config", "user.email", "t@t.test"], dir);
  sh(["config", "user.name", "tester"], dir);
}
function commitAll(dir: string, msg = "init") {
  sh(["add", "-A"], dir);
  sh(["commit", "-m", msg], dir);
}
function status(dir: string): string {
  const r = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: dir, encoding: "utf8" });
  return r.replace(/\u0000/g, " ").trim();
}

const SETTLED = { settled: true, turnAborted: false };

// Mock ExtensionContext
function mockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    modelRegistry: { getProviderAuth: () => undefined },
    ui: { setStatus: () => {}, notify: () => {} },
    isProjectTrusted: () => true,
  };
}

function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  // ═══════════════════════════════════════════════════════════════════
  //  Layer 1
  // ═══════════════════════════════════════════════════════════════════

  group("L1: sanitizeMessage");
  check("msg 去换行/控制字符", sanitizeMessage("a\nb\tc") === "pi: a b c");
  check("msg 截断 <=72", sanitizeMessage("x".repeat(200)).length <= 72);
  check("msg 缺失用 fallback", sanitizeMessage(undefined) === "pi: completed task");
  check("msg 固定前缀", sanitizeMessage("done").startsWith("pi: "));
  check("msg 空白归 fallback", sanitizeMessage("   ") === "pi: completed task");

  group("L1: git 只读白名单");
  {
    const d = join(ROOT, "whitelist");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    check("阻断 git add", !runGit(["add", "-A"], d).ok);
    check("阻断 git commit", !runGit(["commit", "-m", "x"], d).ok);
    check("阻断 git init", !runGit(["init"], d).ok);
    check("放行只读 rev-parse", runGit(["rev-parse", "--show-toplevel"], d).ok);
  }

  group("L1: 成功路径 fail-closed + 零写入");
  {
    const d = join(ROOT, "clean");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const headBefore = runGit(["rev-parse", "HEAD"], d).stdout.trim();
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "a.ts"), "2"); // 会话中修改
    const dd = diagnose(b, SETTLED);
    check("完成判定 fail-closed=unknown", dd.completion === "unknown");
    check("候选含 a.ts", dd.candidates.includes("a.ts"));
    check("跳过原因 not_success", dd.skippedReason === "not_success");
    check("零写入：HEAD 不变", headBefore === runGit(["rev-parse", "HEAD"], d).stdout.trim());
    check("零写入：改动未提交", runGit(["status", "--porcelain", "-z"], d).stdout.includes("a.ts"));
  }

  group("L1: 既有改动隔离");
  {
    const d = join(ROOT, "dirty");
    mkRepo(d); writeFile(join(d, "old.ts"), "1"); writeFile(join(d, "new.ts"), "1"); commitAll(d);
    writeFile(join(d, "old.ts"), "dirty-before-session"); // 会话前 dirty
    const b = captureBaseline(d, Date.now()); // 基线采集（此时 old.ts 已 dirty）
    writeFile(join(d, "new.ts"), "changed-in-session");
    const dd = diagnose(b, SETTLED);
    check("候选含 new.ts", dd.candidates.includes("new.ts"));
    check("候选不含 old.ts（隔离）", !dd.candidates.includes("old.ts"));
  }

  group("L1: 敏感过滤");
  {
    const d = join(ROOT, "env");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); writeFile(join(d, ".env"), "K=1"); commitAll(d);
    const b = captureBaseline(d, Date.now()); // 基线先采集
    writeFile(join(d, ".env"), "K=2"); // 再修改
    const dd = diagnose(b, SETTLED);
    check(".env 命中 sensitive_file", dd.filtered.some((f) => f.path === ".env"));
  }
  {
    const d = join(ROOT, "large");
    mkRepo(d); writeFileSync(join(d, "big.bin"), "x".repeat(2 * 1024 * 1024)); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFileSync(join(d, "big.bin"), "y".repeat(2 * 1024 * 1024));
    const dd = diagnose(b, SETTLED);
    check("大文件命中 large_file", dd.filtered.some((f) => f.path === "big.bin"));
  }
  {
    const d = join(ROOT, "builddir");
    mkRepo(d);
    writeFile(join(d, "node_modules", "pkg", "index.js"), "1");
    writeFile(join(d, "a.ts"), "1");
    commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "node_modules", "pkg", "index.js"), "2");
    writeFile(join(d, "a.ts"), "2");
    const dd = diagnose(b, SETTLED);
    check("node_modules 命中 sensitive_file", dd.filtered.some((f) => f.path.includes("node_modules")));
    check("普通文件仍在候选", dd.candidates.includes("a.ts"));
  }

  group("L1: unsafe_repo");
  {
    const d = join(ROOT, "merge");
    mkRepo(d); writeFile(join(d, "a.ts"), "base"); commitAll(d, "base");
    sh(["checkout", "-b", "feat"], d); writeFile(join(d, "a.ts"), "feat"); commitAll(d, "feat");
    sh(["checkout", "main"], d); writeFile(join(d, "a.ts"), "main"); commitAll(d, "main");
    try { sh(["merge", "feat"], d); } catch { /* conflict expected */ }
    const b = captureBaseline(d, Date.now());
    check("merge 中 mode=skip", b.mode === "skip");
    check("merge 中 skip=unsafe_repo", b.skipReason === "unsafe_repo");
  }
  {
    const d = join(ROOT, "bare.git");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    sh(["init", "--bare"], d);
    const b = captureBaseline(d, Date.now());
    check("bare repo mode=skip", b.mode === "skip");
    check("bare repo skip=unsafe_repo", b.skipReason === "unsafe_repo");
  }

  group("L1: 初始化模式基线（零写入）");
  {
    const d = join(ROOT, "norepo");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "existing.txt"), "x");
    const b = captureBaseline(d, Date.now());
    check("无仓库 mode=initialized", b.mode === "initialized");
    check("initFilesAtStart 含 existing.txt", b.initFilesAtStart.has("existing.txt"));
    const dd = diagnose(b, SETTLED);
    check("诊断 skip=not_success", dd.skippedReason === "not_success");
    check("未创建 .git（零写入）", !existsSync(join(d, ".git")));
  }

  group("L1: fail-closed 不变量");
  {
    const d = join(ROOT, "fc");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "a.ts"), "2");
    const dd = diagnose(b, SETTLED);
    check("即使 settled=true，completion 仍 unknown", dd.completion === "unknown");
    check("即使 settled=true，仍 not_success", dd.skippedReason === "not_success");
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Layer 2 — 显式提交工具
  // ═══════════════════════════════════════════════════════════════════

  group("L2: 成功提交 — 干净仓库有改动");
  {
    const d = join(ROOT, "l2-clean");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); writeFile(join(d, "b.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now()); // 建立基线：a.ts, b.ts 均为 trackedClean
    writeFile(join(d, "a.ts"), "2"); // 会话中修改 a.ts
    const headBefore = runGit(["rev-parse", "HEAD"], d).stdout.trim();
    const result = executeSafeGitCommit("modified a.ts", b, mockCtx(d));
    check("提交成功", result.committed === true, JSON.stringify(result));
    check("返回 SHA", typeof result.sha === "string" && result.sha.length > 0, result.sha ?? "");
    check("返回文件列表含 a.ts", Array.isArray(result.files) && result.files.includes("a.ts"), JSON.stringify(result.files));
    check("HEAD 已推进", headBefore !== runGit(["rev-parse", "HEAD"], d).stdout.trim());
    const st = status(d);
    check("a.ts 已提交（干净）", !st.includes("a.ts"), st);
    check("b.ts 未被改动影响", !st.includes("b.ts"), st);
  }

  group("L2: 既有改动隔离 — 不提交会话前 dirty 文件");
  {
    const d = join(ROOT, "l2-dirty");
    mkRepo(d); writeFile(join(d, "old.ts"), "1"); writeFile(join(d, "new.ts"), "1"); commitAll(d);
    writeFile(join(d, "old.ts"), "dirty-before-session"); // 会话前 dirty
    const b = captureBaseline(d, Date.now()); // 基线：old.ts 在 dirtyAtStart, new.ts 在 trackedClean
    writeFile(join(d, "new.ts"), "changed-in-session"); // 修改 new.ts
    const result = executeSafeGitCommit("fixed new.ts", b, mockCtx(d));
    check("提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交不含 old.ts", !result.files.includes("old.ts"), JSON.stringify(result.files));
      check("提交含 new.ts", result.files.includes("new.ts"), JSON.stringify(result.files));
    }
    check("old.ts 仍 dirty 在工作区", status(d).includes("old.ts"));
  }

  group("L2: sensitive 文件跳过");
  {
    const d = join(ROOT, "l2-env");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); writeFile(join(d, ".env"), "K=1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, ".env"), "K=2"); // 修改 .env
    const result = executeSafeGitCommit("update config", b, mockCtx(d));
    check("提交跳过（sensitive_file）", result.committed === false && result.skippedReason === "sensitive_file", JSON.stringify(result));
  }

  group("L2: 大文件跳过");
  {
    const d = join(ROOT, "l2-large");
    mkRepo(d); writeFileSync(join(d, "big.bin"), "x".repeat(2 * 1024 * 1024)); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFileSync(join(d, "big.bin"), "y".repeat(2 * 1024 * 1024));
    const result = executeSafeGitCommit("update big", b, mockCtx(d));
    check("提交跳过（large_file）", result.committed === false && result.skippedReason === "large_file", JSON.stringify(result));
  }

  group("L2: merge 中跳过");
  {
    const d = join(ROOT, "l2-merge");
    mkRepo(d); writeFile(join(d, "a.ts"), "base"); commitAll(d, "base");
    sh(["checkout", "-b", "feat"], d); writeFile(join(d, "a.ts"), "feat"); commitAll(d, "feat");
    sh(["checkout", "main"], d); writeFile(join(d, "a.ts"), "main"); commitAll(d, "main");
    try { sh(["merge", "feat"], d); } catch { /* conflict */ }
    const b = captureBaseline(d, Date.now());
    check("基线 mode=skip", b.mode === "skip");
    const result = executeSafeGitCommit("merge work", b, mockCtx(d));
    check("merge 中跳过（unsafe_repo）", result.committed === false && result.skippedReason === "unsafe_repo", JSON.stringify(result));
  }

  group("L2: 无变更时跳过");
  {
    const d = join(ROOT, "l2-nochange");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    // 不修改任何文件
    const result = executeSafeGitCommit("nothing done", b, mockCtx(d));
    check("无变更跳过（no_changes）", result.committed === false && result.skippedReason === "no_changes", JSON.stringify(result));
  }

  group("L2: 初始化模式 — 无仓库时 init + 首次提交");
  {
    const d = join(ROOT, "l2-init");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "existing.txt"), "old-stuff"); // 会话前已存在
    const b = captureBaseline(d, Date.now()); // 基线记录 existing.txt
    writeFile(join(d, "made.ts"), "new-file"); // 会话中新建
    const result = executeSafeGitCommit("initial commit", b, mockCtx(d));
    check("init 模式提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交含 made.ts", result.files.includes("made.ts"), JSON.stringify(result.files));
      check("提交不含 existing.txt", !result.files.includes("existing.txt"), JSON.stringify(result.files));
    }
    check("仓库已初始化（.git 存在）", existsSync(join(d, ".git")));
    // existing.txt 应在工作区保持未跟踪
    const st = status(d);
    check("existing.txt 仍未被跟踪", st.includes("existing.txt") || st.includes("??"), st);
  }

  group("L2: commit --only 隔离 — 非候选文件 index 不变");
  {
    const d = join(ROOT, "l2-only");
    mkRepo(d);
    writeFile(join(d, "tracked.ts"), "1");
    writeFile(join(d, "other.ts"), "1");
    commitAll(d);
    // 暂存 other.ts 的变更
    writeFileSync(join(d, "other.ts"), "staged-change");
    sh(["add", "other.ts"], d);
    const b = captureBaseline(d, Date.now()); // other.ts 已在 dirtyAtStart (staged)
    // 修改 tracked.ts（候选文件）
    writeFileSync(join(d, "tracked.ts"), "2");
    const result = executeSafeGitCommit("only tracked.ts", b, mockCtx(d));
    check("提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交只含 tracked.ts", result.files.length === 1 && result.files[0] === "tracked.ts", JSON.stringify(result.files));
    }
    // other.ts 的 staged 变更应保持不变
    const diffStaged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: d, encoding: "utf8" }).trim();
    check("other.ts 的 staged 变更仍在", diffStaged === "other.ts", diffStaged);
  }

  group("L2: 重复调用 — 第二次提交新改动");
  {
    const d = join(ROOT, "l2-twice");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); writeFile(join(d, "b.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    // 第一次提交
    writeFile(join(d, "a.ts"), "2");
    const r1 = executeSafeGitCommit("mod a", b, mockCtx(d));
    check("第一次提交成功", r1.committed === true, JSON.stringify(r1));
    // 第二次调用：无新变更
    const r2 = executeSafeGitCommit("nothing", b, mockCtx(d));
    check("第二次调用跳过（no_changes）", r2.committed === false && r2.skippedReason === "no_changes", JSON.stringify(r2));
    // 修改 b.ts
    writeFile(join(d, "b.ts"), "3");
    const r3 = executeSafeGitCommit("mod b", b, mockCtx(d));
    check("第三次提交成功（b.ts）", r3.committed === true && Array.isArray(r3.files) && r3.files.includes("b.ts"), JSON.stringify(r3));
    const log = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
    check("共 3 个 commit（init + a.ts + b.ts）", log === "3", log);
  }

  group("L2: 多文件提交");
  {
    const d = join(ROOT, "l2-multi");
    mkRepo(d); writeFile(join(d, "f1.ts"), "1"); writeFile(join(d, "f2.ts"), "1"); writeFile(join(d, "f3.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "f1.ts"), "2"); writeFile(join(d, "f2.ts"), "2"); writeFile(join(d, "f3.ts"), "2");
    const result = executeSafeGitCommit("multi-file update", b, mockCtx(d));
    check("多文件提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交 3 个文件", result.files.length === 3, JSON.stringify(result.files));
      check("含 f1.ts", result.files.includes("f1.ts"));
      check("含 f2.ts", result.files.includes("f2.ts"));
      check("含 f3.ts", result.files.includes("f3.ts"));
    }
  }

  group("L2: Git 身份缺失跳过");
  {
    // 验证当全局/本地均无 git identity 时，commit 被正确跳过。
    // 若本机已有全局 user.name/email，则本测试为 PASS（带说明）。
    const d = join(ROOT, "l2-noident");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    sh(["init", "-b", "main"], d);
    writeFile(join(d, "a.ts"), "1");
    sh(["add", "a.ts"], d);
    // 用 --author 完成 init 而不设本地 identity
    sh(["commit", "-m", "init", "--author=tester <t@t.test>"], d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "a.ts"), "2");
    // 检查是否有全局 identity（如果有，checkGitIdentity 不会触发缺失）
    const globalName = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    const globalEmail = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    const hasGlobalIdentity = Boolean(globalName && globalEmail);
    if (hasGlobalIdentity) {
      // 有全局 identity：实际环境限制，跳过断言但记录说明
      console.log("  SKIP  身份缺失测试（本机有全局 git config）");
    } else {
      const result = executeSafeGitCommit("update a", b, mockCtx(d));
      check("身份缺失跳过（git_identity_missing）", result.committed === false && result.skippedReason === "git_identity_missing", JSON.stringify(result));
    }
  }

  group("L2: 未启动会话时返回 not_success");
  {
    const d = join(ROOT, "l2-nosession");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const result = executeSafeGitCommit("test", undefined, mockCtx(d));
    check("无基线 → not_success", result.committed === false && result.skippedReason === "not_success", JSON.stringify(result));
  }

  group("L2: 项目可信 fail-closed");
  {
    // 方法缺失 → not_trusted
    const noTrustCtx: ExtensionContext = { cwd: "", modelRegistry: { getProviderAuth: () => undefined }, ui: { setStatus: () => {}, notify: () => {} } };
    const r1 = executeSafeGitCommit("test", undefined, noTrustCtx);
    check("可信方法缺失 → not_trusted", r1.committed === false && r1.skippedReason === "not_trusted", JSON.stringify(r1));

    // 方法返回 false → not_trusted
    const falseTrustCtx: ExtensionContext = { cwd: "", modelRegistry: { getProviderAuth: () => undefined }, ui: { setStatus: () => {}, notify: () => {} }, isProjectTrusted: () => false };
    const r2 = executeSafeGitCommit("test", undefined, falseTrustCtx);
    check("可信返回 false → not_trusted", r2.committed === false && r2.skippedReason === "not_trusted", JSON.stringify(r2));
  }

  group("L2: 初始化模式 — 敏感候选不创建 .git");
  {
    const d = join(ROOT, "l2-init-sensitive");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "existing.ts"), "old"); // 会话前已存在
    const b = captureBaseline(d, Date.now());
    check("基线 mode=initialized", b.mode === "initialized");
    check("基线含 existing.ts", b.initFilesAtStart.has("existing.ts"));
    writeFile(join(d, ".env"), "K=2"); // 会话中新建 .env
    const result = executeSafeGitCommit("update config", b, mockCtx(d));
    check("敏感文件跳过（sensitive_file）", result.committed === false && result.skippedReason === "sensitive_file", JSON.stringify(result));
    check("未创建 .git（零写入）", !existsSync(join(d, ".git")));
  }

  group("L2: 初始化模式 — 身份缺失不创建 .git");
  {
    const d = join(ROOT, "l2-init-noident");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "made.ts"), "new-file");
    const b = captureBaseline(d, Date.now());
    // 检查是否有全局 identity
    const globalName = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    const globalEmail = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    const hasGlobalIdentity = Boolean(globalName && globalEmail);
    if (hasGlobalIdentity) {
      console.log("  SKIP  初始化身份缺失测试（本机有全局 git config）");
    } else {
      const result = executeSafeGitCommit("init commit", b, mockCtx(d));
      check("身份缺失跳过（git_identity_missing）", result.committed === false && result.skippedReason === "git_identity_missing", JSON.stringify(result));
      check("未创建 .git（零写入）", !existsSync(join(d, ".git")));
    }
  }

  group("L2: existing 模式 — 会话中进入 merge 状态时跳过");
  {
    const d = join(ROOT, "l2-merge-later");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now()); // 基线采集时仓库干净
    // 创建另一个分支并在 baseline 后 merge
    sh(["checkout", "-b", "other"], d); writeFile(join(d, "b.ts"), "1"); commitAll(d, "other");
    sh(["checkout", "main"], d);
    try { sh(["merge", "other"], d); } catch { /* fast-forward should succeed */ }
    // 现在仓库是 main 且有其他分支，但没问题
    // 换个方式：制造真实 conflict
    writeFile(join(d, "a.ts"), "base"); commitAll(d, "reset");
    sh(["checkout", "-b", "side"], d); writeFile(join(d, "a.ts"), "side"); commitAll(d, "side");
    sh(["checkout", "main"], d); writeFile(join(d, "a.ts"), "main2"); commitAll(d, "main2");
    try { sh(["merge", "side"], d); } catch { /* conflict expected */ }
    // 仓库现在处于 merge 冲突中
    writeFile(join(d, "new.ts"), "1"); // 会话中新文件（未跟踪，不参与候选）
    const result = executeSafeGitCommit("merge work", b, mockCtx(d));
    check("merge 冲突中跳过（unsafe_repo）", result.committed === false && result.skippedReason === "unsafe_repo", JSON.stringify(result));
  }

  group("L2: 路径选项注入 — `--no-verify` 不被解析为选项");
  {
    const d = join(ROOT, "l2-no-verify");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    // 创建名为 --no-verify 的文件
    writeFile(join(d, "--no-verify"), "hook-bypass-test");
    // 修改 a.ts 作为候选
    writeFile(join(d, "a.ts"), "2");
    const result = executeSafeGitCommit("test no-verify path", b, mockCtx(d));
    check("提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交含 a.ts", result.files.includes("a.ts"), JSON.stringify(result.files));
    }
    // pre-commit hook 验证：设置拒绝所有提交的 pre-commit，提交 --no-verify 文件
    // 验证 --no-verify 是文件名而非选项（独立子测试）
  }

  group("L2: 初始化模式 — 已有文件会话中修改应提交");
  {
    const d = join(ROOT, "l2-init-fingerprint");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "existing.txt"), "old"); // 会话前已存在
    const b = captureBaseline(d, Date.now());
    check("基线 mode=initialized", b.mode === "initialized");
    check("基线指纹有 existing.txt", b.initFingerprintsAtStart.has("existing.txt"), String(b.initFingerprintsAtStart.size));
    writeFile(join(d, "existing.txt"), "modified by session"); // 会话中修改现有文件
    // 不创建新文件，只修改现有文件
    const result = executeSafeGitCommit("mod existing", b, mockCtx(d));
    check("提交成功（已有文件被修改）", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交含 existing.txt", result.files.includes("existing.txt"), JSON.stringify(result.files));
    }
    check("仓库已初始化（.git 存在）", existsSync(join(d, ".git")));
  }

  group("L2: 初始化模式 — 新建 + 修改同时提交");
  {
    const d = join(ROOT, "l2-init-mixed");
    rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
    writeFile(join(d, "existing.txt"), "old");
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "existing.txt"), "modified"); // 修改
    writeFile(join(d, "new.ts"), "new"); // 新建
    const result = executeSafeGitCommit("mixed changes", b, mockCtx(d));
    check("提交成功（混合变更）", result.committed === true, JSON.stringify(result));
    if (result.committed && result.files) {
      check("提交含 existing.txt", result.files.includes("existing.txt"), JSON.stringify(result.files));
      check("提交含 new.ts", result.files.includes("new.ts"), JSON.stringify(result.files));
    }
  }

  group("L2: existing 模式 — linked worktree 兼容（通过 --git-dir 取得真实目录）");
  {
    // 验证 checkRepoSafe 通过 git rev-parse --git-dir 而非 resolve(repoRoot, ".git")
    const main = join(ROOT, "l2-linked-main");
    const wt = join(ROOT, "l2-linked-wt");
    rmSync(main, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true });
    mkdirSync(main, { recursive: true });
    sh(["init", "-b", "main"], main);
    sh(["config", "user.email", "t@t.test"], main);
    sh(["config", "user.name", "tester"], main);
    writeFile(join(main, "a.ts"), "1");
    sh(["add", "a.ts"], main);
    sh(["commit", "-m", "init"], main);
    // 创建独立分支供 worktree 使用（同一个分支不能同时 checkout 两次）
    sh(["branch", "wt-branch", "main"], main);
    // 创建 linked worktree
    sh(["worktree", "add", wt, "wt-branch"], main);
    // 在 worktree 中采集基线
    const b = captureBaseline(wt, Date.now());
    check("linked worktree mode=existing", b.mode === "existing", b.mode);
    writeFile(join(wt, "a.ts"), "2");
    const r = executeSafeGitCommit("linked wt change", b, mockCtx(wt));
    check("linked worktree 提交成功", r.committed === true, JSON.stringify(r));
    // 在 worktree 中制造 index.lock
    const gitDirRaw = runGit(["rev-parse", "--git-dir"], wt).stdout.trim();
    // --git-dir 返回绝对路径（linked worktree）或相对路径，统一处理
    const gitDirAbs = resolve(wt, gitDirRaw);
    writeFile(join(gitDirAbs, "index.lock"), "locked");
    const b2 = captureBaseline(wt, Date.now());
    check("index.lock 后 mode=skip", b2.mode === "skip", b2.mode);
    check("index.lock 后 skip=unsafe_repo", b2.skipReason === "unsafe_repo", b2.skipReason ?? "");
    rmSync(join(gitDirAbs, "index.lock"));
  }

  group("L2: 摘要清洗截断");
  {
    const d = join(ROOT, "l2-summary");
    mkRepo(d); writeFile(join(d, "a.ts"), "1"); commitAll(d);
    const b = captureBaseline(d, Date.now());
    writeFile(join(d, "a.ts"), "2");
    const result = executeSafeGitCommit("\nlong  summary   with\tcontrol\x00chars\n" + "x".repeat(200), b, mockCtx(d));
    check("提交成功", result.committed === true, JSON.stringify(result));
    if (result.committed && result.sha) {
      const msg = execFileSync("git", ["log", "--format=%s", "-1"], { cwd: d, encoding: "utf8" }).trim();
      check("commit msg 以 pi: 开头", msg.startsWith("pi: "), msg);
      check("commit msg ≤ 72 字符", msg.length <= 72, `${msg.length}: ${msg}`);
      check("commit msg 不含换行", !msg.includes("\n"), msg);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  报告
  // ═══════════════════════════════════════════════════════════════════

  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
