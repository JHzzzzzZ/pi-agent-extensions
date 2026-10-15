/**
 * btw - 侧对话上下文组装（纯函数，无宿主依赖）
 *
 * 输入 = 宿主 `sessionManager.buildContextEntries()` 的条目（压缩感知的当前分支），
 * 输出 = 给侧模型的纯文本转录 + 省略计数。
 *
 * 口径（对齐文档 btw-todo#1）：
 * - 条目**由新到旧**累加到预算为止，旧条目先丢；丢多少如实标注，不静默截断。
 * - 单块另有独立上限：工具结果动辄几万字符，不逐块截断会把预算一口吃光。
 * - `system` 与非对话条目（model_change / label / custom 等）不进侧上下文。
 * - 正在流式、尚未落盘的那一条看不到——这是 MVP 的已知限制，写进 README。
 */
import {
  MAX_ASSISTANT_BLOCK_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_USER_BLOCK_CHARS,
} from "./spec.ts";

/**
 * 只读这些字段的条目形状（宿主 `SessionEntry` 结构化兼容；测试可构造最小对象）。
 * `message` 覆盖 user / assistant / toolResult / bashExecution / custom 五种角色。
 */
export interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    command?: string;
    exitCode?: number;
    output?: string;
  };
  summary?: string;
  content?: unknown;
}

export interface ContextText {
  /** 组装好的侧对话上下文（旧 → 新；超预算时头部带省略标注） */
  text: string;
  /** 计入的条目数 */
  included: number;
  /** 因预算省略的条目数 */
  omitted: number;
}

/** 按码点截断（超限追加 …），入参须已 trim；极端预算下只留省略号，绝不超 max */
function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  return chars.slice(0, max - 1).join("") + "…";
}

/** 压单行：换行/制表符折叠为单空格（命令原文等场景） */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** 文本块拼接（图片折叠为占位符；thinking / toolCall 不计入） */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[图片]");
  }
  return parts.join("\n");
}

/** assistant 消息里的工具调用预览（参数 JSON 截断） */
function toolCallLines(content: unknown): string[] {
  const lines: string[] = [];
  for (const block of blocksOf(content)) {
    if (block?.type !== "toolCall") continue;
    const name = typeof block.name === "string" && block.name ? block.name : "?";
    let args = "";
    try {
      args = clamp(flatten(JSON.stringify(block.arguments ?? {})), MAX_TOOL_ARGS_CHARS);
    } catch {
      args = "";
    }
    lines.push(`[工具调用] ${name}(${args})`);
  }
  return lines;
}

function renderMessage(message: TranscriptEntry["message"]): string | undefined {
  if (!message || typeof message.role !== "string") return undefined;
  switch (message.role) {
    case "user": {
      const text = textOfContent(message.content).trim();
      return text ? `[用户] ${clamp(text, MAX_USER_BLOCK_CHARS)}` : undefined;
    }
    case "assistant": {
      const parts: string[] = [];
      const text = textOfContent(message.content).trim();
      if (text) parts.push(clamp(text, MAX_ASSISTANT_BLOCK_CHARS));
      parts.push(...toolCallLines(message.content));
      return parts.length > 0 ? `[助手] ${parts.join("\n")}` : undefined;
    }
    case "toolResult": {
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
      const text = textOfContent(message.content).trim();
      return `[工具结果] ${name} ${text ? clamp(text, MAX_TOOL_RESULT_CHARS) : "(空结果)"}`;
    }
    case "bashExecution": {
      const command = typeof message.command === "string" ? clamp(flatten(message.command), MAX_TOOL_ARGS_CHARS) : "";
      const output = typeof message.output === "string" ? message.output.trim() : "";
      const exit = message.exitCode === undefined ? "?" : String(message.exitCode);
      return `[命令] ${command} → exit ${exit}${output ? `\n${clamp(output, MAX_TOOL_RESULT_CHARS)}` : ""}`;
    }
    case "custom": {
      const text = textOfContent(message.content).trim();
      return text ? `[扩展消息] ${clamp(text, MAX_ASSISTANT_BLOCK_CHARS)}` : undefined;
    }
    default:
      return undefined;
  }
}

/** 单个会话条目 → 上下文块；不参与的条目返回 undefined（system 等） */
export function renderTranscriptEntry(entry: TranscriptEntry | undefined): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  if (entry.type === "message") return renderMessage(entry.message);
  if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
    return `[更早对话的压缩摘要]\n${clamp(entry.summary.trim(), MAX_ASSISTANT_BLOCK_CHARS)}`;
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
    return `[分支摘要]\n${clamp(entry.summary.trim(), MAX_ASSISTANT_BLOCK_CHARS)}`;
  }
  if (entry.type === "custom_message") {
    const text = textOfContent(entry.content).trim();
    if (text) return `[扩展消息] ${clamp(text, MAX_ASSISTANT_BLOCK_CHARS)}`;
  }
  return undefined;
}

/**
 * 分支条目 → 侧对话上下文字本。预算按字符计（非 token），由新到旧装填，
 * **连分隔符（每块 `\n\n`）与省略标注头一起计入**（否则极端多小块时实际输出
 * 可达预算的 2–3 倍）；一个块都装不下时只留最新块并截到剩余预算。
 */
export function buildContextText(
  entries: readonly TranscriptEntry[],
  budget: number = MAX_CONTEXT_CHARS,
): ContextText {
  const newestFirst: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const block = renderTranscriptEntry(entries[index]);
    if (block) newestFirst.push(block);
  }
  // 省略标注头按最坏情况（全部条目都被省略）预留长度，装填时就不超预算。
  const headerCost = omittedHeader(newestFirst.length).length;
  const separator = "\n\n";
  const picked: string[] = [];
  let used = 0;
  for (const block of newestFirst) {
    const cost = block.length + separator.length;
    if (used + cost + headerCost > budget) break;
    picked.push(block);
    used += cost;
  }
  if (picked.length === 0 && newestFirst.length > 0) {
    picked.push(clamp(newestFirst[0]!, Math.max(1, budget - headerCost)));
  }
  const omitted = newestFirst.length - picked.length;
  const body = picked.reverse().join(separator);
  // 预留已保证正常路径下标注头装得下；极小预算下宁可少一行标注也不超预算
  // （标注是给人看的，预算是不变量）。
  const header = omittedHeader(omitted);
  const text = `${header.length + body.length <= budget ? header : ""}${body}`;
  return { text, included: picked.length, omitted };
}

function omittedHeader(omitted: number): string {
  return omitted > 0 ? `（更早的 ${omitted} 条已省略）\n\n` : "";
}
