/**
 * agent-manager — HTTP server（W3）。
 *
 * 独立于 pi 的本地工具服务：仅 listen 127.0.0.1（拒绝 0.0.0.0），15 条 JSON 路由 +
 * web/ 静态白名单；不 import 宿主 SDK、不注册任何 pi 扩展点、不 spawn 除 pi/浏览器外的进程。
 *
 * 安全守卫（最小且可测）：Host 头白名单（防 DNS rebinding）、POST 强制
 * application/json（挡跨站表单 CSRF）、请求体 ≤1MB、静态路径白名单（用户输入永不进路径拼接）。
 *
 * 两段式写操作：rename/delete/restore 默认 dry-run 返回计划，请求体 `confirm:true` 才产生副作用。
 * agents 面委托 AgentRunner（W2）；会话面委托 core（W1）。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentErrorCodes,
  AgentRunner,
  resolvePiCommand,
  type AgentStartSpec,
} from "./agent-runner.ts";
import {
  deleteSession,
  listSessions,
  listTrash,
  previewSession,
  renameSession,
  restoreSession,
  searchSessions,
  sessionRootOf,
  type SessionErrorCode,
  type SessionFilter,
  type SessionResult,
} from "./core.ts";
import {
  defaultConfigPath,
  nodeSettingsDeps,
  parseArgs,
  resolveSettings,
  saveSettings,
  USAGE,
  type AgentManagerSettings,
  type SettingsPartial,
} from "./settings.ts";

/** 与 package.json 保持同步（health 回显用；不读盘，避免启动 I/O）。 */
const VERSION = "1.0.0";
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
  settings: AgentManagerSettings;
  /** 默认 new AgentRunner({ invocation: resolvePiCommand(settings.piPath, platform) }) */
  runner?: AgentRunner;
  configPath?: string;
  /** 默认 <server.ts 所在目录>/web */
  webDir?: string;
  now?: () => string;
}

export interface ServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const HttpErrorCodes = {
  BAD_REQUEST: "HTTP_BAD_REQUEST",
  UNSUPPORTED_MEDIA_TYPE: "HTTP_UNSUPPORTED_MEDIA_TYPE",
  FORBIDDEN_HOST: "HTTP_FORBIDDEN_HOST",
  NOT_FOUND: "HTTP_NOT_FOUND",
  METHOD_NOT_ALLOWED: "HTTP_METHOD_NOT_ALLOWED",
  INTERNAL: "HTTP_INTERNAL",
} as const;

const SESSION_STATUS: Record<SessionErrorCode, number> = {
  SESSION_DIR_MISSING: 400,
  SESSION_BAD_QUERY: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_AMBIGUOUS: 409,
  SESSION_BAD_NAME: 400,
  SESSION_WRITE_FAILED: 500,
  SESSION_TARGET_EXISTS: 409,
  SESSION_TRASH_MISSING: 404,
};

const AGENT_STATUS: Record<string, number> = {
  AGENT_BAD_SPEC: 400,
  AGENT_NOT_FOUND: 404,
  AGENT_NOT_RUNNING: 409,
  AGENT_SPAWN_FAILED: 500,
};

const API_PATHS = new Set([
  "/api/health",
  "/api/sessions",
  "/api/sessions/search",
  "/api/sessions/preview",
  "/api/sessions/rename",
  "/api/sessions/delete",
  "/api/trash",
  "/api/trash/restore",
  "/api/agents",
  "/api/agents/start",
  "/api/settings",
]);

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

interface ServerState {
  settings: AgentManagerSettings;
  configPath: string;
  webDir: string;
  now: () => string;
  runner: AgentRunner;
  /** 未注入 runner 时 piPath 变更可安全重建（空闲时） */
  useDefaultRunner: boolean;
  port: number;
}

/** 启动服务：仅绑 127.0.0.1；port 0 → 随机端口，经 handle.port 回报。 */
export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const state: ServerState = {
    settings: { ...options.settings },
    configPath: options.configPath ?? defaultConfigPath(),
    webDir: options.webDir ?? join(dirname(fileURLToPath(import.meta.url)), "web"),
    now: options.now ?? (() => new Date().toISOString()),
    runner: options.runner ?? new AgentRunner({ invocation: resolvePiCommand(options.settings.piPath, process.platform) }),
    useDefaultRunner: options.runner === undefined,
    port: 0,
  };
  const server = createServer((req, res) => {
    void handleRequest(state, req, res);
  });
  state.port = await listenLocal(server, state.settings.port);
  if (state.settings.openBrowser) openBrowser(`http://127.0.0.1:${state.port}/`);
  return { server, port: state.port, close: () => closeServer(server) };
}

function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address() as AddressInfo | null;
      resolvePromise(address ? address.port : port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
}

/** 打开系统浏览器；失败只提示、不致命（WSL/无默认浏览器等场景）。 */
export function openBrowser(url: string): void {
  try {
    const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: true });
    child.on("error", () => console.error(`无法自动打开浏览器，请手动访问：${url}`));
    child.unref();
  } catch {
    console.error(`无法自动打开浏览器，请手动访问：${url}`);
  }
}

async function handleRequest(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!hostAllowed(req.headers.host)) {
      sendError(res, 403, HttpErrorCodes.FORBIDDEN_HOST, "仅允许通过本机地址访问");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(state, req, res, url);
      return;
    }
    serveStatic(state, req, res, url.pathname);
  } catch {
    sendError(res, 500, HttpErrorCodes.INTERNAL, "服务器内部错误");
  }
}

/** Host 白名单：hostname 必须是 127.0.0.1 / localhost / [::1]（含可选端口）。 */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  const name = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

async function handleApiRequest(state: ServerState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "GET" && (await handleGet(state, res, url))) return;
  if (method === "POST" && (await handlePost(state, req, res, url))) return;
  const agentPath = /^\/api\/agents\/[^/]+(\/output|\/stop)?$/.test(url.pathname);
  if (API_PATHS.has(url.pathname) || agentPath) {
    sendError(res, 405, HttpErrorCodes.METHOD_NOT_ALLOWED, "方法不允许");
    return;
  }
  sendError(res, 404, HttpErrorCodes.NOT_FOUND, "未知路由");
}

async function handleGet(state: ServerState, res: ServerResponse, url: URL): Promise<boolean> {
  switch (url.pathname) {
    case "/api/health":
      sendOk(res, {
        version: VERSION,
        port: state.port,
        sessionDir: state.settings.sessionDir,
        piCommand: resolvePiCommand(state.settings.piPath, process.platform),
      });
      return true;
    case "/api/sessions":
      sendSessionsList(state, res, url);
      return true;
    case "/api/sessions/search":
      sendSessionResult(res, searchSessions(sessionRoot(state), url.searchParams.get("q") ?? "", sessionFilter(url)));
      return true;
    case "/api/sessions/preview":
      sendSessionResult(res, previewSession(sessionRoot(state), url.searchParams.get("ref") ?? ""));
      return true;
    case "/api/trash":
      sendSessionResult(res, listTrash(state.settings.trashDir));
      return true;
    case "/api/agents":
      sendOk(res, state.runner.list());
      return true;
    case "/api/settings":
      sendOk(res, settingsPayload(state));
      return true;
  }
  const output = /^\/api\/agents\/([^/]+)\/output$/.exec(url.pathname);
  if (output) {
    sendAgentOutput(state, res, output[1], url);
    return true;
  }
  const single = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
  if (single) {
    sendAgent(state, res, single[1]);
    return true;
  }
  return false;
}

async function handlePost(state: ServerState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  switch (url.pathname) {
    case "/api/sessions/rename":
      await postRename(state, req, res);
      return true;
    case "/api/sessions/delete":
      await postDelete(state, req, res);
      return true;
    case "/api/trash/restore":
      await postRestore(state, req, res);
      return true;
    case "/api/agents/start":
      await postAgentStart(state, req, res);
      return true;
    case "/api/settings":
      await postSettings(state, req, res);
      return true;
  }
  const stop = /^\/api\/agents\/([^/]+)\/stop$/.exec(url.pathname);
  if (stop) {
    await postAgentStop(state, req, res, stop[1]);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 会话面

function sessionRoot(state: ServerState): string {
  return sessionRootOf(state.settings.sessionDir);
}

function sessionFilter(url: URL): SessionFilter {
  const filter: SessionFilter = {};
  const cwd = url.searchParams.get("cwd");
  if (cwd) filter.cwd = cwd;
  const limit = url.searchParams.get("limit");
  if (limit !== null && /^\d+$/.test(limit) && Number(limit) > 0) filter.limit = Number(limit);
  return filter;
}

function sendSessionsList(state: ServerState, res: ServerResponse, url: URL): void {
  const filter = sessionFilter(url);
  const result = listSessions(sessionRoot(state), { cwd: filter.cwd });
  if (!result.ok) {
    sendSessionResult(res, result);
    return;
  }
  const limit = filter.limit;
  sendOk(res, limit === undefined ? result.value : result.value.slice(0, limit));
}

async function postRename(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const ref = textField(body.value, "ref");
  const name = textField(body.value, "name");
  if (ref === undefined || name === undefined) {
    sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "ref/name 必须是字符串");
    return;
  }
  sendSessionResult(res, renameSession(sessionRoot(state), ref, name, { confirm: body.value.confirm === true, now: state.now }));
}

async function postDelete(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const ref = textField(body.value, "ref");
  if (ref === undefined) {
    sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "ref 必须是字符串");
    return;
  }
  sendSessionResult(res, deleteSession(sessionRoot(state), ref, { confirm: body.value.confirm === true, now: state.now, trashDir: state.settings.trashDir }));
}

async function postRestore(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const name = textField(body.value, "name");
  if (name === undefined) {
    sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "name 必须是字符串");
    return;
  }
  sendSessionResult(res, restoreSession(state.settings.trashDir, name, { confirm: body.value.confirm === true }));
}

// ------------------------------------------------------------------ agents 面

async function postAgentStart(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const spec = parseStartSpec(body.value);
  if (!spec) {
    sendError(res, 400, AgentErrorCodes.BAD_SPEC, "agent 参数不完整或非法");
    return;
  }
  const started = state.runner.start(spec);
  if (!started.ok) {
    sendError(res, AGENT_STATUS[started.code] ?? 500, started.code, started.message);
    return;
  }
  sendOk(res, started.value);
}

function parseStartSpec(body: Record<string, unknown>): AgentStartSpec | undefined {
  const kind = body.kind;
  if (kind !== "new" && kind !== "resume" && kind !== "fork") return undefined;
  if (typeof body.cwd !== "string" || typeof body.prompt !== "string") return undefined;
  const spec: AgentStartSpec = { cwd: body.cwd, prompt: body.prompt, kind };
  if (typeof body.model === "string" && body.model.trim()) spec.model = body.model.trim();
  if (typeof body.name === "string" && body.name.trim()) spec.name = body.name.trim();
  if (typeof body.sessionRef === "string" && body.sessionRef.trim()) spec.sessionRef = body.sessionRef.trim();
  return spec;
}

function sendAgent(state: ServerState, res: ServerResponse, id: string): void {
  const record = state.runner.get(id);
  if (!record) {
    sendError(res, 404, AgentErrorCodes.NOT_FOUND, "agent 不存在");
    return;
  }
  sendOk(res, record);
}

function sendAgentOutput(state: ServerState, res: ServerResponse, id: string, url: URL): void {
  const raw = url.searchParams.get("since");
  let since: number | undefined;
  if (raw !== null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "since 需要非负整数");
      return;
    }
    since = parsed;
  }
  const output = state.runner.output(id, since);
  if (!output) {
    sendError(res, 404, AgentErrorCodes.NOT_FOUND, "agent 不存在");
    return;
  }
  sendOk(res, output);
}

async function postAgentStop(state: ServerState, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const result = await state.runner.stop(id);
  if (!result.ok) {
    sendError(res, AGENT_STATUS[result.code] ?? 500, result.code, result.message);
    return;
  }
  sendOk(res, result.value);
}

// ------------------------------------------------------------------ 设置面

function settingsPayload(state: ServerState): Record<string, unknown> {
  return {
    settings: state.settings,
    resolvedPi: resolvePiCommand(state.settings.piPath, process.platform),
    configPath: state.configPath,
    restartRequired: false,
  };
}

async function postSettings(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const partial = parseSettingsPartial(body.value);
  if (!partial) {
    sendError(res, 400, "SETTINGS_INVALID", "设置字段类型非法");
    return;
  }
  const saved = saveSettings(state.configPath, partial, nodeSettingsDeps);
  if (!saved.ok) {
    sendError(res, saved.code === "SETTINGS_INVALID" ? 400 : 500, saved.code, saved.message);
    return;
  }

  const previous = state.settings;
  state.settings = {
    ...previous,
    sessionDir: partial.sessionDir ?? previous.sessionDir,
    piPath: partial.piPath ?? previous.piPath,
    port: partial.port ?? previous.port,
  };
  const restartRequired = applyRunnerChange(state, partial, previous);
  sendOk(res, { saved: state.settings, restartRequired });
}

/**
 * piPath 变更的处理：仅默认 runner 且无运行中 agent 时重建（新路径立即生效）；
 * 有运行中 agent 时保留旧 runner（不丢记录）并报告需重启（响应 restartRequired）。
 */
function applyRunnerChange(state: ServerState, partial: SettingsPartial, previous: AgentManagerSettings): boolean {
  let restartRequired = partial.port !== undefined && partial.port !== previous.port;
  const piChanged = partial.piPath !== undefined && partial.piPath !== previous.piPath;
  if (!piChanged || !state.useDefaultRunner) return restartRequired;
  if (state.runner.list().some((record) => record.status === "running")) {
    restartRequired = true;
    return restartRequired;
  }
  state.runner = new AgentRunner({ invocation: resolvePiCommand(state.settings.piPath, process.platform) });
  return restartRequired;
}

function parseSettingsPartial(body: Record<string, unknown>): SettingsPartial | undefined {
  const partial: SettingsPartial = {};
  if ("sessionDir" in body) {
    if (typeof body.sessionDir !== "string") return undefined;
    partial.sessionDir = body.sessionDir;
  }
  if ("piPath" in body) {
    if (typeof body.piPath !== "string") return undefined;
    partial.piPath = body.piPath;
  }
  if ("port" in body) {
    if (typeof body.port !== "number") return undefined;
    partial.port = body.port;
  }
  return partial;
}

// ------------------------------------------------------------------ 请求体

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false };

function textField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<BodyResult> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    sendError(res, 415, HttpErrorCodes.UNSUPPORTED_MEDIA_TYPE, "POST 必须使用 application/json");
    return { ok: false };
  }
  const raw = await readBodyText(req);
  if (!raw.ok) {
    sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "请求体超过 1MB 上限或读取失败");
    return { ok: false };
  }
  const text = raw.text.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    sendError(res, 400, HttpErrorCodes.BAD_REQUEST, "请求体不是合法 JSON 对象");
    return { ok: false };
  }
}

type BodyTextResult = { ok: true; text: string } | { ok: false };

/** 限长读体：超限立即停下并 resume 排空，保证客户端能读到 400 响应。 */
function readBodyText(req: IncomingMessage): Promise<BodyTextResult> {
  return new Promise((resolvePromise) => {
    let size = 0;
    let text = "";
    let done = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.resume();
        resolvePromise({ ok: false });
        return;
      }
      text += chunk;
    });
    req.on("end", () => {
      if (!done) resolvePromise({ ok: true, text });
    });
    req.on("error", () => {
      if (!done) resolvePromise({ ok: false });
    });
  });
}

// ------------------------------------------------------------------ 静态资源

function serveStatic(state: ServerState, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    sendError(res, 404, HttpErrorCodes.NOT_FOUND, "未知路径");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(res, 405, HttpErrorCodes.METHOD_NOT_ALLOWED, "方法不允许");
    return;
  }
  let content: string;
  try {
    content = readFileSync(join(state.webDir, entry.file), "utf8");
  } catch {
    sendError(res, 500, HttpErrorCodes.INTERNAL, "静态资源缺失");
    return;
  }
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : content);
}

// ------------------------------------------------------------------ 响应助手

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendOk(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value });
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, code, message });
}

function sendSessionResult<T>(res: ServerResponse, result: SessionResult<T>): void {
  if (result.ok) {
    sendOk(res, result.value);
    return;
  }
  sendError(res, SESSION_STATUS[result.code] ?? 500, result.code, result.message);
}

// ------------------------------------------------------------------ 主入口

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (parsed.value.help) {
    console.log(USAGE);
    return;
  }
  const configPath = defaultConfigPath();
  const settings = resolveSettings(parsed.value, collectEnv(), configPath, nodeSettingsDeps);
  const handle = await startServer({ settings, configPath });
  console.log(`agent-manager 已启动：http://127.0.0.1:${handle.port}/`);
  console.log(`会话目录：${settings.sessionDir}`);
  console.log("仅监听 127.0.0.1；按 Ctrl+C 退出。");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
