/**
 * agent-team — conversation-driven team management tools (cockpit mode)
 *
 * `team_create` lets the MAIN agent create a reusable team definition file
 * from a conversation ("建一个前端+后端团队，leader 用 opus"). `team_list`
 * shows what already exists so the agent reuses teams instead of creating
 * duplicates. `team_models` enumerates the providers/models pi currently
 * has configured (from the host model registry) so the agent never invents
 * a model id. All are thin wrappers over config.ts (validate + write).
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
  model: Type.Optional(Type.String({ description: "后端模型，格式 provider/id（必须从 team_models 的输出中选择）；留空则用 pi 默认模型" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "允许的工具白名单（如 read, edit, bash）；留空则不限制" })),
  worktree: Type.Optional(Type.Boolean({ description: "该成员是否用独立 git worktree 隔离（默认否；团队级 worktree 开启时覆盖为独立）" })),
  prompt: Type.String({ description: "该成员的专属 system prompt（角色、约束、输出格式）" }),
});

export function teamSummaryLines(team: TeamConfig): string[] {
  const lines = [
    `团队 **${team.name}**${team.description ? `（${team.description}）` : ""} — ${team.source} scope`,
    `定义文件: ${team.filePath}`,
    `leader: ${team.leader.model ?? "（pi 默认模型）"}`,
    ...(team.worktree ? ["工作区: 团队共享 git worktree（每次 run 独立分支）"] : []),
    "成员:",
  ];
  for (const member of team.members) {
    const parts = [member.model ?? "默认模型"];
    if (member.worktree) parts.push("独立 worktree");
    lines.push(`  - ${member.name}${member.description ? ` — ${member.description}` : ""}（${parts.join("，")}）`);
  }
  return lines;
}

/** Structural surface of the host model registry (kept testable). */
export interface ModelRegistryPort {
  refresh?: () => Promise<void>;
  getAvailable: () => Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; cost?: { input?: number; output?: number } }>;
  getAll?: () => Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; cost?: { input?: number; output?: number } }>;
  getProviderAuthStatus?: (provider: string) => { configured: boolean; source?: string; label?: string };
  getProviderDisplayName?: (provider: string) => string;
}

/** Formats the registry listing returned by team_models (unit-tested). */
export function formatModelCatalog(
  available: ReturnType<ModelRegistryPort["getAvailable"]>,
  unconfiguredProviders: string[],
  displayName: (provider: string) => string,
): string {
  const byProvider = new Map<string, ReturnType<ModelRegistryPort["getAvailable"]>>();
  for (const model of available) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  const lines: string[] = [];
  if (byProvider.size === 0) {
    lines.push("当前没有任何已配置鉴权的模型。请先运行 /login 或设置对应 provider 的 API key。");
  } else {
    lines.push("可用模型（已配置鉴权，模型串格式 provider/id）：");
    for (const [provider, models] of byProvider) {
      lines.push("", `## ${provider}（${displayName(provider)}）`);
      for (const model of models) {
        const cost = model.cost?.input !== undefined && model.cost?.output !== undefined
          ? `，$${model.cost.input}/$${model.cost.output} per 1M`
          : "";
        lines.push(
          `- **${provider}/${model.id}**（${model.name}${model.reasoning ? "，reasoning" : ""}，${Math.round(model.contextWindow / 1000)}K ctx${cost}）`,
        );
      }
    }
  }
  if (unconfiguredProviders.length > 0) {
    lines.push("", `未配置鉴权的 provider（不可用）：${unconfiguredProviders.join("、")}。可运行 /login 或设置 API key 后重试。`);
  }
  return lines.join("\n");
}

/** Builds the team_models tool listing from the host registry. */
export async function buildModelCatalog(registry: ModelRegistryPort): Promise<string> {
  try {
    await registry.refresh?.();
  } catch {
    /* refresh is best-effort */
  }
  const all = registry.getAll?.() ?? [];
  const available = registry.getAvailable();
  const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
  const configuredProviders = new Set(available.map((m) => m.provider));
  const unconfigured = new Set<string>();
  for (const model of all) {
    if (!availableKeys.has(`${model.provider}/${model.id}`) && !configuredProviders.has(model.provider)) {
      unconfigured.add(model.provider);
    }
  }
  const displayName = (provider: string): string => {
    try {
      return registry.getProviderDisplayName?.(provider) ?? provider;
    } catch {
      return provider;
    }
  };
  return formatModelCatalog(available, Array.from(unconfigured).sort(), displayName);
}

export function registerManageTools(pi: ExtensionAPI, deps: ManageDeps = {}): void {
  pi.registerTool({
    name: "team_models",
    label: "List Available Models",
    description: "列出当前 pi 已配置鉴权的所有供应商与模型（team_create 时的模型 id 必须从这里选）。",
    promptGuidelines: ["在 team_create 之前调用本工具，把真实存在的 provider/id 写进团队配置，避免派单时模型 404。"],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = (ctx as unknown as { modelRegistry?: ModelRegistryPort }).modelRegistry;
      if (!registry) {
        return {
          content: [{ type: "text" as const, text: "当前环境没有 model registry（非交互模式？）。" }],
          details: { code: "NO_REGISTRY" },
          isError: true,
        };
      }
      const text = await buildModelCatalog(registry);
      return { content: [{ type: "text" as const, text: truncateUtf8(text, MAX_RESULT_BYTES) }], details: {} };
    },
  });

  pi.registerTool({
    name: "team_create",
    label: "Create Agent Team",
    description:
      "创建一个可复用的 agent team（写入团队定义文件）。创建后即可用 /team:run <name> <任务> 或 team_run 工具反复派单。",
    promptGuidelines: [
      "创建团队前必须先调用 team_models 确认可用的 provider/id，再把真实存在的模型写进配置。",
      "创建团队前先与用户确认：团队用途、leader 的模型与策略 prompt 要点、每个成员的职责/后端模型/prompt。",
      "成员 prompt 要具体：角色定位、技术约束、输出格式、验收标准。不要用一句空话当 prompt。",
      "团队名用英文短名（如 dev-team）。创建成功后告诉用户如何派单、如何复用。",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "团队名（英文短名，如 dev-team）" }),
      description: Type.String({ description: "一句话描述这个团队是干什么的" }),
      worktree: Type.Optional(Type.Boolean({ description: "是否让整个团队在共享 git worktree 中工作（每次 run 独立分支，不碰当前目录；成员可单独覆盖为独立 worktree）" })),
      leader: Type.Object({
        model: Type.Optional(Type.String({ description: "leader 后端模型 provider/id（先 team_models 确认）；留空用 pi 默认模型" })),
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
        ...(params.worktree ? { worktree: true } : {}),
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
