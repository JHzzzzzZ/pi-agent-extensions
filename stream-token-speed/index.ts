/**
 * JHL-10 流式 Token 速度显示 — pi TUI 扩展
 *
 * 在 pi TUI 流式回复期间显示 TTFT（首 token 延迟）与瞬时 tokens/s，
 * 结束后保留本轮 TTFT、最后瞬时值与平均速度。计量范围覆盖文本、
 * thinking、tool call 的流式增量；tool result 与工具执行进度一律排除。
 *
 * 安装：将本目录（stream-token-speed）复制到
 *   - 全局：~/.pi/agent/extensions/stream-token-speed/
 *   - 或项目级：.pi/extensions/stream-token-speed/
 * 然后重启 pi（或在会话内执行 /reload）。卸载即删除该目录。
 *
 * 仅依赖 pi 内置的 Extension API 类型导入（运行时零依赖，无需 npm install）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStreamAdapter } from "./adapter.ts";
import { TokenSpeedController } from "./controller.ts";
import { createStatusPort, type StatusPort, type StatusStyler } from "./status-port.ts";

export default function (pi: ExtensionAPI): void {
  const controller = new TokenSpeedController(createStreamAdapter());

  // 状态端口按事件上下文构建：ctx.hasUI 动态判定可用性（TUI / RPC 可用，
  // print / json 模式静默降级）；setStatus 异常在端口内部隔离。
  // 颜色：setStatus 仅接受字符串，灰色由 ctx.ui.theme.fg("dim", text) 包装
  // （官方 docs/tui.md 模式）；仅 TUI 模式应用样式，RPC 模式输出纯文本，
  // 避免向 RPC 客户端泄漏 ANSI 转义码。
  const portFor = (ctx: {
    ui: Parameters<typeof createStatusPort>[0];
    hasUI: boolean;
    mode?: string;
  }): StatusPort => {
    const dim: StatusStyler | undefined =
      ctx.mode === "tui"
        ? (text) => {
            const theme = (ctx.ui as { theme?: { fg?: (color: string, t: string) => string } }).theme;
            return theme?.fg ? theme.fg("dim", text) : text;
          }
        : undefined;
    return createStatusPort(ctx.ui, () => ctx.hasUI, dim);
  };

  pi.on("message_start", async (event, ctx) => {
    controller.onMessageStart(event, portFor(ctx));
  });

  pi.on("message_update", async (event, ctx) => {
    controller.onMessageUpdate(event, portFor(ctx));
  });

  pi.on("message_end", async (event, ctx) => {
    controller.onMessageEnd(event, portFor(ctx));
  });
}
