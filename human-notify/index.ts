/**
 * human-notify - 人工介入 Windows Toast 通知扩展
 *
 * 两类事件发送系统原生 Toast,把人叫回终端:
 * - `ui_prompt_start`(kind = confirm / select / input / editor / custom)→“Pi 等待你确认”
 * - `tool_execution_start` 且 `toolName` 在 `WAITING_TOOL_NAMES` 名单(首批:`plan_mode_question`)
 *   →“Pi 等待你确认”(宿主内置审批/提问不走 `ui_prompt_start`,只能按工具名特判)
 * - `agent_settled`(已完全 settle,无自动重试/压缩/续跑)→“Pi 任务完成”
 *   但用户主动取消(Esc / Ctrl+C 中断回合)后的结算不弹 Toast——人都走了还喊人回来看，
 *   纯打扰；信号沿用 goal 扩展已验证的取消标记模式(`turn_end` / `agent_end` 记录
 *   `ctx.signal?.aborted`,`agent_start` 重置,`agent_settled` 触发前检查)。
 *
 * 仅 Windows 生效(`process.platform === "win32"`),Linux / macOS 直接 no-op。
 * Windows Toast 经内联 WinRT PowerShell 发送,零 npm 依赖;`child_process.spawn`
 * detached + unref 派生,不阻塞会话、不持有会话资源。发送失败静默吞掉,
 * 绝不抛错、不破坏会话、不写敏感信息。
 * 文案为差异化模板 + 截断摘要:审批/等人工具/结束三类正文各带一句话摘要
 * (摘要取最新 assistant 尾部文本或等人工具 args 中的问题文本),
 * 统一经 80 码点尾部截断 + 120 码点整体截断 + XML 转义,不透传工具原始输出与密钥。
 * 全局 5s 防抖窗口:窗口内重复事件只发第一次。
 * `PI_HUMAN_NOTIFY=0` 一键关闭(精确匹配,大小写敏感)。
 *
 * 安装:复制本目录到 ~/.pi/agent/extensions/human-notify/ 或
 *       <项目>/.pi/extensions/human-notify/,在 Pi 中执行 /reload。卸载即删除目录。
 * 测试:node --experimental-strip-types --test human-notify/index.test.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn as nodeSpawn } from "node:child_process";

// ===== 常量 =====

/** 需要人工审批/输入时的 Toast 标题 */
export const PROMPT_TITLE = "Pi 等待你确认";
/** agent 完全结束时的 Toast 标题 */
export const DONE_TITLE = "Pi 任务完成";
/** 全局防抖窗口:窗口内重复事件只发第一次 */
export const DEBOUNCE_MS = 5000;
/** 通知正文最长字符数(按码点计,超限截断并追加 …) */
export const MAX_SUMMARY = 120;
/** 摘要最长字符数(按码点计):摘要先截到 80 再拼入正文,正文整体仍受 MAX_SUMMARY 约束 */
export const MAX_SUMMARY_TAIL = 80;
/** 会触发通知的 ui_prompt kind(以宿主 UIPromptKind 定义为准) */
export const NOTIFY_KINDS = ["confirm", "select", "input", "editor", "custom"] as const;
/** 会触发通知的工具名名单:这类工具启动即意味着在等人工(须显式维护) */
export const WAITING_TOOL_NAMES = ["plan_mode_question"] as const;

/** agent 结束通知正文(静态模板,无摘要可用时回退) */
const DONE_BODY = "Agent 运行已结束，请回到终端查看结果。";

/** 等人工具的中文标签(仅用于正文模板,名单外工具不用) */
const WAITING_TOOL_LABELS: Record<string, string> = {
  plan_mode_question: "问题",
};
const KIND_LABELS: Record<string, string> = {
  confirm: "确认",
  select: "选择",
  input: "输入",
  editor: "编辑",
  custom: "自定义",
};

// ===== 依赖注入 =====

export interface HumanNotifyDeps {
  /** 派生函数(测试用 fake);缺省 `node:child_process.spawn` */
  spawn?: typeof nodeSpawn;
  /** 平台标识(测试用);缺省 `process.platform` */
  platform?: string;
  /** 注入时钟(测试用);缺省 `Date.now` */
  nowMs?: () => number;
  /** 环境变量表(测试用);缺省 `process.env` */
  env?: Record<string, string | undefined>;
}

// ===== 纯函数:开关 / 截断 / 脚本拼装 =====

/** 平台开关:Linux / macOS 直接 no-op;`PI_HUMAN_NOTIFY=0` 精确匹配关闭 */
export function shouldNotify(platform: string, env: Record<string, string | undefined>): boolean {
  return platform === "win32" && env?.PI_HUMAN_NOTIFY !== "0";
}

/** 压单行:换行/制表符折叠为单空格,连续空格合并,去两端空白 */
function squeeze(text: string): string {
  return (text ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 按码点截断到 max(超限追加 …),入参须已压单行 */
function clamp(single: string, max: number): string {
  const chars = Array.from(single);
  if (chars.length <= max) return single;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/** 压单行 + 按码点截断到 MAX_SUMMARY(超限追加 …) */
export function truncateSummary(text: string): string {
  return clamp(squeeze(text), MAX_SUMMARY);
}

/** 压单行 + 按码点截断到 MAX_SUMMARY_TAIL(超限追加 …);摘要拼入正文前的第一道截断 */
export function truncateTailSummary(text: string): string {
  return clamp(squeeze(text), MAX_SUMMARY_TAIL);
}

/** XML 转义(Toast 正文经 XmlDocument.LoadXml 解析,必须先转义) */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * 拼装内联 WinRT PowerShell 脚本(以 `-Command` 参数传入 powershell.exe)。
 * 标题正文均先截断再转义,不透传原始换行与 XML 元字符。
 */
export function buildToastScript(title: string, body: string): string {
  const safeTitle = escapeXml(truncateSummary(title));
  const safeBody = escapeXml(truncateSummary(body));
  // 转义后理论上已无单引号(变为 &apos;),再做一层 PowerShell 单引号转义兜底
  const psXml = `<toast><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeBody}</text></binding></visual></toast>`.replace(/'/g, "''");
  return `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null; $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml('${psXml}'); $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi Coding Agent').Show($toast)`;
}

/**
 * 提取 assistant 消息 content 中的文本块(忽略 thinking/toolResult 等非文本块),
 * 拼接返回;不做截断与压行(调用方负责)。对齐 goal 的证据提取思路。
 */
export function extractAssistantText(content: unknown): string {
  const parts: string[] = [];
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    const item = block as { type?: unknown; text?: unknown } | null;
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) parts.push(item.text);
  }
  return parts.join("\n\n");
}

/**
 * 从等人工具 args 提取用户可读的问题文本(防御式收窄,unknown 入参):
 * 目前仅 plan_mode_question 的 questions[0].question;取不到返回 undefined,由调用方回退。
 */
export function extractWaitingQuestion(toolName: string, args: unknown): string | undefined {
  if (!(WAITING_TOOL_NAMES as readonly string[]).includes(toolName)) return undefined;
  if (!args || typeof args !== "object") return undefined;
  const questions = (args as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0] as { question?: unknown } | null;
  if (!first || typeof first !== "object") return undefined;
  const question = first.question;
  if (typeof question !== "string" || !question.trim()) return undefined;
  return question;
}

/** 等人工具通知正文:有摘要(工具问题或 assistant 尾部)拼入,否则回退静态模板 */
function buildWaitingBody(toolName: string, summary: string | undefined): string {
  const label = WAITING_TOOL_LABELS[toolName] ?? "请求";
  if (summary && summary.trim()) return truncateSummary(`收到${label}，请回到终端处理：${summary}`);
  return truncateSummary(`收到${label}，请回到终端处理`);
}

/** 审批/输入通知正文:有摘要(assistant 尾部)拼入,否则回退现事件标题后缀模板 */
function buildPromptBody(kind: string, title: string | undefined, summary: string | undefined): string {
  const label = KIND_LABELS[kind] ?? kind;
  if (summary && summary.trim()) return truncateSummary(`收到${label}请求，请回到终端处理：${summary}`);
  const suffix = title && title.trim() ? `：${truncateSummary(title)}` : "";
  return truncateSummary(`收到${label}请求，请回到终端处理${suffix}`);
}

/** 结束通知正文:有摘要(assistant 尾部)出本轮结论,否则回退静态模板 */
function buildDoneBody(summary: string | undefined): string {
  if (summary && summary.trim()) return truncateSummary(`本轮结论：${summary}`);
  return DONE_BODY;
}

// ===== 扩展工厂 =====

interface SpawnHandle {
  unref?: () => void;
  on?: (event: string, listener: () => void) => void;
}

export function createHumanNotifyExtension(pi: ExtensionAPI, deps: HumanNotifyDeps = {}): void {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const env = deps.env ?? process.env;

  let lastSentMs = Number.NEGATIVE_INFINITY;
  /** 最新一条 assistant 消息的尾部文本(已截到 MAX_SUMMARY_TAIL);session_start 重置防跨会话泄漏 */
  let latestAssistantTail = "";
  /** 用户在当前 run 中主动取消(Esc / Ctrl+C)的标记;agent_start 重置,agent_settled 触发前检查 */
  let userInterrupted = false;

  function fire(title: string, body: string): void {
    try {
      if (!shouldNotify(platform, env)) return;
      const now = nowMs();
      if (now - lastSentMs < DEBOUNCE_MS) return;
      lastSentMs = now;
      const script = buildToastScript(title, body);
      let child: SpawnHandle;
      try {
        child = (spawnFn as (cmd: string, args: string[], opts: unknown) => SpawnHandle)("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          script,
        ], { detached: true, stdio: "ignore" });
      } catch {
        // 派生失败静默吞掉,不破坏会话
        return;
      }
      try {
        // noop error 监听:避免子进程 'error' 事件无人处理时抛错
        child.on?.("error", () => {});
        // detached + unref:不持有会话资源
        child.unref?.();
      } catch {
        /* 忽略 */
      }
    } catch {
      // 防御性兜底:通知链路任何异常都不破坏会话
    }
  }

  pi.on("agent_start", async () => {
    try {
      // 重置取消标记:上一次 run 被取消不得抑制下一次正常完成的结算 Toast
      userInterrupted = false;
    } catch {
      /* 忽略 */
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      if ((ctx as { signal?: { aborted?: boolean } } | undefined)?.signal?.aborted) userInterrupted = true;
    } catch {
      /* 忽略 */
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      // agent_settled 晚于 agent_end,此处标记在 settle 触发前已可见
      if ((ctx as { signal?: { aborted?: boolean } } | undefined)?.signal?.aborted) userInterrupted = true;
    } catch {
      /* 忽略 */
    }
  });

  pi.on("session_start", () => {
    try {
      latestAssistantTail = "";
    } catch {
      /* 忽略 */
    }
  });

  pi.on("message_end", (event) => {
    try {
      const message = (event as { message?: unknown }).message;
      if (!message || typeof message !== "object") return;
      const msg = message as { role?: unknown; content?: unknown };
      if (msg.role !== "assistant") return;
      const text = extractAssistantText(msg.content);
      if (!text.trim()) return;
      latestAssistantTail = truncateTailSummary(text);
    } catch {
      /* 忽略 */
    }
  });

  pi.on("ui_prompt_start", (event) => {
    try {
      const kind = (event as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !(NOTIFY_KINDS as readonly string[]).includes(kind)) return;
      const rawTitle = (event as { title?: unknown }).title;
      fire(PROMPT_TITLE, buildPromptBody(kind, typeof rawTitle === "string" ? rawTitle : undefined, latestAssistantTail));
    } catch {
      /* 忽略 */
    }
  });

  pi.on("tool_execution_start", (event) => {
    try {
      const toolName = (event as { toolName?: unknown }).toolName;
      // 先查名单再进 fire:非名单工具直接返回,不消耗全局防抖窗口
      if (typeof toolName !== "string" || !(WAITING_TOOL_NAMES as readonly string[]).includes(toolName)) return;
      // 摘要优先取 args 中用户可读的问题文本,取不到回退 assistant 尾部
      const question = extractWaitingQuestion(toolName, (event as { args?: unknown }).args) ?? latestAssistantTail;
      fire(PROMPT_TITLE, buildWaitingBody(toolName, question));
    } catch {
      /* 忽略 */
    }
  });

  pi.on("agent_settled", () => {
    try {
      // 用户主动取消后的结算不弹 Toast;在 fire 之前返回,不消耗 5s 防抖窗口
      if (userInterrupted) return;
      fire(DONE_TITLE, buildDoneBody(latestAssistantTail));
    } catch {
      /* 忽略 */
    }
  });
}

export default function humanNotifyExtension(pi: ExtensionAPI): void {
  createHumanNotifyExtension(pi);
}
