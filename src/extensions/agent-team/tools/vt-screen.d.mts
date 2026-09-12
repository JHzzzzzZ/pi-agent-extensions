/** Type surface for tools/vt-screen.mjs（文档工具，不进产物；测试 import 需类型）。 */
export declare const DEFAULT_FG: string;
export declare const DEFAULT_BG: string;
/** xterm-256 → #rrggbb。 */
export declare function ansi256(n: number): string;

export interface VtCell {
  ch: string;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
  /** 宽字符的右半格。 */
  cont: boolean;
}

export declare class VtScreen {
  readonly cols: number;
  readonly rows: number;
  constructor(cols: number, rows: number);
  /** 消费渲染器写出的全部字节。 */
  feed(data: string): void;
  /** 全缓冲文本行（宽字符占位已清除）。 */
  text(): string[];
  /** 视口内单元格。 */
  grid(): (VtCell | null)[][];
}
