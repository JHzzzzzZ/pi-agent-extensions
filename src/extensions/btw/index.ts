/**
 * btw - 旁路对话扩展入口（类 Claude Code /btw）
 *
 * 主对话跑着的时候，用户想随时问「现在在干啥 / 为什么这么改 / 进度如何」——
 * 这条通道**只读主会话、零写入**：
 *   /btw <问题>      读当前分支尾部作上下文，直调模型作答，答案落只读覆盖面板
 *   /btw:clear       清空侧对话线（仅扩展内存）
 *   /btw:model ...   查看/切换侧对话模型（默认跟随主会话）
 *
 * 不变量（对齐文档 todos/align/btw-todo#1.md）：
 * - 不 `pi.appendEntry`、不 `pi.sendMessage`、不碰主 run（无事件拦截、无上下文注入、
 *   无 steer/followUp 介入）——session 文件与下一轮主请求都无痕。
 * - 侧调用经 `ctx.modelRegistry.streamSimple()` 走宿主路由/鉴权/会话头（goal 同款接缝）。
 * - 侧对话线只在扩展内存里：不落盘，会话切换/重启即失。
 * - 无 UI（print/json）不静默：写 stderr 并返回；RPC 无自绘时降级为 notify。
 *
 * 安装：复制本目录到 ~/.pi/agent/extensions/btw/ 或 <项目>/.pi/extensions/btw/，
 *       在 Pi 中执行 /reload。卸载即删除目录。
 * 测试：cd src/extensions/btw && npm test
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildContextText, type TranscriptEntry } from "./context.ts";
import { BtwErrorCodes } from "./errors.ts";
import { presentBtwPanel } from "./panel.ts";
import { runSideCall, type SideCallResult, type ThreadTurn } from "./side-call.ts";
import {
  BTW_CLEAR_COMMAND,
  BTW_COMMAND,
  BTW_MODEL_COMMAND,
  MAX_NOTIFY_CHARS,
  MAX_QUESTION_CHARS,
  MAX_THREAD_MESSAGES,
  SIDE_CALL_TIMEOUT_MS,
} from "./spec.ts";

export interface BtwDeps {
  /** 注入时钟（测试用）；缺省 `Date.now` */
  nowMs?: () => number;
  /** 侧调用超时覆盖（测试用）；缺省 `SIDE_CALL_TIMEOUT_MS` */
  timeoutMs?: number;
}

/** 裸命令无参数时的用法提示 */
const USAGE_TEXT = [
  "btw 旁路对话：主对话跑着时也能问它现在在干啥——只读当前会话上下文作答，不写主会话、不打断主 run。",
  "用法：/btw <问题>",
  "/btw:clear 清空侧对话线；/btw:model [provider/id|default] 查看/切换侧模型（默认跟随主会话）",
].join("\n");

/** 无 UI 模式（print/json）的唯一通道是 stderr：绝不静默失效 */
function reportNoUi(): void {
  try {
    console.error("btw: 当前模式没有可展示侧对话的 UI（TUI / RPC 可用；print / json 不加载交互面）。");
  } catch {
    /* 忽略 */
  }
}

/** 防御式取会话 id（缺 getSessionId / 抛异常 → undefined，provider 会话头随之省略） */
function getSessionIdSafe(ctx: ExtensionContext): string | undefined {
  try {
    const getSessionId = (ctx.sessionManager as { getSessionId?: unknown } | undefined)?.getSessionId;
    return typeof getSessionId === "function"
      ? (getSessionId.call(ctx.sessionManager) as string | undefined)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 读当前分支（压缩感知）并组装侧上下文；读失败按空上下文继续（模型会如实说看不到） */
function readContextText(ctx: ExtensionContext): string {
  try {
    return buildContextText(ctx.sessionManager.buildContextEntries() as unknown as TranscriptEntry[]).text;
  } catch {
    return "";
  }
}

/** 通知正文截断（RPC 降级通道） */
export function formatNotifyAnswer(text: string): string {
  const body = text.trim() || "（模型返回了空回答）";
  const chars = Array.from(body);
  if (chars.length <= MAX_NOTIFY_CHARS) return body;
  return `${chars.slice(0, MAX_NOTIFY_CHARS - 1).join("")}…\n（通知有截断；完整回答请在 TUI 模式下用面板查看。）`;
}

export function createBtwExtension(pi: ExtensionAPI, deps: BtwDeps = {}): void {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? SIDE_CALL_TIMEOUT_MS;

  /** 侧对话线：只在本扩展内存里（不落盘；会话切换/重启即失） */
  let thread: ThreadTurn[] = [];
  /** `/btw:model` 的会话内覆盖；undefined = 跟随主会话模型 */
  let modelOverride: { provider: string; id: string } | undefined;
  /** 同一时刻只允许一个侧调用 */
  let inFlight = false;

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      ctx.ui.notify(message, type);
    } catch {
      /* 通知失败不破坏会话 */
    }
  }

  function resetSessionState(): void {
    thread = [];
    modelOverride = undefined;
    inFlight = false;
  }

  /** 记一轮侧问答（成对入线；只保留最近 MAX_THREAD_MESSAGES 条） */
  function recordTurn(question: string, answer: string): void {
    thread.push({ role: "user", text: question }, { role: "assistant", text: answer });
    while (thread.length > MAX_THREAD_MESSAGES) thread.splice(0, 2);
  }

  type ResolvedModel = { ok: true; model: Model<Api> } | { ok: false; message: string };

  function resolveModel(ctx: ExtensionContext): ResolvedModel {
    if (modelOverride) {
      const model = ctx.modelRegistry.find(modelOverride.provider, modelOverride.id);
      if (!model) {
        return {
          ok: false,
          message: `找不到模型 ${modelOverride.provider}/${modelOverride.id}；用 /${BTW_MODEL_COMMAND} 查看当前值，或换一个已配置的 provider/id。`,
        };
      }
      return { ok: true, model };
    }
    if (!ctx.model) {
      return {
        ok: false,
        message: `当前会话没有可用模型；先用 /model 选择，或用 /${BTW_MODEL_COMMAND} <provider/id> 指定侧模型。`,
      };
    }
    return { ok: true, model: ctx.model };
  }

  /** 侧调用落定：成功记轮次；降级通道（无面板）才 notify */
  function finishCall(
    ctx: ExtensionContext,
    question: string,
    result: SideCallResult | undefined,
    opts: { timedOut: boolean; panel: boolean },
  ): void {
    if (!result) {
      if (!opts.panel) notify(ctx, "侧调用没有返回结果。", "warning");
      return;
    }
    if (result.ok) {
      const text = result.value.text.trim();
      if (text) recordTurn(question, text);
      if (!opts.panel) notify(ctx, formatNotifyAnswer(text));
      return;
    }
    if (opts.panel) return; // 面板里已显示
    if (result.code === BtwErrorCodes.aborted && opts.timedOut) {
      notify(ctx, `侧调用超时（${Math.round(timeoutMs / 1000)} 秒）已中止。`, "warning");
      return;
    }
    if (result.code === BtwErrorCodes.aborted) {
      notify(ctx, "侧对话已取消。");
      return;
    }
    notify(ctx, `侧调用失败：${result.message}`, "warning");
  }

  async function ask(ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
    const question = (rawArgs ?? "").trim();
    if (!question) {
      notify(ctx, USAGE_TEXT);
      return;
    }
    if (Array.from(question).length > MAX_QUESTION_CHARS) {
      notify(ctx, `提问过长（上限 ${MAX_QUESTION_CHARS} 字符）。`, "warning");
      return;
    }
    if (inFlight) {
      notify(ctx, "上一个侧问答还在跑：按 Esc 关掉面板，或等它结束再问。", "warning");
      return;
    }
    if (!ctx.hasUI) {
      reportNoUi();
      return;
    }
    const resolved = resolveModel(ctx);
    if (!resolved.ok) {
      notify(ctx, resolved.message, "warning");
      return;
    }

    inFlight = true;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const contextText = readContextText(ctx);
      const sessionId = getSessionIdSafe(ctx);
      const runCall = (
        onDelta: ((delta: string) => void) | undefined,
        signal: AbortSignal,
      ): Promise<SideCallResult> =>
        runSideCall(
          {
            question,
            contextText,
            thread: thread.slice(),
            model: resolved.model,
            ...(sessionId ? { sessionId } : {}),
            signal,
            ...(onDelta ? { onDelta } : {}),
          },
          ctx.modelRegistry,
          { nowMs },
        );

      const panel =
        ctx.mode === "tui"
          ? await presentBtwPanel(ctx.ui, {
              question,
              run: (onDelta, signal) => runCall(onDelta, signal),
              controller,
              isTimedOut: () => timedOut,
            })
          : { supported: false, result: undefined };
      const result = panel.supported ? panel.result : await runCall(undefined, controller.signal);
      finishCall(ctx, question, result, { timedOut, panel: panel.supported });
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
  }

  /** `/btw:model`：显示当前值 / 切换 / `default` 恢复跟随 */
  function handleModelCommand(ctx: ExtensionContext, rawArgs: string): void {
    const raw = (rawArgs ?? "").trim();
    if (!raw) {
      const main = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "（当前无模型）";
      const current = modelOverride ? `${modelOverride.provider}/${modelOverride.id}（会话内覆盖）` : `跟随主会话 ${main}`;
      notify(ctx, `侧对话模型：${current}\n切换：/btw:model <provider/id>；恢复跟随：/btw:model default`);
      return;
    }
    if (raw === "default") {
      modelOverride = undefined;
      notify(ctx, "侧对话模型恢复为跟随主会话。");
      return;
    }
    const slash = raw.indexOf("/");
    if (slash <= 0 || slash === raw.length - 1) {
      notify(ctx, "格式应为 <provider>/<id>（例：opencode-go/deepseek-v4.1-flash），或 default 恢复跟随。", "warning");
      return;
    }
    const provider = raw.slice(0, slash);
    const id = raw.slice(slash + 1);
    if (!ctx.modelRegistry.find(provider, id)) {
      notify(ctx, `找不到模型 ${provider}/${id}；用 /model 或 /team:list 查看会话里可用的模型。`, "warning");
      return;
    }
    modelOverride = { provider, id };
    notify(ctx, `侧对话模型已切到 ${provider}/${id}。`);
  }

  pi.registerCommand(BTW_COMMAND, {
    description:
      "旁路对话：主对话跑着时问「现在在干啥」——只读当前会话上下文作答，不写主会话、不打断主 run（/btw <问题>；管理命令 /btw:clear、/btw:model）",
    handler: async (args, ctx) => {
      await ask(ctx, args);
    },
  });

  pi.registerCommand(BTW_CLEAR_COMMAND, {
    description: "清空 btw 侧对话线（只动扩展内存，不碰主会话）",
    handler: async (_args, ctx) => {
      thread = [];
      notify(ctx, "侧对话线已清空。");
    },
  });

  pi.registerCommand(BTW_MODEL_COMMAND, {
    description: "查看/切换 btw 侧对话模型：/btw:model <provider/id> 切换，/btw:model default 恢复跟随主会话",
    handler: async (args, ctx) => {
      handleModelCommand(ctx, args);
    },
  });

  pi.on("session_start", async () => {
    resetSessionState();
  });
  pi.on("session_shutdown", async () => {
    resetSessionState();
  });
}

export default function btwExtension(pi: ExtensionAPI): void {
  createBtwExtension(pi);
}
