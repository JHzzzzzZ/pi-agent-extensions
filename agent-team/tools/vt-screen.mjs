/**
 * agent-team — minimal ANSI/VT screen emulator with style tracking (docs tool)
 *
 * 用途：把 `TuiMainScreen` 写出的真实终端字节流还原成"用户实际看到的画面"
 * （字符 + 前景/背景色 + 属性），供 `capture-screens.mjs` 生成文档截图。
 *
 * 与 test/viewer-host.test.ts 里的 FakeScreen 同源（同一批转义序列模型），
 * 差别只在：本模块保留 SGR 样式状态（测试只断言文本）。两者刻意不共享
 * 代码——测试文件不应被工具依赖，工具也不应把断言拖进渲染路径。
 *
 * 只实现主屏 diff 渲染器实际发出的序列：\r \n \x1b[nA/B \x1b[H
 * \x1b[{r};{c}H \x1b[2K \x1b[2J \x1b[3J SGR OSC/APC/private-mode。
 */

/** Dark terminal palette (default fg/bg + 16 ANSI colors). */
export const DEFAULT_FG = "#d7dae0";
export const DEFAULT_BG = "#17191e";

const ANSI_16 = [
  "#282c34", "#e06c75", "#98c379", "#e5c07b",
  "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
  "#5c6370", "#e06c75", "#98c379", "#e5c07b",
  "#61afef", "#c678dd", "#56b6c2", "#ffffff",
];

const pad2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");

/** xterm-256 → #rrggbb. */
export function ansi256(n) {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${pad2(v)}${pad2(v)}${pad2(v)}`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(i / 36) % 6];
  const g = steps[Math.floor(i / 6) % 6];
  const b = steps[i % 6];
  return `#${pad2(r)}${pad2(g)}${pad2(b)}`;
}

const WIDE_CONT = "\0";

/** One screen cell. `cont` marks the trailing half of a wide glyph. */
function cell(ch, state) {
  return { ch, fg: state.fg, bg: state.bg, bold: state.bold, dim: state.dim, underline: state.underline, inverse: state.inverse, cont: false };
}

export class VtScreen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.slots = [];
    this.row = 0;
    this.col = 0;
    this.state = { fg: null, bg: null, bold: false, dim: false, underline: false, inverse: false };
  }

  viewportStart() {
    return Math.max(0, this.slots.length - this.rows);
  }

  ensureRow(r) {
    while (this.slots.length <= r) this.slots.push([]);
    return this.slots[r];
  }

  writeChar(ch) {
    const line = this.ensureRow(this.row);
    if ((line[this.col] ?? undefined)?.cont && this.col > 0) line[this.col - 1] = undefined;
    const wide = ch.length > 0 && ch.charCodeAt(0) > 0x1100 && /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(ch);
    line[this.col] = cell(ch, this.state);
    if (wide) {
      line[this.col + 1] = cell("", this.state);
      line[this.col + 1].cont = true;
    } else if ((line[this.col + 1] ?? undefined)?.cont) {
      line[this.col + 1] = undefined;
    }
    this.col += wide ? 2 : 1;
  }

  applySgr(params) {
    const nums = params === "" ? [0] : params.split(";").map((p) => Number(p === "" ? 0 : p));
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n === 0) this.state = { fg: null, bg: null, bold: false, dim: false, underline: false, inverse: false };
      else if (n === 1) this.state.bold = true;
      else if (n === 2) this.state.dim = true;
      else if (n === 4) this.state.underline = true;
      else if (n === 7) this.state.inverse = true;
      else if (n === 22) { this.state.bold = false; this.state.dim = false; }
      else if (n === 24) this.state.underline = false;
      else if (n === 27) this.state.inverse = false;
      else if (n === 39) this.state.fg = null;
      else if (n === 49) this.state.bg = null;
      else if (n >= 30 && n <= 37) this.state.fg = ANSI_16[n - 30];
      else if (n >= 90 && n <= 97) this.state.fg = ANSI_16[n - 90 + 8];
      else if (n >= 40 && n <= 47) this.state.bg = ANSI_16[n - 40];
      else if (n >= 100 && n <= 107) this.state.bg = ANSI_16[n - 100 + 8];
      else if (n === 38 || n === 48) {
        const key = n === 38 ? "fg" : "bg";
        const mode = nums[i + 1];
        if (mode === 5) { this.state[key] = ansi256(nums[i + 2] ?? 0); i += 2; }
        else if (mode === 2) { this.state[key] = `#${pad2(nums[i + 2])}${pad2(nums[i + 3])}${pad2(nums[i + 4])}`; i += 4; }
      }
    }
  }

  applyCsi(params, fin) {
    const nums = params.replace(/^\?/, "").split(";").map((p) => Number(p)).filter((n) => Number.isInteger(n));
    const n = (dflt) => nums[0] ?? dflt;
    if (fin === "m" && !params.startsWith("?")) { this.applySgr(params); return; }
    switch (fin) {
      case "A": this.row = Math.max(0, this.row - n(1)); break;
      case "B": this.row += n(1); this.ensureRow(this.row); break;
      case "H": {
        if (params === "" || nums.length === 0) { this.row = this.viewportStart(); this.col = 0; }
        else {
          this.row = this.viewportStart() + (nums[0] ?? 1) - 1;
          this.col = (nums[1] ?? 1) - 1;
          this.ensureRow(this.row);
        }
        break;
      }
      case "K": this.slots[this.row] = []; break;
      case "J": {
        const mode = n(0);
        if (mode === 2) {
          const start = this.viewportStart();
          for (let r = start; r < start + this.rows; r++) this.slots[r] = [];
        } else if (mode === 3) {
          const dropped = this.viewportStart();
          this.slots.splice(0, dropped);
          this.row = Math.max(0, this.row - dropped);
        }
        break;
      }
      default: break; // SGR handled above; private modes / sync output: no pixel effect
    }
  }

  /** 消费渲染器写出的全部字节；返回后本屏即"用户看到的画面"。 */
  feed(data) {
    let i = 0;
    const skipUntilBelOrSt = () => {
      while (i < data.length) {
        if (data[i] === "\x07") { i += 1; return; }
        if (data[i] === "\x1b" && data[i + 1] === "\\") { i += 2; return; }
        i += 1;
      }
    };
    const skipCsi = () => {
      while (i < data.length) {
        const code = data.charCodeAt(i) ?? 0;
        i += 1;
        if (code >= 0x40 && code <= 0x7e) return;
      }
    };
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b" && data[i + 1] === "[") {
        i += 2;
        let params = "";
        while (i < data.length) {
          const code = data.charCodeAt(i) ?? 0;
          if (code >= 0x40 && code <= 0x7e) break;
          params += data[i];
          i += 1;
        }
        const fin = data[i] ?? "";
        i += 1;
        this.applyCsi(params, fin);
        continue;
      }
      if (ch === "\x1b" && (data[i + 1] === "]" || data[i + 1] === "_")) { i += 2; skipUntilBelOrSt(); continue; }
      if (ch === "\x1b") { i += 1; skipCsi(); continue; }
      if (ch === "\r") { this.col = 0; i += 1; continue; }
      if (ch === "\n") { this.row += 1; this.ensureRow(this.row); i += 1; continue; }
      if (ch === "\x07" || ch === "\0") { i += 1; continue; }
      this.writeChar(ch);
      i += 1;
    }
  }

  /** 当前全缓冲文本行（宽字符占位已清除）。 */
  text() {
    return this.slots.map((line) => line.map((c) => (c && !c.cont ? c.ch : "")).join(""));
  }

  /** 视口内的单元格（rows 行，每行 cols 个），供 SVG 渲染。 */
  grid() {
    const start = this.viewportStart();
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = this.slots[start + r] ?? [];
      const row = [];
      for (let c = 0; c < this.cols; c++) row.push(line[c] ?? null);
      out.push(row);
    }
    return out;
  }
}
