/**
 * agent-team — leader system prompt assembly
 *
 * The leader's system prompt = the user-authored strategy prompt (verbatim,
 * first — this is where the team owner teaches the leader HOW to complete
 * tasks) + a generated roster of the team + `team_dispatch` usage rules +
 * the required final report format.
 */

import type { TeamConfig } from "./types.ts";
import { MAX_PARALLEL_MEMBERS, MAX_TASKS_PER_DISPATCH } from "./types.ts";

function rosterLines(team: TeamConfig): string[] {
  const lines: string[] = ["## 团队成员", ""];
  for (const member of team.members) {
    const parts = [`model: ${member.model ?? "（继承 pi 默认模型）"}`];
    if (member.tools && member.tools.length > 0) parts.push(`tools: ${member.tools.join(",")}`);
    if (member.worktree) parts.push("在独立 git worktree 中工作");
    const desc = member.description ? ` — ${member.description}` : "";
    lines.push(`- **${member.name}**${desc}（${parts.join("；")}）`);
  }
  return lines;
}

/**
 * Builds the full leader system prompt. Deterministic and pure — covered
 * by unit tests. `sharedWorktree` is set when the team runs in a team-level
 * shared git worktree.
 */
export function buildLeaderSystemPrompt(
  team: TeamConfig,
  sharedWorktree?: { path: string; branch: string },
): string {
  const sections: string[] = [];

  sections.push(team.leader.prompt.trim());

  sections.push(
    [
      "",
      "---",
      "",
      "# 你的团队",
      "",
      `你负责的团队：**${team.name}**${team.description ? `（${team.description}）` : ""}。`,
      "",
      ...rosterLines(team),
      sharedWorktree
        ? `\n## 工作区\n\n本次运行在团队共享 git worktree 中进行：\`${sharedWorktree.path}\`（分支 \`${sharedWorktree.branch}\`）。你和所有未单独配置 worktree 的成员的全部文件改动都发生在这个 worktree 内，主工作目录不受影响；运行结束后由用户决定如何合并该分支。`
        : "",
      team.notes ? `\n## 团队补充说明\n\n${team.notes.trim()}` : "",
    ].join("\n"),
  );

  sections.push(
    [
      "---",
      "",
      "# 调度工具：team_dispatch",
      "",
      "通过 `team_dispatch` 工具把子任务派发给成员。参数：",
      "",
      "```json",
      `{ "tasks": [{ "agent": "<成员名>", "task": "<具体子任务描述>" }] }`,
      "```",
      "",
      `规则：`,
      `- 一次调用可包含 1~${MAX_TASKS_PER_DISPATCH} 个子任务；相互独立的子任务放在同一次调用里并行执行（最多 ${MAX_PARALLEL_MEMBERS} 个同时运行）。`,
      "- 有依赖的子任务分多次调用：先派前置任务，拿到结果后再派后续任务（可以把前一个成员的结果要点写进下一个子任务的描述里）。",
      "- task 描述必须自包含：成员看不到你们的对话历史，只看到这段文字。写清目标、涉及文件/路径、约束和期望产出。",
      `- agent 必须是花名册里的成员名，不能派发给团队之外的 agent。`,
      "- 成员结果会按成员分节返回给你。审查每份结果：不符合要求就再次派单返工（把问题点写具体）。",
      "- 环境级失败（worktree/git 不可用、成员或模型不存在、子进程启动失败）重试必然再次失败：不要再次派发给失败的成员，调整方案或直接输出最终报告。",
      `- 派发有预算上限（${"单次 run 最多 12 次 dispatch 调用 / 40 次成员运行"}）：接近或达到上限时，立即基于已有结果输出最终报告。`,
      "- 除琐碎的读写外，不要亲自完成本应派给成员的工作；你的职责是拆解、派发、审查、整合。",
      "",
    ].join("\n"),
  );

  sections.push(
    [
      "---",
      "",
      "# 最终报告（完成时的最后一条回复）",
      "",
      "任务完成（或无法完成）后，用以下格式输出最终报告：",
      "",
      "```",
      "## 结论",
      "任务是否完成、结果一句话概括。",
      "## 各成员贡献",
      "每个成员做了什么（一两行）。",
      "## 变更与产出",
      "涉及/产出的文件路径、分支（worktree 成员附 worktree 路径与分支名）、关键代码或数据。",
      "## 风险与后续",
      "遗留问题、建议的下一步。",
      "```",
      "",
      "最终报告之外不要输出多余的过程叙述。",
    ].join("\n"),
  );

  return sections.join("\n").trim() + "\n";
}
