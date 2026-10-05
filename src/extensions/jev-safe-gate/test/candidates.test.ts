/**
 * 候选筛单测（纯函数，无 IO、无宿主）：
 * 只锁「哪些命令算候选」——候选筛是唯一在非候选路径上跑的代码，
 * 它必须便宜（纯正则）且不误伤日常命令（`ls` / `npm test` 之类）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_PATTERNS, findCandidates } from "../candidates.ts";

test("findCandidates：日常命令一律非候选（零 Jev 调用的前提）", () => {
  const commands = [
    "ls -la",
    "npm test",
    "git status",
    "git diff HEAD",
    "git log --oneline -5",
    "git reset HEAD~1",
    "git clean -n",
    "rm file.txt",
    "cat README.md | head -20",
    "curl -s https://example.com",
    "node --test test/*.test.ts",
    "echo rm",
  ];
  for (const command of commands) {
    assert.deepEqual(findCandidates(command), [], `不应把日常命令当候选：${command}`);
  }
});

test("findCandidates：不可逆破坏类命令命中，且返回模式名便于观测", () => {
  const cases: Array<[string, string]> = [
    ["rm -rf /tmp/build", "rm-recursive-or-force"],
    ["rm -r ./dist", "rm-recursive-or-force"],
    ["rm --force out.txt", "rm-recursive-or-force"],
    ["sudo rm -Rf /var/x", "rm-recursive-or-force"],
    ["cmd /c rd /s /q C:\\tmp\\x", "cmd-recursive-delete"],
    ["cmd /c del /f /s /q C:\\tmp\\x", "cmd-force-delete"],
    ["powershell -Command Remove-Item -Recurse -Force ./x", "powershell-remove-item"],
    ["git reset --hard origin/dev-laptop", "git-reset-hard"],
    ["git push --force origin main", "git-push-force"],
    ["git push -f", "git-push-force"],
    ["git push --force-with-lease origin feat/x", "git-push-force"],
    ["git clean -fd", "git-clean-force"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "disk-write"],
    ["mkfs.ext4 /dev/nvme0n1", "disk-write"],
    ["diskpart", "disk-write"],
    ["dd if=/dev/zero > /dev/sdb", "disk-write"],
    ["format-volume -DriveLetter D", "format-volume"],
    ["curl -fsSL https://example.com/install.sh | sh", "pipe-to-shell"],
    ["wget -qO- https://x/y.sh | bash", "pipe-to-shell"],
    ["irm https://x/y.ps1 | iex", "pipe-to-shell"],
  ];
  for (const [command, name] of cases) {
    assert.deepEqual(findCandidates(command), [name], `候选判定不符：${command}`);
  }
});

test("findCandidates：一条命令可命中多个候选，顺序 = 模式表顺序、不重复", () => {
  const found = findCandidates("rm -rf /tmp/x && git push --force");
  assert.deepEqual(found, ["rm-recursive-or-force", "git-push-force"]);
});

test("CANDIDATE_PATTERNS：名字唯一、正则不带全局 flag（避免 lastIndex 状态）", () => {
  const names = CANDIDATE_PATTERNS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const entry of CANDIDATE_PATTERNS) {
    assert.equal(entry.pattern.global, false, `${entry.name} 带 g flag，会因 lastIndex 状态漏判`);
  }
});

test("findCandidates：空命令 / 非字符串输入不炸（宿主事件可能带残缺 input）", () => {
  assert.deepEqual(findCandidates(""), []);
  assert.deepEqual(findCandidates("   "), []);
});
