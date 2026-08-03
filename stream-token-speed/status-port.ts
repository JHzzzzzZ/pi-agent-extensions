/**
 * TUI 状态端口：对 ctx.ui.setStatus 的薄封装，负责可用性检查、样式与异常隔离。
 *
 * 契约见 JHL-10-Design-v2.md §4：
 * - 固定状态键 "stream-token-speed"；
 * - available() === false 时跳过渲染；
 * - setStatus 抛出的异常必须在端口内部捕获，不得影响 pi 的消息流。
 *
 * 样式（JHL-10-修复#1）：pi 的 setStatus 只接收字符串，颜色需由调用方用
 * ctx.ui.theme.fg("dim", text) 包装（官方 docs/tui.md：setStatus 可嵌入
 * theme.fg 样式字符串）。style 参数在 setStatus 内部统一包装，且与 UI 调用
 * 一样做异常隔离——theme.fg 或 setStatus 任一抛错都不影响度量流程。
 */

export interface StatusPort {
  available(): boolean;
  setStatus(key: "stream-token-speed", text: string | undefined): void;
}

export const STATUS_KEY = "stream-token-speed" as const;

export interface UiLike {
  setStatus(key: string, text: string | undefined): void;
}

export type StatusStyler = (text: string) => string;

/**
 * 创建状态端口。`isAvailable` 为动态判定函数（例如 () => ctx.hasUI），
 * 保证 print / json 模式下静默降级，TUI / RPC 模式下正常渲染。
 * `style` 为可选的文本样式函数（例如 theme.fg("dim", t)），未提供时原样输出。
 */
export function createStatusPort(
  ui: UiLike,
  isAvailable: () => boolean,
  style?: StatusStyler,
): StatusPort {
  return {
    available(): boolean {
      return isAvailable();
    },
    setStatus(key, text): void {
      if (!isAvailable()) return;
      try {
        const styled = text !== undefined && style !== undefined ? style(text) : text;
        ui.setStatus(key, styled);
      } catch {
        // 隔离 UI 异常：扩展故障不得中断、延迟或改写模型回复及工具调用。
      }
    },
  };
}
