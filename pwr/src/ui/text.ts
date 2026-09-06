/**
 * PWR UI - ANSI/CJK-aware text measuring helpers (JHL-18)
 *
 * Ported from the sibling agent-team extension's viewer (same workspace,
 * battle-tested against East-Asian double-width output). Shared by the
 * /workflows:view frame renderer and the structure diagram so every line
 * fills the bordered frame exactly regardless of Chinese text or ANSI
 * styling.
 *
 * Pure and dependency-free; fully unit-tested.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Display width of one character (East Asian wide = 2, else 1). */
export function charWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** Word-less greedy wrap that counts CJK characters as width 2. */
export function wrapText(text: string, width: number): string[] {
	if (width < 1) return text.split("\n");
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		let lineWidth = 0;
		for (const ch of paragraph) {
			const w = charWidth(ch);
			if (lineWidth + w > width && line.length > 0) {
				out.push(line);
				line = "";
				lineWidth = 0;
			}
			line += ch;
			lineWidth += w;
		}
		out.push(line);
	}
	return out.length > 0 ? out : [""];
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** Display width ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const ch of stripAnsi(text)) width += charWidth(ch);
	return width;
}

/** Pads a (possibly styled) line with trailing spaces to the display width. */
export function padLine(line: string, width: number): string {
	const pad = width - visibleWidth(line);
	return pad > 0 ? line + " ".repeat(pad) : line;
}

/** Truncates PLAIN text (no ANSI) to the display width with an ellipsis. */
export function truncateVisible(text: string, width: number): string {
	if (width < 1) return "";
	let out = "";
	let lineWidth = 0;
	for (const ch of text) {
		const w = charWidth(ch);
		if (lineWidth + w > width - 1) return `${out}…`;
		out += ch;
		lineWidth += w;
	}
	return out;
}
