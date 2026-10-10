/**
 * dir-context — codemode 补偿路径：从**顶层 codemode 工具结果**的 `details.calls` 提取触碰。
 *
 * 为什么要这一层：脚本里的 `tools.read(...)` 是**嵌套调用**（`event.parentToolCallId` 非空），
 * 它的结果只回到脚本、不进 transcript，往那里注入模型看不到（index.ts 对嵌套调用直接跳过）。
 * 但 codemode 的**工具结果本身是顶层调用**，且带着每个嵌套调用的明细
 * （`details.calls: { name, args, status }[]`）——「脚本碰了哪些路径」宿主已经记好了，这里只是
 * 把明细翻译回与顶层同一套触碰语义（touch.ts 的 `detectTouch`），复用同一份去重与预算。
 *
 * 降级口径（认不出就少注入，绝不误注入）：
 * - `args` 是宿主的**截断预览**（`previewArgs` 上限 200 字符、超出加 `...` 尾），截断后不是合法
 *   JSON ⇒ 该条跳过。代价：`write` / `edit` 这类自带大载荷的调用在脚本里常见截断，codemode
 *   路径对它们的覆盖弱于顶层（顶层拿到的是完整入参）——见卡片「已知缺口」。
 * - 工具名不认识（`grep` / `find` / `models.*` 的 `chat` 等）⇒ 跳过（`detectTouch` 返回 null）。
 * - `status` 为 `error` / `cancelled` **照算**：文件可能已经被读过或写过，注入与脚本成败无关。
 */
import type { CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import { detectTouch, type Touch } from "./touch.ts";

/** 宿主内置 codemode 的工具名（宿主常量 `CODEMODE_TOOL_NAME`）。 */
const CODEMODE_TOOL_NAME = "codemode";

/**
 * 顶层工具结果 → codemode 触碰列表。
 *
 * 返回 `null` = 这不是 codemode 的顶层结果（调用方走普通触碰路径）；返回 `[]` = 是 codemode
 * 结果但没有认得出的触碰。
 *
 * 为什么不照 ADR-0012 用宿主的 `isCodemodeTool(tool)`：pi 1.1.0 的包入口只导出
 * `CodemodeToolDetails` 类型，`isCodemodeTool` 不在公开导出面（只存在于内部模块），扩展拿不到。
 * 改用「工具名 + `details.calls` 结构」双重判真：同名第三方工具不带这个结构就不会被误伤，
 * 而内置 codemode 的工具名是固定字面量。
 */
export function detectCodemodeTouches(toolName: string, details: unknown): Touch[] | null {
  if (toolName !== CODEMODE_TOOL_NAME) return null;
  const calls = readCalls(details);
  if (calls === null) return null;

  const touches: Touch[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const touch = readCallTouch(call);
    if (!touch) continue;
    const key = `${touch.kind}\u0000${touch.rawPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    touches.push(touch);
  }
  return touches;
}

/** `details.calls` 是数组即认为「这是 codemode 结果」；形状不符的条目被过滤掉。 */
function readCalls(details: unknown): CodemodeToolDetails["calls"] | null {
  if (typeof details !== "object" || details === null) return null;
  const calls = (details as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return null;
  return calls.filter(isCall);
}

function isCall(value: unknown): value is CodemodeToolDetails["calls"][number] {
  if (typeof value !== "object" || value === null) return false;
  const call = value as { name?: unknown; args?: unknown };
  return typeof call.name === "string" && typeof call.args === "string";
}

function readCallTouch(call: CodemodeToolDetails["calls"][number]): Touch | null {
  const args = parseArgs(call.args);
  return args === null ? null : detectTouch(call.name, args);
}

/** 宿主的 `args` 是紧凑 JSON（可能被截断）：解析不出对象就返回 null（该条跳过）。 */
function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
