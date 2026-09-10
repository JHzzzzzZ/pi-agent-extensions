/** Type surface for tools/capture-screens.mjs（文档工具，不进产物；测试 import 需类型）。 */
import type { VtCell } from "./vt-screen.mjs";

export declare const DARK: Record<"dim" | "border" | "accent" | "success" | "warning" | "error" | "bubble" | "text", string>;
/** 真实 `Styles` 端口（ANSI 版本，headless 无需 theme 对象）。 */
export declare function ansiStyles(): {
  dim: (text: string) => string;
  border: (text: string) => string;
  accent: (text: string) => string;
  success: (text: string) => string;
  error: (text: string) => string;
  warning: (text: string) => string;
  bubble: (text: string) => string;
  bold: (text: string) => string;
};
export declare function svgFromGrid(grid: (VtCell | null)[][]): string;
export declare function captureViewerScene(opts?: { cols?: number; rows?: number }): {
  grid: (VtCell | null)[][];
  lines: string[];
  cols: number;
  rows: number;
};
export declare function assertFrame(lines: string[]): true;
export declare function capture(): { name: string; svg: string };

/** pwr 场景：真实 `RunViewer`（/workflow:view）帧。 */
export declare function capturePwrViewerScene(opts?: { cols?: number; rows?: number }): {
  grid: (VtCell | null)[][];
  lines: string[];
  cols: number;
  rows: number;
};
/** pwr 帧自检（标题/脚本名/结构页锚点）。 */
export declare function assertPwrFrame(lines: string[]): true;
/** agent-team 亮块（编辑器下方 widget）场景：真实 buildWidgetView/renderWidgetView + 真实 Editor。 */
export declare function captureWidgetScene(opts?: { cols?: number; rows?: number }): {
  grid: (VtCell | null)[][];
  lines: string[];
  cols: number;
  rows: number;
};
/** widget 帧自检（main/leader/成员树 + 提示行锚点）。 */
export declare function assertWidgetFrame(lines: string[]): true;
/** 全部文档截图（agent-team 查看器 + pwr 查看器 + agent-team 亮块，同一 VT/SVG 管线）。 */
export declare function captureAll(): { name: string; svg: string }[];
