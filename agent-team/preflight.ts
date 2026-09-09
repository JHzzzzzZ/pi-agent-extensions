/**
 * agent-team — model preflight (fail fast before any child spawns)
 *
 * Resolves every configured `provider/id` (leader + all members) against
 * the host model registry BEFORE a run starts: an unresolvable reference
 * is a hard failure (MODEL_NOT_FOUND, nothing spawns — the old behavior
 * surfaced it only as a mid-run child 404); a resolvable model without
 * configured auth is a warning (the provider may still be logged in at
 * runtime via other auth paths). Members without a model run on the pi
 * default model and cannot be verified — skipped.
 *
 * The registry lookup is injected (ctx.modelRegistry) so this stays a pure,
 * host-free function. The caller is responsible for having refreshed the
 * registry (team_models/doctor refresh; team_run relies on the session's
 * already-loaded registry).
 */

import { type TeamConfig, TeamErrorCodes, type TeamErrorCode } from "./types.ts";

/** Structural surface of the host model registry used here (kept testable). */
export interface ModelLookup {
  find(provider: string, modelId: string): unknown | undefined;
  hasConfiguredAuth(model: unknown): boolean;
}

/** Builds a ModelLookup over the host registry (ctx.modelRegistry). */
export function modelLookupFrom(registry: unknown): ModelLookup | undefined {
  if (registry === null || typeof registry !== "object") return undefined;
  const r = registry as {
    find?: (provider: string, modelId: string) => unknown;
    hasConfiguredAuth?: (model: unknown) => boolean;
  };
  if (typeof r.find !== "function" || typeof r.hasConfiguredAuth !== "function") return undefined;
  const find = r.find;
  const hasConfiguredAuth = r.hasConfiguredAuth;
  return {
    find: (provider, modelId) => find.call(registry, provider, modelId),
    hasConfiguredAuth: (model) => hasConfiguredAuth.call(registry, model),
  };
}

interface ModelRef {
  /** Who configured it ("leader" or the member name). */
  owner: string;
  model: string;
}

/** Collects every configured provider/id reference in the team. */
function teamModelRefs(team: TeamConfig): ModelRef[] {
  const refs: ModelRef[] = [];
  if (team.leader.model) refs.push({ owner: "leader", model: team.leader.model });
  for (const member of team.members) {
    if (member.model) refs.push({ owner: member.name, model: member.model });
  }
  return refs;
}

/** Preflight outcome: ok (possibly with auth warnings) or hard failure. */
export type PreflightResult =
  | { ok: true; warnings: string[] }
  | { ok: false; code: TeamErrorCode; message: string };

/**
 * Preflights every configured model reference. `ok` carries auth warnings
 * (run proceeds); a failure names every unresolvable reference and points
 * at team_models for the valid provider/id list.
 */
export function preflightTeamModels(
  team: TeamConfig,
  lookup: ModelLookup,
): PreflightResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const ref of teamModelRefs(team)) {
    const separator = ref.model.indexOf("/");
    const provider = separator > 0 ? ref.model.slice(0, separator) : "";
    const modelId = separator > 0 ? ref.model.slice(separator + 1) : "";
    const model = provider && modelId ? lookup.find(provider, modelId) : undefined;
    if (!model) {
      missing.push(`${ref.owner}: ${ref.model}`);
      continue;
    }
    let authed: boolean;
    try {
      authed = lookup.hasConfiguredAuth(model);
    } catch {
      authed = true; // registry probe failure is not a hard preflight failure
    }
    if (!authed) {
      warnings.push(`${ref.owner} 的模型 ${ref.model} 未配置鉴权（可能未登录或未设置 API key）；若运行时报鉴权错误，先完成该 provider 的登录`);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: TeamErrorCodes.MODEL_NOT_FOUND,
      message: `模型预检失败：以下 provider/id 在当前模型注册表中不存在 — ${missing.join("；")}。先调用 team_models 查看可用模型，再修正团队定义。`,
    };
  }
  return { ok: true, warnings };
}
