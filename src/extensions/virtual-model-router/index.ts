/**
 * virtual-model-router — 按请求 reason 选物理模型的虚拟模型（general-todo#22）
 *
 * 注册一个可选中的目录条目（默认 `opencode-go/router`）：用户照常 `/model` 选它，
 * 之后每次请求由本扩展按 `reason` 现场挑物理模型——零额外 LLM 调用、零额外延迟、
 * 完全确定性（策略全在 config.ts 的单一表里）：
 *
 *   user         → 强档（要质量）
 *   continuation → 便宜快档（续跑）
 *   retry        → 升一档；判定为上下文溢出则换长上下文档
 *   direct       → 固定档（compaction summary / 扩展直调，不受策略影响）
 *
 * 状态（上次档位）经 `state` 交宿主存进 `pi.virtual-model-state` 条目：随会话分支持久化
 * （`/tree` 各分支各存各的）、`/resume` 后仍可读，`retry` 的升档判据就靠它。
 *
 * 边界：只读宿主模型目录、只注册一个虚拟模型；不写任何 entry、不发消息、不动 UI
 * （footer 的「选中 → 物理」由宿主渲染）；不改变别的扩展（agent-team preflight 只要
 * 注册目标 provider 有凭据就零改动）。
 *
 * 检测虚拟模型只能硬编码 `model.api === "pi-virtual"`：上游没有从包根导出
 * `isVirtualModel` / `VIRTUAL_MODEL_API`（test/index.test.ts 锁着这条导出缺口，
 * 上游补齐后应改掉本注释与相关字面量）。
 *
 * 安装：复制本目录到 `~/.pi/agent/extensions/virtual-model-router/`，Pi 内 `/reload`。
 * 测试：`npm test`（cwd = 本目录）。
 */
import type { ExtensionAPI, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, VIRTUAL_MODEL } from "./config.ts";
import { planRoute, type RouteInput, type RouterState } from "./routing.ts";

/** 宿主路由请求 → 决策层输入（判据只有四项，不把整条会话灌进决策层）。 */
export function toRouteInput(request: ModelRouteRequest<RouterState>): RouteInput {
  const failed = request.failed;
  return {
    reason: request.reason,
    thinkingLevel: request.thinkingLevel,
    state: request.state,
    ...(failed === undefined
      ? {}
      : { failed: { stopReason: failed.message.stopReason, errorMessage: failed.message.errorMessage } }),
  };
}

export default function virtualModelRouter(pi: ExtensionAPI): void {
  pi.registerVirtualModel<RouterState>({
    provider: VIRTUAL_MODEL.provider,
    id: VIRTUAL_MODEL.id,
    name: VIRTUAL_MODEL.name,
    thinkingLevels: THINKING_LEVELS,
    // 不声明 contextWindow / maxTokens：首位响应前显示未知，比声明一个错的窗口诚实；
    // 首个响应后宿主自动改用物理模型的 limits（0 在宿主里等于「未知」，不触发压缩）。
    route: (request, ctx) => planRoute(toRouteInput(request), { find: (provider, id) => ctx.modelRegistry.find(provider, id) }),
  });
}
