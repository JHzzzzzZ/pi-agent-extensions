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
