/**
 * agent-team — conversation-driven team management tools (cockpit mode)
 *
 * `team_create` lets the MAIN agent create a reusable team definition file
 * from a conversation ("建一个前端+后端团队，leader 用 opus"). `team_list`
 * shows what already exists so the agent reuses teams instead of creating
 * duplicates. Both are thin wrappers over config.ts (validate + write).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildTeamFromToolInput, createTeamFile, discoverTeams, globalTeamsDir } from "./config.ts";
import { MAX_RESULT_BYTES, truncateUtf8, type TeamConfig } from "./types.ts";

export interface ManageDeps {
  /** Test seams: override the team directories. */
  globalDir?: string;
  cwd?: string;
}

const memberSchema = Type.Object({
  name: Type.String({ description: "成员名（英文短名，如 frontend）" }),
  description: Type.Optional(Type.String({ description: "一句话职责描述" })),
  model: Type.Optional(Type.String({ description: "后端模型，格式 provider/id（如 anthropic/claude-opus-4-5、chatanywhere/gpt-5.6）；留空则用 pi 默认模型" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "允许的工具白名单（如 read, edit, bash）；留空则不限制" })),
  worktree: Type.Optional(Type.Boolean({ description: "是否在独立 git worktree 中工作（默认 false，共享当前目录）" })),
  prompt: Type.String({ description: "该成员的专属 system prompt（角色、约束、输出格式）" }),
});

export function teamSummaryLines(team: TeamConfig): string[] {
  const lines = [
    `团队 **${team.name}**${team.description ? `（${team.description}）` : ""} — ${team.source} scope`,
    `定义文件: ${team.filePath}`,
    `leader: ${team.leader.model ?? "（pi 默认模型）"}`,
    "成员:",
  ];
  for (const member of team.members) {
    const parts = [member.model ?? "默认模型"];
    if (member.worktree) parts.push("worktree");
    lines.push(`  - ${member.name}${member.description ? ` — ${member.description}` : ""}（${parts.join("，")}）`);
  }
  return lines;
}

export function registerManageTools(pi: ExtensionAPI, deps: ManageDeps = {}): void {
  pi.registerTool({
    name: "team_create",
    label: "Create Agent Team",
    description:
      "创建一个可复用的 agent team（写入团队定义文件）。创建后即可用 /team:run <name> <任务> 或 team_run 工具反复派单。",
    promptGuidelines: [
      "创建团队前先与用户确认：团队用途、leader 的模型与策略 prompt 要点、每个成员的职责/后端模型/prompt。",
      "成员 prompt 要具体：角色定位、技术约束、输出格式、验收标准。不要用一句空话当 prompt。",
      "团队名用英文短名（如 dev-team）。创建成功后告诉用户如何派单、如何复用。",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "团队名（英文短名，如 dev-team）" }),
      description: Type.String({ description: "一句话描述这个团队是干什么的" }),
      leader: Type.Object({
        model: Type.Optional(Type.String({ description: "leader 后端模型 provider/id；留空用 pi 默认模型" })),
        tools: Type.Optional(Type.Array(Type.String(), { description: "leader 工具白名单；留空不限制" })),
        prompt: Type.String({ description: "leader 的策略 system prompt：如何拆解任务、派发、审查、汇总（用户指导 leader 完成任务的核心入口）" }),
      }),
      members: Type.Array(memberSchema, { description: "团队成员列表（至少 1 个）", minItems: 1 }),
      scope: Type.Optional(StringEnum(["global", "project"], { description: "global（默认，所有项目可用）或 project（仅当前项目）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const scope: "global" | "project" = params.scope === "project" ? "project" : "global";
      if (scope === "project" && !ctx.isProjectTrusted()) {
        return {
          content: [{ type: "text" as const, text: "项目 scope 需要已信任的项目；请先用 scope: global，或在 pi 中信任该项目后重试。" }],
          details: { code: "WRITE_FAILED" },
          isError: true,
        };
      }
      const dir = scope === "global" ? (deps.globalDir ?? globalTeamsDir()) : `${deps.cwd ?? ctx.cwd}/.pi/teams`;
      const team = buildTeamFromToolInput({
        name: params.name,
        description: params.description,
        leader: params.leader,
        members: params.members,
        scope,
        filePath: `${dir}/${params.name}.md`,
      });
      if (!team.ok) {
        return {
          content: [{ type: "text" as const, text: `团队定义无效：${team.message}` }],
          details: { code: team.code },
          isError: true,
        };
      }
      const created = createTeamFile({ dir, team: team.value });
      if (!created.ok) {
        return {
          content: [{ type: "text" as const, text: `创建失败：${created.message}` }],
          details: { code: created.code },
          isError: true,
        };
      }
      const lines = teamSummaryLines({ ...team.value, filePath: created.value });
      lines.push("", "派单方式：/team:run " + team.value.name + " <任务>，或让我调用 team_run 工具。同一团队可反复派单复用。");
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { path: created.value } };
    },
  });

  pi.registerTool({
    name: "team_list",
    label: "List Agent Teams",
    description: "列出所有已定义的 agent team（含成员与模型），用于判断复用已有团队还是新建。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const cwd = deps.cwd ?? ctx.cwd;
      const scope = ctx.isProjectTrusted() ? "both" : "global";
      const { teams, invalid } = discoverTeams({ cwd, scope, ...(deps.globalDir ? { globalDir: deps.globalDir } : {}) });
      const lines: string[] = [];
      if (teams.length === 0) {
        lines.push("当前没有任何团队定义。可以用 team_create 工具创建（global scope 默认写入 ~/.pi/agent/teams/）。");
      }
      for (const team of teams) {
        lines.push(...teamSummaryLines(team), "");
      }
      for (const bad of invalid) {
        lines.push(`⚠ 无效的团队文件（未加载）: ${bad.file} — ${bad.message}`);
      }
      return { content: [{ type: "text" as const, text: truncateUtf8(lines.join("\n"), MAX_RESULT_BYTES) }], details: { count: teams.length } };
    },
  });
}
