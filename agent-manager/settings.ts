/**
 * agent-manager — 设置解析与持久化（W3）。
 *
 * 优先级：CLI flag > 环境变量 > 配置文件 > 默认值（对齐设计 §3.3）。
 * 环境变量：AGENT_MANAGER_PORT / AGENT_MANAGER_SESSION_DIR / AGENT_MANAGER_PI / AGENT_MANAGER_NO_OPEN。
 * 配置文件：`<home>/.pi/agent/agent-manager/config.json`（工具自有数据目录，与 trash 同根）。
 *
 * 零运行时依赖（只 node 内置）；fs 经 SettingsDeps 注入，测试用临时文件覆盖进程边界。
 * 端口改动下次启动生效（由 server 标注 restartRequired）；sessionDir/piPath 即时生效。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentManagerSettings {
  port: number;
  sessionDir: string;
  piPath?: string;
  /** 固定派生（非用户设置项）：`<home>/.pi/agent/agent-manager/trash` */
  trashDir: string;
  openBrowser: boolean;
}

export interface CliArgs {
  port?: number;
  sessions?: string;
  pi?: string;
  noOpen?: boolean;
  help?: boolean;
}

export interface SettingsDeps {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  mkdirSync(p: string, options: { recursive: true }): void;
  homedir(): string;
}

/** 保存时允许改动的字段（trashDir/openBrowser 非用户设置项）。 */
export interface SettingsPartial {
  sessionDir?: string;
  piPath?: string;
  port?: number;
}

export const nodeSettingsDeps: SettingsDeps = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data, "utf8"),
  mkdirSync: (p, options) => {
    mkdirSync(p, options);
  },
  homedir,
};

export const USAGE = `agent-manager — 独立 agent 管理工具（仅监听 127.0.0.1）

用法：
  node agent-manager/server.ts [选项]

选项：
  --port <端口>       监听端口（默认 8787；0 = 随机端口）
  --sessions <目录>   会话目录（默认 <home>/.pi/agent/sessions）
  --pi <路径>         pi 可执行文件或 cli.js 路径（默认 PATH 中的 pi）
  --no-open           启动后不自动打开浏览器
  --help, -h          显示本帮助

环境变量（优先级：CLI > 环境变量 > 配置文件 > 默认值）：
  AGENT_MANAGER_PORT / AGENT_MANAGER_SESSION_DIR / AGENT_MANAGER_PI / AGENT_MANAGER_NO_OPEN=1

配置文件：<home>/.pi/agent/agent-manager/config.json（设置页面可写）`;

const DEFAULT_PORT = 8787;
const PORT_MAX = 65535;

type ParseArgsResult =
  | { ok: true; value: CliArgs }
  | { ok: false; code: "SETTINGS_BAD_ARGS"; message: string };

function badArgs(message: string): ParseArgsResult {
  return { ok: false, code: "SETTINGS_BAD_ARGS", message };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 0 && port <= PORT_MAX ? port : undefined;
}

/** 解析 CLI 参数；未知参数/非法取值一律 SETTINGS_BAD_ARGS（不静默忽略）。 */
export function parseArgs(argv: string[]): ParseArgsResult {
  const value: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    if (flag === "--help" || flag === "-h") {
      value.help = true;
      continue;
    }
    if (flag === "--no-open") {
      value.noOpen = true;
      continue;
    }
    if (flag !== "--port" && flag !== "--sessions" && flag !== "--pi") {
      return badArgs(`存在无法识别的参数：${flag}（--help 查看用法）`);
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) return badArgs(`参数 ${flag} 需要一个取值`);
    if (flag === "--port") {
      const port = parsePort(raw);
      if (port === undefined) return badArgs("--port 需要 0-65535 的整数");
      value.port = port;
    } else if (flag === "--sessions") {
      if (!raw.trim()) return badArgs("--sessions 不能为空");
      value.sessions = raw.trim();
    } else {
      if (!raw.trim()) return badArgs("--pi 不能为空");
      value.pi = raw.trim();
    }
  }
  return { ok: true, value };
}

interface ConfigFile {
  port?: number;
  sessionDir?: string;
  piPath?: string;
}

/** 读配置文件；缺失/坏 JSON/字段类型不对一律当空配置（工具设置不该炸启动）。 */
function readConfig(configPath: string, deps: SettingsDeps): ConfigFile {
  if (!deps.existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFileSync(configPath));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = parsed as Record<string, unknown>;
  const config: ConfigFile = {};
  if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= PORT_MAX) {
    config.port = raw.port;
  }
  if (typeof raw.sessionDir === "string" && raw.sessionDir.trim()) config.sessionDir = raw.sessionDir.trim();
  if (typeof raw.piPath === "string" && raw.piPath.trim()) config.piPath = raw.piPath.trim();
  return config;
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim()) return value.trim();
  }
  return undefined;
}

function isEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}

function defaultTrashDirFor(home: string): string {
  return join(home, ".pi", "agent", "agent-manager", "trash");
}

/** 默认配置文件路径（server 主入口与测试显式传参之外的唯一来源）。 */
export function defaultConfigPath(): string {
  return join(homedir(), ".pi", "agent", "agent-manager", "config.json");
}

/** 按四级优先级解析出运行时设置；配置文件缺失/损坏不构成错误。 */
export function resolveSettings(cli: CliArgs, env: Record<string, string>, configPath: string, deps: SettingsDeps): AgentManagerSettings {
  const config = readConfig(configPath, deps);
  const home = deps.homedir();
  const port = cli.port ?? parsePort(env.AGENT_MANAGER_PORT ?? "") ?? config.port ?? DEFAULT_PORT;
  const sessionDir = firstText(cli.sessions, env.AGENT_MANAGER_SESSION_DIR, config.sessionDir) ?? join(home, ".pi", "agent", "sessions");
  const piPath = firstText(cli.pi, env.AGENT_MANAGER_PI, config.piPath);
  const openBrowser = cli.noOpen === true ? false : !isEnabled(env.AGENT_MANAGER_NO_OPEN);
  return { port, sessionDir, piPath, trashDir: defaultTrashDirFor(home), openBrowser };
}

function validatePartial(partial: SettingsPartial): string | undefined {
  if (partial.port !== undefined && (!Number.isInteger(partial.port) || partial.port < 0 || partial.port > PORT_MAX)) {
    return "port 需要 0-65535 的整数";
  }
  if (partial.sessionDir !== undefined && !partial.sessionDir.trim()) return "sessionDir 不能为空";
  return undefined;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "UNKNOWN";
}

/**
 * 保存部分设置到配置文件（与现有内容合并）；piPath 传空串表示清除该项。
 * 失败：非法值 → SETTINGS_INVALID；写盘失败 → SESSION_WRITE_FAILED（静态模板 + 底层 code）。
 */
export function saveSettings(
  configPath: string,
  partial: SettingsPartial,
  deps: SettingsDeps,
): { ok: true; value: AgentManagerSettings } | { ok: false; code: "SETTINGS_INVALID" | "SESSION_WRITE_FAILED"; message: string } {
  const invalid = validatePartial(partial);
  if (invalid) return { ok: false, code: "SETTINGS_INVALID", message: invalid };

  const config = readConfig(configPath, deps);
  if (partial.port !== undefined) config.port = partial.port;
  if (partial.sessionDir !== undefined) config.sessionDir = partial.sessionDir.trim();
  if (partial.piPath !== undefined) {
    const piPath = partial.piPath.trim();
    if (piPath) config.piPath = piPath;
    else delete config.piPath;
  }

  try {
    deps.mkdirSync(dirname(configPath), { recursive: true });
    deps.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    return { ok: false, code: "SESSION_WRITE_FAILED", message: `写入配置文件失败（${errorCode(error)}）` };
  }
  return { ok: true, value: resolveSettings({}, {}, configPath, deps) };
}
