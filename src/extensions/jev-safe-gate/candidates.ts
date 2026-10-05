/**
 * jev-safe-gate — 候选筛（便宜、纯函数、只跑正则）
 *
 * 门的第一层过滤：只有命中这里才值得花一次 Jev 判断（一次分类调用 = 一次网络
 * 往返 + 延迟 + 钱）。所以本模块的判据是**宁可多报、绝不漏报明显不可逆的动作**，
 * 同时保证日常命令（`ls` / `npm test` / `git status`）一个字节都不命中。
 *
 * 判据是"不可逆"而不是"看起来凶"：`rm -rf`、`git reset --hard`、force push、
 * 磁盘/格式化写入、把网络内容直接灌进 shell —— 都是事后无法用 git / 备份找回的动作。
 * 正则一律不加 `g` flag（避免 lastIndex 状态导致漏判），大小写不敏感以覆盖
 * `-R` / `Remove-Item` 之类的写法。
 */

export interface CandidatePattern {
  /** 模式名：进日志与状态条原因，也是测试的断言锚点。 */
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * 候选模式表（顺序 = 报告顺序）。新增模式必须同时补 `test/candidates.test.ts`
 * 的命中/不命中用例——这张表宽一格就多花一次分类调用，窄一格就漏一道门。
 */
export const CANDIDATE_PATTERNS: readonly CandidatePattern[] = [
  // rm 的递归或强制删除（-rf / -fr / -r / --force / sudo rm -Rf）
  { name: "rm-recursive-or-force", pattern: /\brm\b[^\n]*(?:\s-[a-z]*r|--recursive|--force)/i },
  // cmd.exe 的递归删除 rd /s、rmdir /s /q
  { name: "cmd-recursive-delete", pattern: /\b(?:rd|rmdir)\s+\/[a-z]*s/i },
  // cmd.exe 的强制删除 del /f /s /q
  { name: "cmd-force-delete", pattern: /\bdel\s+\/[a-z]*[fsq]/i },
  // PowerShell Remove-Item -Recurse / -Force（含别名 ri）
  { name: "powershell-remove-item", pattern: /\b(?:remove-item|ri)\b[^\n]*\s-(?:recurse|force)/i },
  // 丢弃本地提交/工作区改动
  { name: "git-reset-hard", pattern: /\bgit\s+reset\b[^\n]*--hard/ },
  // 强推（--force-with-lease 也算：它覆盖远端历史）
  { name: "git-push-force", pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-[a-z]*f\b)/i },
  // 清理未跟踪文件/目录
  { name: "git-clean-force", pattern: /\bgit\s+clean\b[^\n]*\s-[a-z]*f/i },
  // 裸写块设备 / 建文件系统 / 分区工具
  { name: "disk-write", pattern: /(?:\bdd\s+[^\n]*of=|>[^\n]*\/dev\/[sh]d\w|\bmkfs(?:\.\w+)?\b|\bdiskpart\b|\bfdisk\b|\bparted\b)/i },
  // 格式化卷 / 格式化盘符
  { name: "format-volume", pattern: /\b(?:format-volume|format\s+[a-z]:)/i },
  // 网络内容直灌 shell/解释器（下载即执行）
  { name: "pipe-to-shell", pattern: /\b(?:curl|wget|invoke-webrequest|iwr|irm)\b[^\n]*\|[^\n]*\b(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell|iex|node|python\d?)\b/i },
];

/** 命中的候选模式名（保序、去重）；空数组 = 非候选，调用方必须零分类调用。 */
export function findCandidates(command: string): string[] {
  if (typeof command !== "string" || command.trim() === "") return [];
  const found: string[] = [];
  for (const entry of CANDIDATE_PATTERNS) {
    if (entry.pattern.test(command) && !found.includes(entry.name)) found.push(entry.name);
  }
  return found;
}
