/**
 * btw 真机 opt-in 测试（需要真实模型 + 网络 + 本机凭据）：把宿主当黑盒跑验收标准 1–2。
 *
 * 为什么值得单独一条真机用例：纯假宿主测不出「扩展命令在真实 RPC 会话里能不能被派发」
 * 「真实 streamSimple 链路能不能出答案」与「真实会话文件是否零新增条目」——这三件事
 * 全在宿主边界上。真机目标未设（`PI_BTW_E2E_MODEL`）或无凭据时 `skip`，绝不静默绿。
 *
 * 用法（PowerShell / bash 均可）：
 *   PI_BTW_E2E_MODEL=zai-coding-cn/glm-5.3-flash npm test
 * 凭据：默认从 `~/.pi/agent/auth.json`（或 `PI_CODING_AGENT_DIR`）复制到**临时** agent
 * 目录，跑完即删；测试绝不写用户真实配置目录（红线 8）。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..", "index.ts");
const MODEL = process.env.PI_BTW_E2E_MODEL;
const USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const AUTH = path.join(USER_AGENT_DIR, "auth.json");
const SKIP = !MODEL
  ? "PI_BTW_E2E_MODEL 未设（opt-in 真机目标）"
  : !fs.existsSync(AUTH)
    ? `无凭据文件 ${AUTH}`
    : undefined;

interface RpcEvent {
  type?: string;
  id?: string;
  method?: string;
  message?: string;
  notifyType?: string;
  disposition?: string;
  success?: boolean;
  /** prompt 响应形状：`{type:"response", id, command:"prompt", success, data:{disposition}}` */
  data?: { disposition?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function parseEvents(stdout: string): RpcEvent[] {
  const events: RpcEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as RpcEvent);
    } catch {
      /* 非 JSON 行忽略（宿主诊断输出） */
    }
  }
  return events;
}

function makeTempAgentDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btw-real-"));
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.copyFileSync(AUTH, path.join(dir, "auth.json"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      /* 句柄占用时留给系统临时区 */
    }
  });
  return dir;
}

interface SessionScript {
  write: (record: Record<string, unknown>) => void;
  waitFor: (predicate: (stdout: string) => boolean, timeoutMs: number, label: string) => Promise<void>;
}

/** 起真实 `pi --mode rpc`（只加载本扩展），跑一段脚本，收尾后返回全部输出。 */
async function runRpcSession(
  configDir: string,
  timeoutMs: number,
  script: (io: SessionScript) => Promise<void>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const args = [
    "--mode",
    "rpc",
    "--extension",
    EXT,
    "--model",
    String(MODEL),
    "--session-dir",
    path.join(configDir, "sessions"),
  ];
  const [command, commandArgs] =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pi", ...args]]
      : ["pi", args];
  const child = spawn(command, commandArgs, {
    cwd: os.tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  let timedOut = false;
  const hardKill = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const io: SessionScript = {
    write: (record) => {
      child.stdin.write(`${JSON.stringify(record)}\n`);
    },
    waitFor: async (predicate, waitMs, label) => {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (predicate(stdout)) return;
        if (timedOut) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`真机会话等待超时：${label}\n--- stdout 末尾 ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(0, 800)}`);
    },
  };

  try {
    await script(io);
  } finally {
    child.stdin.end();
  }
  const exitCode = await exited;
  clearTimeout(hardKill);
  return { exitCode, stdout, stderr, timedOut };
}

interface SessionMessage {
  role?: string;
  text: string;
}

/** 读临时会话目录里全部 JSONL，归一成消息列表 + 原文（零写入断言的证据面）。 */
function sessionContent(configDir: string): { messages: SessionMessage[]; raw: string } {
  const root = path.join(configDir, "sessions");
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (String(entry).endsWith(".jsonl")) files.push(path.join(root, String(entry)));
  }
  const messages: SessionMessage[] = [];
  let raw = "";
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    raw += content;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (parsed.type !== "message") continue;
        messages.push({ role: parsed.message?.role, text: contentText(parsed.message?.content) });
      } catch {
        /* 跳过无法解析的行 */
      }
    }
  }
  return { messages, raw };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof (block as { text?: unknown })?.text === "string" ? String((block as { text: string }).text) : ""))
    .join("\n");
}

test("真机：空闲会话 /btw 出真实模型回答，且会话文件零新增条目", { skip: SKIP }, async (t) => {
  const configDir = makeTempAgentDir(t);
  const run = await runRpcSession(configDir, 180_000, async ({ write, waitFor }) => {
    write({ id: "q1", type: "prompt", message: "/btw 用一句话回答：你看到的这段会话现在在做什么？" });
    await waitFor((stdout) => /"method":"notify"/.test(stdout), 150_000, "侧对话通知");
  });

  assert.equal(run.timedOut, false, "pi 进程必须有界结束");
  const events = parseEvents(run.stdout);
  const prompt = events.find((event) => event.id === "q1");
  assert.equal(prompt?.data?.disposition, "handled", `扩展命令必须被宿主直接处理（不进主对话）；实际响应：${JSON.stringify(prompt)?.slice(0, 200)}`);
  const notifies = events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
  assert.ok(notifies.length >= 1, "必须收到侧对话通知");
  const answer = String(notifies.at(-1)?.message ?? "");
  assert.ok(answer.trim().length >= 4, `答案不得为空（收到：${answer.slice(0, 120)}）`);
  assert.ok(!/侧调用失败|没有可用模型|已超时/.test(answer), `不得是失败文案（收到：${answer.slice(0, 120)}）`);
  assert.deepEqual(
    sessionContent(configDir).messages.filter((m) => m.role === "user" || m.role === "assistant"),
    [],
    "侧对话不得往会话文件写 user/assistant 条目",
  );
});

test("真机：主 agent 流式跑工具时 /btw 仍能作答（notify 先于 agent_settled）", { skip: SKIP }, async (t) => {
  const configDir = makeTempAgentDir(t);
  const run = await runRpcSession(configDir, 240_000, async ({ write, waitFor }) => {
    write({ id: "m1", type: "prompt", message: "请用 bash 工具执行这一条命令：sleep 25。不要执行其它命令，也不要解释。" });
    await waitFor((stdout) => /"type":"tool_execution_start"/.test(stdout), 120_000, "主 agent 的工具调用");
    write({ id: "q2", type: "prompt", message: "/btw 用一句话说明主 agent 现在正在做什么？" });
    await waitFor(
      (stdout) => /"method":"notify"/.test(stdout) && !/"type":"agent_settled"/.test(stdout),
      120_000,
      "主 run 落定前的侧对话通知",
    );
  });

  assert.equal(run.timedOut, false, "pi 进程必须有界结束");
  const events = parseEvents(run.stdout);
  const question = events.find((event) => event.id === "q2");
  assert.equal(question?.data?.disposition, "handled", `运行中的扩展命令必须立即执行；实际响应：${JSON.stringify(question)?.slice(0, 200)}`);
  const notifies = events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
  assert.ok(notifies.length >= 1, "运行中必须收到侧对话通知");
  const answer = String(notifies.at(-1)?.message ?? "");
  assert.ok(answer.trim().length >= 4, `答案不得为空（收到：${answer.slice(0, 120)}）`);
  // 零写入的“主 run 版”断言：主 agent 自己的消息照常落盘，但侧问答绝不进会话文件。
  const session = sessionContent(configDir);
  const users = session.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1, `只有主 run 自己那一条 user 消息；实际：${JSON.stringify(session.messages.map((m) => m.role))}`);
  assert.ok(users[0]!.text.includes("sleep 25"), "那一条就是主 run 的提示词");
  assert.ok(!session.raw.includes("主 agent 现在正在做什么"), "侧提问不得出现在会话文件里");
});
