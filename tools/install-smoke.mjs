/**
 * tools/install-smoke.mjs — 全新安装加载冒烟（GOAL.md §2「别人这把」）
 *
 * 外部用户拿到仓库后最可能卡住的一步不是功能，而是"扩展到底装没装上"。
 * 本工具把 README 的「方式二：手动复制」当真跑一遍：在一个全新的临时
 * `PI_CODING_AGENT_DIR` 下建立 `extensions/`，把根 package.json `pi`
 * manifest 列出的全部扩展目录复制进去（排除 node_modules），再拉起一个
 * 真实的 `pi --mode rpc` 进程，用 `get_commands` 索取命令面并核对：
 *
 *   1. 进程退出码 0 且 stderr 为空（扩展加载报错时 pi 会 exit 1 + stderr）；
 *   2. 每个扩展期望的命令全部存在，且路径都落在本次临时安装目录内
 *      （防止偷偷加载到真实用户配置里的旧拷贝）；
 *   3. 无命令扩展（run-timer / stream-token-speed / agent-team widget…）以
 *      启动期 TUI 写入事件（setWidget / setStatus）证明其 session_start
 *      真的跑过。
 *
 * 为什么不是普通单测：加载失败的真实信号只有真 pi 进程给得出（宿主对
 * 扩展的发现、TS type-stripping、模块解析全在进程边界另一侧）。这里只
 * fake 不了——所以真的拉起 pi。工具本身零依赖（Node 内置 + 真实 pi CLI）。
 *
 * 用法（仓库根）：
 *   node tools/install-smoke.mjs            # 跑冒烟，失败退出码 1
 *   node tools/install-smoke.mjs --task     # 冒烟通过后再跑一条真实模型任务（opt-in）
 *   node tools/install-smoke.mjs --keep     # 保留临时安装目录（排查用）
 *   node tools/install-smoke.mjs --json     # 机器可读结果
 *   node tools/install-smoke.mjs --install <pi install 源>
 *       # 真跑一遍 README 推荐的 `pi install` 安装路径（opt-in，需联网）：
 *       # 全新临时配置目录里执行真实 `pi install <源>`，再核对装到的包
 *       # 版本/扩展清单与全部命令/TUI 键；本地路径源同样适用。
 *       # 例：node tools/install-smoke.mjs --install git:github.com/JHzzzzzZ/pi-agent-extensions@dev-laptop
 *
 * --install 与 --task 可叠加：先证明 pi install 装出来的包能用，再让模型在
 * 该安装形态下真调一次扩展工具。
 *
 * --task 深度任务（GOAL.md §2「别人这把」：从零装到跑通核心流程）：在同一个临时安装目录里
 * 复制用户 auth.json（只在临时目录内使用、随目录一起删除，绝不打印内容），拉起
 * `pi --mode json -p --tools <工具>` 走一次真实模型调用，用事件流的
 * tool_execution_start/end 证明扩展工具在全新安装下真的能被模型调用并成功执行。
 * 模型默认从真实配置 settings.json 的 defaultProvider/defaultModel 推导，可用 --model 覆盖。
 *
 * 纯校验逻辑（loadManifest / extensionDirsFromManifest / parseRpcOutput /
 * checkSmoke / buildDeepArgs / parseJsonEvents / checkDeepRun / deepModelFromSettings /
 * installSourceKind / piPackageSearchRoots / findPiPackage / checkInstallRun）
 * 导出给 `test/install-smoke.test.ts` 单测；CLI 只在直接执行时跑。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/**
 * 每个扩展的最小期望面。命令名锁定已发布的命令契约（重命名/删除会响亮
 * 失败，新增命令不需改这里）；uiKeys 是扩展在 session_start 期间写入宿主
 * 的 widget/status 键，用于证明"无命令扩展"也真的加载并跑起来了。
 */
export const EXTENSION_EXPECTATIONS = {
  pwr: {
    commands: [
      "workflow",
      "workflow:approve",
      "workflow:delete",
      "workflow:help",
      "workflow:list",
      "workflow:model",
      "workflow:open",
      "workflow:pause",
      "workflow:restart",
      "workflow:resume",
      "workflow:run",
      "workflow:save",
      "workflow:saved",
      "workflow:script",
      "workflow:stop",
      "workflow:view",
    ],
    uiKeys: ["30:pwr", "pwr-runs"],
  },
  "agent-team": {
    commands: ["team", "team:clear", "team:doctor", "team:list", "team:run", "team:status", "team:stop", "team:view"],
    uiKeys: ["agent-team"],
  },
  loop: {
    commands: ["loop", "loop:clear", "loop:delete", "loop:list", "loop:pause", "loop:resume"],
    uiKeys: ["loop"],
  },
  goal: {
    commands: [
      "goal",
      "goal:cancel",
      "goal:clear",
      "goal:none",
      "goal:off",
      "goal:reset",
      "goal:resume",
      "goal:status",
      "goal:stop",
    ],
    uiKeys: ["10:goal"],
  },
  "opencode-bridge": {
    commands: ["opencode-bridge", "opencode-bridge:restore", "opencode-bridge:status", "opencode-bridge:sync"],
    uiKeys: [],
  },
  "deep-init": { commands: ["deep-init"], uiKeys: [] },
  "provider-quota": { commands: ["quota"], uiKeys: ["20:provider-quota"] },
  "solo-mode": { commands: ["solo", "solo:off", "solo:on", "solo:status"], uiKeys: ["40:solo-mode"] },
  // 无命令扩展：只能以启动期 TUI 写入或"加载不抛错"证明。
  "run-timer": { commands: [], uiKeys: ["run-timer"] },
  "stream-token-speed": { commands: [], uiKeys: ["50:stream-token-speed"] },
  "human-notify": { commands: [], uiKeys: [] },
  "chatanywhere-provider": { commands: [], uiKeys: [] },
};

/** 读取根 package.json 的 pi.extensions 清单（加载冒烟的复制清单）。 */
export function loadManifest(repoRoot) {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const entries = raw?.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("根 package.json 缺少 pi.extensions 清单");
  }
  return entries;
}

/** `./pwr/index.ts` → `pwr`；入口约定 `extensions/<dir>/index.ts`。 */
export function extensionDirsFromManifest(manifest) {
  return manifest.map((entry) => {
    const dir = entry.replace(/^\.\//, "").split("/")[0];
    if (!dir) throw new Error(`无法从 manifest 条目解析扩展目录: ${entry}`);
    return dir;
  });
}

/** manifest 与期望表必须一一对应——新增扩展忘了登记就要在冒烟里失败。 */
export function findManifestDrift(dirs, expectations = EXTENSION_EXPECTATIONS) {
  const problems = [];
  for (const dir of dirs) {
    if (!expectations[dir]) problems.push(`扩展 ${dir} 在 pi.extensions 中，但未登记安装冒烟期望`);
  }
  for (const dir of Object.keys(expectations)) {
    if (!dirs.includes(dir)) problems.push(`期望表登记了 ${dir}，但 pi.extensions 清单里没有它`);
  }
  return problems;
}

/**
 * 解析 `pi --mode rpc` 的 JSONL 输出：跳过 extension_ui_request 事件并记录
 * widget/status 键，返回 id 命中的响应行。
 */
export function parseRpcOutput(text, id) {
  const commands = [];
  const uiKeys = new Set();
  let response;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "extension_ui_request") {
      const key = event.widgetKey ?? event.statusKey;
      if (key) uiKeys.add(String(key));
      continue;
    }
    if (event.id === id) response = event;
  }
  if (response?.data?.commands) {
    for (const command of response.data.commands) commands.push(command);
  }
  return { commands, uiKeys, response };
}

/**
 * 纯校验：输入一次冒烟的全部观察值，输出问题清单（空 = 通过）。
 * baseDir 允许传多个根（本地路径安装时命令来自源目录而非临时配置目录）——任何
 * 扩展命令的 sourceInfo.path 不在任一允许根下，都说明加载的不是这份拷贝
 * （真实用户配置串入 / 路径拼错）。
 */
export function checkSmoke({ exitCode, stderr, spawnError, commands, uiKeys, baseDir, expectations = EXTENSION_EXPECTATIONS, dirs }) {
  const problems = [];
  if (spawnError) return [`无法启动 pi 进程：${spawnError}`];
  if (exitCode !== 0) {
    problems.push(`pi 进程退出码 ${exitCode}（扩展加载失败时宿主 exit 1）`);
  }
  const stderrText = (stderr ?? "").trim();
  if (stderrText) problems.push(`pi stderr 非空：\n${stderrText}`);

  if (problems.length > 0) return problems;

  const byName = new Set(commands.map((command) => command.name));
  const roots = (Array.isArray(baseDir) ? baseDir : [baseDir]).filter(Boolean).map((dir) => path.resolve(dir));
  const expectedDirs = dirs ?? Object.keys(expectations);
  for (const dir of expectedDirs) {
    const expected = expectations[dir];
    if (!expected) continue;
    for (const name of expected.commands) {
      if (!byName.has(name)) problems.push(`扩展 ${dir} 缺少命令 /${name}`);
    }
    for (const key of expected.uiKeys) {
      if (!uiKeys.has(key)) problems.push(`扩展 ${dir} 未写入启动期 TUI 键 ${key}`);
    }
  }
  if (roots.length > 0) {
    for (const command of commands) {
      const sourcePath = command?.sourceInfo?.path;
      if (!sourcePath || sourcePath.startsWith("<")) continue; // 宿主内联扩展（llama.cpp）
      if (!roots.some((root) => path.resolve(sourcePath).startsWith(root))) {
        problems.push(`命令 /${command.name} 来自 ${sourcePath}，不在本次安装目录 ${roots.join(" / ")} 内`);
      }
    }
  }
  return problems;
}

/** 复制一个扩展目录（排除 node_modules/.git），保持"手动复制整目录"的真实形态。 */
export function copyExtension(srcDir, destDir) {
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== "node_modules" && name !== ".git";
    },
  });
}

/**
 * 安装源类型判定（对齐宿主 `parseSource` 的口径）：`npm:` → npm；git URL（`git:`
 * 前缀 / http(s) / ssh / github.com 简写）→ git；其余按本地路径处理。
 */
export function installSourceKind(source) {
  if (typeof source !== "string" || source.trim() === "") return undefined;
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || source.startsWith("http://") || source.startsWith("https://") || source.startsWith("ssh://") || source.startsWith("github.com/")) {
    return "git";
  }
  return "local";
}

/**
 * 安装产物搜索根（镜像宿主落盘位置）：git → `<configDir>/git`；npm →
 * `<configDir>/npm/node_modules`；本地路径 → 源目录本身（不复制不克隆）。
 * 本地路径排在前面：先认可源目录，再回退到临时目录。
 */
export function piPackageSearchRoots(source, configDir) {
  const roots = [path.join(configDir, "git"), path.join(configDir, "npm", "node_modules")];
  if (installSourceKind(source) === "local") roots.unshift(path.resolve(source));
  return roots;
}

/** 从磁盘定位已安装的 pi 包：带非空 `pi.extensions` 清单的 package.json。 */
export function findPiPackage(roots, maxDepth = 6) {
  for (const root of roots) {
    const found = findPiPackageInDir(root, maxDepth);
    if (found) return found;
  }
  return undefined;
}

function findPiPackageInDir(dir, depth) {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (Array.isArray(manifest?.pi?.extensions) && manifest.pi.extensions.length > 0) {
        return { dir, name: manifest.name, version: manifest.version, extensions: manifest.pi.extensions };
      }
    } catch {
      // 坏 package.json：跳过本目录，继续往下找。
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const found = findPiPackageInDir(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** 纯校验：`pi install <源>` 的观察值 → 问题清单；成功后由 findPiPackage 核对落地产物。 */
export function checkInstallRun({ exitCode, stderr, spawnError, stdout = "", source }) {
  if (spawnError) return [`安装源：无法启动 pi 进程：${spawnError}`];
  const problems = [];
  if (exitCode !== 0) {
    problems.push(`安装源：pi install 退出码 ${exitCode}`);
    const stderrText = (stderr ?? "").trim();
    if (stderrText) problems.push(`安装源：pi install stderr：\n${stderrText}`);
    return problems;
  }
  // git 克隆进度写在 stderr（“Cloning into …”），所以具体错误看退出码；
  // stdout 的确认行是“确实装了”的响亮信号（宿主 install 成功后打印 Installed <source>）。
  if (!stdout.includes(`Installed ${source}`)) {
    problems.push(`安装源：pi install 输出未见 "Installed ${source}"（安装被静默跳过？）`);
  }
  return problems;
}

const SMOKE_REQUEST_ID = "install-smoke-1";

/** 深任务默认被测工具：只读、结果确定（全新环境返回"没有定时任务。"）。 */
export const DEEP_DEFAULT_TOOL = "loop_list";

/** 让模型必须经过工具才能作答的提示词。 */
export function deepPrompt(tool) {
  return `请调用 ${tool} 工具，然后把工具返回的内容原样复述一遍。`;
}

/** 显式 --model 优先；否则由真实用户配置的 defaultProvider/defaultModel 拼 provider/id。 */
export function deepModelFromSettings(settings, explicitModel) {
  if (explicitModel) return explicitModel;
  const provider = settings?.defaultProvider;
  const model = settings?.defaultModel;
  if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) return undefined;
  return `${provider}/${model}`;
}

/** `--tools` 只放行被测工具：模型没有别的工具可用，是否调用即为确定性信号。 */
export function buildDeepArgs({ model, tool = DEEP_DEFAULT_TOOL }) {
  const args = ["--mode", "json", "-p", "--no-session", "--tools", tool];
  if (model) args.push("--model", model);
  args.push(deepPrompt(tool));
  return args;
}

/** 解析 `pi --mode json` 的 JSONL 事件流；OSC 通知转义、日志行一律跳过。 */
export function parseJsonEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 非事件行：忽略。
    }
  }
  return events;
}

/**
 * 纯校验：深任务的观察值 → 问题清单。核心信号是事件流里的工具执行——
 * 模型自由文本不作为判据（措辞不可控），工具真的跑过才算数。
 */
export function checkDeepRun({ exitCode, stderr, spawnError, events = [], tool = DEEP_DEFAULT_TOOL }) {
  if (spawnError) return [`深任务：无法启动 pi 进程：${spawnError}`];
  if (exitCode !== 0) {
    const problems = [`深任务：pi 进程退出码 ${exitCode}`];
    const stderrText = (stderr ?? "").trim();
    if (stderrText) problems.push(`深任务：pi stderr：\n${stderrText}`);
    return problems;
  }
  const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === tool);
  const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === tool);
  if (starts.length === 0) return [`深任务：模型未调用工具 ${tool}（工具未注册 / 提示词未遵循）`];
  if (ends.length === 0) return [`深任务：工具 ${tool} 未执行完成（进程提前退出？）`];
  if (!ends.some((event) => event.isError === false)) return [`深任务：工具 ${tool} 执行报错`];
  return [];
}

function spawnPi({ configDir, args, timeoutMs, stdin = "", extraEnv = {}, cwd = configDir }) {
  // Windows 上 pi 是 .cmd，必须经 cmd.exe 解析；显式拼 ComSpec 而不是
  // shell:true + args（后者触发 Node DEP0190 警告）。参数均为字面量，无注入面。
  const [command, commandArgs] =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pi", ...args]]
      : ["pi", args];
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: configDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ...extraEnv,
    },
  });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ spawnError: `pi 进程 ${timeoutMs}ms 未结束（已强杀）` });
    }, timeoutMs);
    child.on("error", (error) => finish({ spawnError: error.message }));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function runPi({ configDir, timeoutMs }) {
  const request = `${JSON.stringify({ id: SMOKE_REQUEST_ID, type: "get_commands" })}\n`;
  return spawnPi({ configDir, args: ["--mode", "rpc"], timeoutMs, stdin: request, extraEnv: { PI_OFFLINE: "1" } });
}

/** 删除临时目录；Windows 上偶发 AV/句柄占用的 EPERM 用重试吸收，失败返回 false。 */
function removeDirQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

function removeFileQuietly(file) {
  try {
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 临时目录收尾：成功即删、失败/--keep 保留（便于排查）。无论哪条路都先摘掉
 * auth.json 凭据副本（深任务会拷进去）。清理失败不能弄崩工具，返回警告文案。
 */
async function finishTempDir(configDir, { keep, failed }) {
  if (!keep && !failed) {
    // 子进程退出后 Windows 对新写文件可能短暂占用句柄，先等一拍再删。
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!removeDirQuietly(configDir)) {
      removeFileQuietly(path.join(configDir, "auth.json"));
      return `临时安装目录未能删除（${configDir}）；auth.json 已单独清理，请手动删除该目录`;
    }
    return undefined;
  }
  removeFileQuietly(path.join(configDir, "auth.json"));
  return undefined;
}

/** 运行一次完整的全新安装冒烟；返回结果对象（不打印、不退出）。 */
export async function runInstallSmoke({ repoRoot = REPO_ROOT, keep = false, timeoutMs = 120_000, deep = false } = {}) {
  const manifest = loadManifest(repoRoot);
  const dirs = extensionDirsFromManifest(manifest);
  const drift = findManifestDrift(dirs);
  if (drift.length > 0) return { problems: drift, dirs, commands: [], uiKeys: new Set(), configDir: undefined };
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-smoke-"));
  const extensionsDir = path.join(configDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  try {
    for (const entry of manifest) {
      const dir = entry.replace(/^\.\//, "").split("/")[0];
      copyExtension(path.join(repoRoot, dir), path.join(extensionsDir, dir));
    }
  } catch (error) {
    // 清单指向不存在的目录：清理后按问题返回，不抛裸栈。
    fs.rmSync(configDir, { recursive: true, force: true });
    return { problems: [`复制扩展目录失败：${error instanceof Error ? error.message : String(error)}`], dirs, commands: [], uiKeys: new Set(), configDir: undefined };
  }
  let problems = [];
  let deepResult;
  let parsed;
  let run;
  let cleanupWarning;
  try {
    run = await runPi({ configDir, timeoutMs });
    parsed = parseRpcOutput(run.stdout ?? "", SMOKE_REQUEST_ID);
    problems = checkSmoke({
      exitCode: run.exitCode,
      stderr: run.stderr,
      spawnError: run.spawnError,
      commands: parsed.commands,
      uiKeys: parsed.uiKeys,
      baseDir: configDir,
      dirs,
    });
    if (deep && problems.length === 0) {
      deepResult = await runDeepTask({ configDir, deep });
      problems = deepResult.problems;
    }
  } finally {
    cleanupWarning = await finishTempDir(configDir, { keep, failed: problems.length > 0 });
  }
  return {
    problems,
    dirs,
    commands: parsed?.commands ?? [],
    uiKeys: parsed?.uiKeys ?? new Set(),
    configDir,
    run,
    deep: deepResult,
    cleanupWarning,
  };
}

/**
 * `--install` 冒烟：把 README 推荐的 `pi install` 路径真跑一遍（opt-in，需联网）。
 * 全新临时配置目录里执行 `pi install <源>` → 定位落地产物（findPiPackage）→
 * 复用加载冒烟核对全部命令/启动期 TUI 键；本地路径源不复制不克隆，命令来自
 * 源目录，因此 sourceInfo 白名单同时包含临时目录与包目录。
 */
export async function runPackageInstallSmoke({ source, repoRoot = REPO_ROOT, keep = false, installTimeoutMs = 300_000, timeoutMs = 120_000, deep = false } = {}) {
  const kind = installSourceKind(source);
  if (!kind) {
    return { problems: ['安装源为空：用法 node tools/install-smoke.mjs --install <源>（例 git:github.com/JHzzzzzZ/pi-agent-extensions@dev-laptop）'], source, dirs: [], commands: [], uiKeys: new Set() };
  }
  // 本地路径源统一绝对化：`pi install` 以仓库根为 cwd 执行，加载时 cwd 不同也能解析。
  const installSource = kind === "local" ? path.resolve(repoRoot, source) : source;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-smoke-"));
  let problems = [];
  let installRun;
  let pkg;
  let parsed;
  let deepResult;
  let cleanupWarning;
  try {
    installRun = await spawnPi({ configDir, args: ["install", installSource], timeoutMs: installTimeoutMs, cwd: repoRoot });
    problems = checkInstallRun({ exitCode: installRun.exitCode, stderr: installRun.stderr, spawnError: installRun.spawnError, stdout: installRun.stdout, source: installSource });
    if (problems.length === 0) {
      pkg = findPiPackage(piPackageSearchRoots(installSource, configDir));
      if (!pkg) problems = [`安装源：安装完成但未在安装根下找到带 pi.extensions 的 package.json`];
    }
    if (problems.length === 0) {
      const smoke = await runPi({ configDir, timeoutMs });
      parsed = parseRpcOutput(smoke.stdout ?? "", SMOKE_REQUEST_ID);
      problems = checkSmoke({
        exitCode: smoke.exitCode,
        stderr: smoke.stderr,
        spawnError: smoke.spawnError,
        commands: parsed.commands,
        uiKeys: parsed.uiKeys,
        baseDir: [configDir, pkg.dir],
        dirs: extensionDirsFromManifest(pkg.extensions),
      });
      if (deep && problems.length === 0) {
        deepResult = await runDeepTask({ configDir, deep });
        problems = deepResult.problems;
      }
    }
  } finally {
    cleanupWarning = await finishTempDir(configDir, { keep, failed: problems.length > 0 });
  }
  return {
    problems,
    source: installSource,
    dirs: pkg ? extensionDirsFromManifest(pkg.extensions) : [],
    pkg,
    commands: parsed?.commands ?? [],
    uiKeys: parsed?.uiKeys ?? new Set(),
    configDir,
    installRun,
    deep: deepResult,
    cleanupWarning,
  };
}

/**
 * 深度任务：复用加载冒烟的临时安装目录，复制 auth.json（如存在）后跑一次真实模型调用。
 * 注意 PI_OFFLINE 只用于加载冒烟；深任务必须联网，因此这里不带该变量。
 */
async function runDeepTask({ configDir, deep }) {
  const tool = deep.tool ?? DEEP_DEFAULT_TOOL;
  const authFrom = deep.authFrom ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  let model = deep.model;
  try {
    if (!model) {
      const settings = JSON.parse(fs.readFileSync(path.join(authFrom, "settings.json"), "utf8"));
      model = deepModelFromSettings(settings, undefined);
    }
  } catch {
    // 没有 settings.json / 不可读：交给 pi 用默认模型（多半会失败，错误会体现在事件/退出码里）。
  }
  const authPath = path.join(authFrom, "auth.json");
  let authCopied = false;
  try {
    if (fs.existsSync(authPath)) {
      fs.copyFileSync(authPath, path.join(configDir, "auth.json"));
      authCopied = true;
    }
  } catch {
    // 复制失败：仍可依赖环境变量里的 key，失败时由事件流暴露。
  }
  const run = await spawnPi({
    configDir,
    args: buildDeepArgs({ model, tool }),
    timeoutMs: deep.timeoutMs ?? 180_000,
    // 深任务可能触发扩展派生后台进程（如 Toast 的 PowerShell / bridge helper）；
    // 它们会继承 cwd。cwd 指向系统临时区而不是本次配置目录，避免子进程句柄
    // 把配置目录钉住导致清理 EPERM（配置目录位置仍由 PI_CODING_AGENT_DIR 决定）。
    cwd: os.tmpdir(),
  });
  const events = parseJsonEvents(run.stdout ?? "");
  const problems = checkDeepRun({ exitCode: run.exitCode, stderr: run.stderr, spawnError: run.spawnError, events, tool });
  return { problems, model, tool, authFrom, authCopied, events };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const withTask = process.argv.includes("--task");
  const withInstall = process.argv.includes("--install");
  const valueAfter = (flag) => {
    const index = process.argv.indexOf(flag);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };
  const deep = withTask
    ? { model: valueAfter("--model"), tool: valueAfter("--task-tool"), authFrom: valueAfter("--auth-from") }
    : false;
  const result = withInstall
    ? await runPackageInstallSmoke({ source: valueAfter("--install"), keep, deep })
    : await runInstallSmoke({ keep, deep });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: result.problems.length === 0,
          mode: withInstall ? "install" : "copy",
          source: result.source,
          package: result.pkg ? { name: result.pkg.name, version: result.pkg.version, dir: result.pkg.dir } : undefined,
          extensions: result.dirs,
          commands: result.commands.length,
          uiKeys: [...result.uiKeys],
          problems: result.problems,
          configDir: keep ? result.configDir : undefined,
          cleanupWarning: result.cleanupWarning,
          task: result.deep
            ? {
                tool: result.deep.tool,
                model: result.deep.model,
                authCopied: result.deep.authCopied,
                toolCalls: result.deep.events.filter((event) => event.type === "tool_execution_start").length,
              }
            : undefined,
        },
        null,
        2,
      ),
    );
  } else if (result.problems.length === 0) {
    if (withInstall) {
      const version = result.pkg?.version ? `@${result.pkg.version}` : "";
      console.log(`✓ pi install 冒烟通过：${result.source} → ${result.pkg?.name ?? "(包)"}${version}（${result.dirs.length} 个扩展）在全新配置目录下全部加载`);
    } else {
      console.log(`✓ 全新安装冒烟通过：${result.dirs.length} 个扩展在 ${result.configDir ?? "(temp)"} 下全部加载`);
    }
    console.log(`  · 命令面 ${result.commands.length} 条，全部来自本次安装目录`);
    console.log(`  · 启动期 TUI 键：${[...result.uiKeys].sort().join(", ")}`);
    if (result.deep) {
      console.log(`  · 深任务：模型 ${result.deep.model ?? "(pi 默认)"} 经全新安装的 ${result.deep.tool} 工具执行成功`);
    }
    if (result.cleanupWarning) console.error(`  ! ${result.cleanupWarning}`);
  } else {
    console.error(withInstall ? `✗ pi install 冒烟失败（${result.problems.length} 个问题）：` : `✗ 全新安装冒烟失败（${result.problems.length} 个问题）：`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    if (result.configDir) console.error(`  已保留临时安装目录（排查用）：${result.configDir}`);
  }
  process.exit(result.problems.length === 0 ? 0 : 1);
}
