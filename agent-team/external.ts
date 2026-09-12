/**
 * external.ts — 外部 agent CLI 适配器（v1: codex / claude，10-design §4 冻结接口）
 *
 * 三层纯逻辑：① 命令解析 resolveExternalCli（Windows 的 .cmd/.ps1 shim 不能
 * shell:false spawn，必须解析到真实可执行文件；也刻意不经 `node codex.js`
 * 包装器——Windows 的 SIGTERM 是 TerminateProcess，只杀直子进程，孙进程
 * codex.exe 会孤儿化继续烧 API）；② 非交互参数构建 buildExternalArgs；
 * ③ stdout JSONL 事件解析 createExternalParser。进程骨架沿用 runner.ts 的
 * runChildPi（spawn/SIGTERM→SIGKILL/stderr/pid），本模块不 import 其他运行时
 * 模块，保持纯函数可测。
 *
 * 三禁（违反即安全/进程事故）：
 * ① 禁 shell:true —— 只 shell:false 直接 spawn 解析出的原生可执行文件；
 * ② 禁 team-tmp:// scheme —— runChildPi 会把该前缀的 --append-system-prompt 值
 *    物化成临时文件路径，而 claude 的 --append-system-prompt 吃纯文本，必须原样传；
 * ③ 任务文本只进 argv 末位位置参数 —— prompt/task 永不进 shell 命令串、永不进 stdin。
 *
 * 解析顺序（确定性）：env 覆盖（PI_AGENT_TEAM_{CODEX|CLAUDE}_BIN）→ PATH 直查
 * （win32: <dir>/<cli>.exe；posix: <dir>/<cli>）→ win32 npm 全局布局兜底（以命中
 * .cmd shim 的 PATH 目录为根）→ CLI_NOT_FOUND。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  EXTERNAL_BACKENDS,
  EXTERNAL_BIN_ENV,
  MAX_TRANSCRIPT_MESSAGE_BYTES,
  emptyUsage,
  err,
  ok,
  truncateUtf8,
  TeamErrorCodes,
  type ChildEvent,
  type ExternalBackend,
  type ExternalCliResolveResult,
  type ExternalParser,
  type ExternalResolveDeps,
} from "./types.ts";

export { EXTERNAL_BACKENDS, EXTERNAL_BIN_ENV };
export type { ExternalParser, ExternalResolveDeps };

/** CLI 未找到（单一错误表引用，评审 #1：移除 B-only 时期的双跳断言）。 */
const CLI_NOT_FOUND = TeamErrorCodes.CLI_NOT_FOUND;

/** codex vendored 包的 arch → Rust triple 映射（探测 P1）。 */
const CODEX_VENDOR_TRIPLE: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };

/** 解析顺序第 2 步：PATH 直查的文件名（win32 只认 .exe）。 */
function directName(backend: ExternalBackend, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${backend}.exe` : backend;
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
}

function splitPathList(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  return value.split(platform === "win32" ? ";" : ":");
}

function normalizeDir(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/** 解析顺序第 3 步：win32 npm 全局布局候选（探测 P1 的真实路径）。 */
function npmLayoutCandidates(backend: ExternalBackend, root: string, arch: string): string[] {
  if (backend === "claude") {
    return [joinFor("win32", root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")];
  }
  const triple = CODEX_VENDOR_TRIPLE[arch];
  if (!triple) return [];
  const target = `${triple}-pc-windows-msvc`;
  const pkg = `codex-win32-${arch}`;
  return [
    joinFor(
      "win32",
      root,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      pkg,
      "vendor",
      target,
      "bin",
      "codex.exe",
    ),
    joinFor("win32", root, "node_modules", "@openai", pkg, "vendor", target, "bin", "codex.exe"),
  ];
}

function notFoundMessage(backend: ExternalBackend, envKey: string, platform: NodeJS.Platform): string {
  const searched =
    platform === "win32"
      ? "PATH 中的 <dir>/<cli>.exe 与 Windows npm 全局布局（node_modules/@openai/codex vendor 或 @anthropic-ai/claude-code）"
      : "PATH 中的 <dir>/<cli>";
  return `未找到可直接 spawn 的 ${backend} CLI：已检查 ${searched}。请安装 ${backend}，或在环境变量 ${envKey} 中给出可执行文件绝对路径（逃生门）。`;
}

/**
 * 解析可直接 spawn 的可执行文件（shell:false 安全）。
 * 失败唯一码 CLI_NOT_FOUND；永不返回 .cmd/.ps1 shim，也永不返回 node 包装器。
 */
export function resolveExternalCli(
  backend: ExternalBackend,
  deps: ExternalResolveDeps = {},
): ExternalCliResolveResult {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const envKey = EXTERNAL_BIN_ENV[backend];

  // 1) env 逃生门：命中即用；无效值 fail-closed，不静默回退 PATH。
  const override = env[envKey];
  if (override !== undefined) {
    if (override.length > 0 && exists(override)) return ok({ command: override });
    return err(CLI_NOT_FOUND, `环境变量 ${envKey} 指向的可执行文件不存在；请修正该变量或删除后重试。`);
  }

  // 2) PATH 直查；3) win32 npm 全局布局兜底（.cmd shim 只作命中标记，不作命令）。
  const dirs = deps.pathDirs ?? splitPathList(env.PATH, platform);
  for (const raw of dirs) {
    const dir = normalizeDir(raw);
    if (!dir) continue;
    const direct = joinFor(platform, dir, directName(backend, platform));
    if (exists(direct)) return ok({ command: direct });
    if (platform === "win32" && exists(joinFor("win32", dir, `${backend}.cmd`))) {
      for (const candidate of npmLayoutCandidates(backend, dir, arch)) {
        if (exists(candidate)) return ok({ command: candidate });
      }
    }
  }

  // 4) 全部未命中。
  return err(CLI_NOT_FOUND, notFoundMessage(backend, envKey, platform));
}

/**
 * 非交互参数构建（纯函数）。任务文本只出现在末位位置参数。
 * codex 无公开 system-prompt flag：member.prompt 并入任务文本开头；
 * claude 的 `--verbose` 是 `-p + --output-format stream-json` 的硬要求，缺失即 exit=1（P8）。
 */
export function buildExternalArgs(
  backend: ExternalBackend,
  member: { model?: string; prompt: string },
  task: string,
): string[] {
  if (backend === "codex") {
    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write"];
    if (member.model) args.push("--model", member.model);
    args.push(`${member.prompt}\n\n---\n\nTask: ${task}`);
    return args;
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
  ];
  if (member.prompt.length > 0) args.push("--append-system-prompt", member.prompt);
  if (member.model) args.push("--model", member.model);
  args.push(`Task: ${task}`);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 单行 + 尾部截断（与 runner.textTail 同语义；刻意不 import runner 保持纯适配层）。 */
function textTail(text: string, max = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `…${singleLine.slice(singleLine.length - max)}`;
}

function assistantMessageEnd(text: string): ChildEvent {
  if (text.length === 0) return { type: "message_end", role: "assistant" };
  return {
    type: "message_end",
    role: "assistant",
    text: textTail(text),
    fullText: truncateUtf8(text, MAX_TRANSCRIPT_MESSAGE_BYTES),
  };
}

/** stdout JSONL 行 → 既有 ChildEvent 流的增量解析器。 */
export function createExternalParser(backend: ExternalBackend): ExternalParser {
  const usage = emptyUsage();
  const toolNames = new Map<string, string>();
  let finalText = "";
  let model: string | undefined;
  let failed = false;
  let errorMessage: string | undefined;

  /** codex 事件映射（P6/P7）：turn.completed 累加 usage、item.error 非致命、turn.failed 致命。 */
  const feedCodex = (message: Record<string, unknown>): ChildEvent[] => {
    const type = message.type;
    if (type === "item.started" || type === "item.completed") {
      const item = asRecord(message.item);
      if (!item) return [];
      if (type === "item.started" && item.type === "command_execution") {
        return [{ type: "tool_execution_start", toolName: "shell" }];
      }
      if (type === "item.completed") {
        if (item.type === "agent_message") {
          const text = typeof item.text === "string" ? item.text : "";
          finalText = text;
          return [assistantMessageEnd(text)];
        }
        if (item.type === "command_execution") {
          return [{ type: "tool_execution_end", toolName: "shell" }];
        }
        if (item.type === "error") {
          const text = typeof item.message === "string" ? item.message : "codex item error";
          return [{ type: "error", code: "EXTERNAL_ITEM_ERROR", message: text }];
        }
      }
      return [];
    }
    if (type === "turn.completed") {
      const raw = asRecord(message.usage);
      if (raw) {
        usage.input += toNumber(raw.input_tokens);
        usage.cacheRead += toNumber(raw.cached_input_tokens);
        usage.cacheWrite += toNumber(raw.cache_write_input_tokens);
        usage.output += toNumber(raw.output_tokens);
        // codex usage 无 cost 字段（P6）：费用恒 0，token 照折。
      }
      usage.turns += 1;
      return [];
    }
    if (type === "turn.failed") {
      failed = true;
      const error = asRecord(message.error);
      errorMessage = typeof error?.message === "string" ? error.message : "codex turn failed";
      return [];
    }
    return [];
  };

  /** claude 事件映射（P8）：result 定稿 usage、只认 is_error 判失败、subtype 不参与判定。 */
  const feedClaude = (message: Record<string, unknown>): ChildEvent[] => {
    const type = message.type;
    if (type === "system") {
      // 超大 system/init 行只取 model，其余不进 transcript。
      if (typeof message.model === "string") model = message.model;
      return [];
    }
    if (type === "assistant") {
      const payload = asRecord(message.message);
      const content = Array.isArray(payload?.content) ? payload.content : [];
      const events: ChildEvent[] = [];
      const texts: string[] = [];
      const starts: ChildEvent[] = [];
      for (const block of content) {
        const part = asRecord(block);
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string") {
          texts.push(part.text);
        } else if (part.type === "tool_use") {
          const name = typeof part.name === "string" ? part.name : "?";
          if (typeof part.id === "string" && part.id.length > 0) toolNames.set(part.id, name);
          starts.push({ type: "tool_execution_start", toolName: name });
        }
      }
      const text = texts.join("\n");
      if (text.length > 0) {
        finalText = text;
        events.push(assistantMessageEnd(text));
      }
      events.push(...starts);
      return events;
    }
    if (type === "user") {
      const payload = asRecord(message.message);
      const content = Array.isArray(payload?.content) ? payload.content : [];
      const events: ChildEvent[] = [];
      for (const block of content) {
        const part = asRecord(block);
        if (!part || part.type !== "tool_result") continue;
        const id = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
        events.push({ type: "tool_execution_end", toolName: toolNames.get(id) ?? "?" });
      }
      return events;
    }
    if (type === "result") {
      // usage 定稿：result.usage 是整轮权威值，覆盖 assistant 的增量。
      const raw = asRecord(message.usage);
      usage.input = toNumber(raw?.input_tokens);
      usage.cacheRead = toNumber(raw?.cache_read_input_tokens);
      usage.cacheWrite = toNumber(raw?.cache_creation_input_tokens);
      usage.output = toNumber(raw?.output_tokens);
      usage.cost = toNumber(message.total_cost_usd);
      usage.turns = toNumber(message.num_turns);
      const result = typeof message.result === "string" ? message.result : "";
      if (result.length > 0) finalText = result;
      // 失败判定只认 is_error（P8：失败时 subtype 仍可为 "success"）+ 调用侧 exitCode。
      if (message.is_error === true) {
        failed = true;
        errorMessage = result.length > 0 ? result : "claude CLI reported an error";
      }
      return [];
    }
    return [];
  };

  return {
    feed: (message) => (backend === "codex" ? feedCodex(message) : feedClaude(message)),
    finalize: () => (errorMessage === undefined ? { failed } : { failed, errorMessage }),
    get usage() {
      return { ...usage };
    },
    get finalText() {
      return finalText;
    },
    get model() {
      return model;
    },
  };
}
