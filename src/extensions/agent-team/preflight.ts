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

import {
  EXTERNAL_BIN_ENV,
  type ExternalBackend,
  type ExternalCliResolveResult,
  type TeamConfig,
  TeamErrorCodes,
  type TeamErrorCode,
} from "./types.ts";
import { splitModelThinking } from "./config.ts";

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

/**
 * External CLI resolution injected by the caller (index.ts/doctor.ts wire
 * external.ts's `resolveExternalCli`; omitting it keeps the preflight free
 * of that dependency for parallel delivery and backward compatibility).
 */
export interface ExternalPreflightDeps {
  resolveCli: (backend: ExternalBackend) => ExternalCliResolveResult;
}

/**
 * Registry check for one configured provider/id reference: unresolvable →
 * `missing`; resolvable without configured auth → `warnings` (runtime may
 * still authenticate through other paths, so it is not a hard failure).
 */
function checkModelRef(ref: ModelRef, lookup: ModelLookup, missing: string[], warnings: string[]): void {
  // 团队文件允许宿主级别后缀 `provider/id:level`（pi `--model` 同款语义）：
  // 注册表只认模型 id，先剥掉合法级别后缀再查；非法后缀原样保留（照旧失败）。
  const baseModel = splitModelThinking(ref.model).model ?? ref.model;
  const separator = baseModel.indexOf("/");
  const provider = separator > 0 ? baseModel.slice(0, separator) : "";
  const modelId = separator > 0 ? baseModel.slice(separator + 1) : "";
  const model = provider && modelId ? lookup.find(provider, modelId) : undefined;
  if (!model) {
    missing.push(`${ref.owner}: ${ref.model}`);
    return;
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

/** Preflight outcome: ok (possibly with auth warnings) or hard failure. */
export type PreflightResult =
  | { ok: true; warnings: string[] }
  | { ok: false; code: TeamErrorCode; message: string };

/**
 * Preflights every configured model reference. `ok` carries auth warnings
 * (run proceeds); a failure names every unresolvable reference and points
 * at team_models for the valid provider/id list.
 *
 * External members (`member.backend`) are member-only in v1: a declared
 * leader backend fails EXTERNAL_LEADER_UNSUPPORTED before any probe; member
 * `model` values are CLI-native ids, so the registry is skipped and, when
 * `external` is wired, the CLI must resolve (CLI_NOT_FOUND otherwise).
 */
export function preflightTeamModels(
  team: TeamConfig,
  lookup: ModelLookup,
  external?: ExternalPreflightDeps,
): PreflightResult {
  // v1: 外部 CLI 没有 team_dispatch 工具面，外部 leader 无法协调成员——
  // 先于一切（注册表、CLI 探测）fail-closed。
  if (team.leader.backend) {
    return {
      ok: false,
      code: TeamErrorCodes.EXTERNAL_LEADER_UNSUPPORTED,
      message:
        "v1 限制：leader 暂不支持外部 CLI 后端（backend 仅可用于成员）——外部 CLI 无 team_dispatch 工具面，无法协调成员；请移除 leader.backend 后重试",
    };
  }
  const missing: string[] = [];
  const warnings: string[] = [];
  if (team.leader.model) checkModelRef({ owner: "leader", model: team.leader.model }, lookup, missing, warnings);
  for (const member of team.members) {
    if (member.backend) {
      // 外部成员的 model 是 CLI 原生 id（非 provider/id 引用），跳过注册表查询；
      // 注入 resolver 时先确认 CLI 可解析（未注入 = 不探测，向后兼容）。
      if (external) {
        const resolved = external.resolveCli(member.backend);
        if (!resolved.ok) {
          return {
            ok: false,
            code: TeamErrorCodes.CLI_NOT_FOUND,
            message: `外部成员 ${member.name} 的 ${member.backend} CLI 不可用：${resolved.message}。请确认已安装（PATH 或 npm 全局布局），或用环境变量 ${EXTERNAL_BIN_ENV[member.backend]} 指定可执行文件绝对路径。`,
          };
        }
      }
      continue;
    }
    if (member.model) checkModelRef({ owner: member.name, model: member.model }, lookup, missing, warnings);
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
