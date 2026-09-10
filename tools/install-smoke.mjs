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
 *   node tools/install-smoke.mjs --keep     # 保留临时安装目录（排查用）
 *   node tools/install-smoke.mjs --json     # 机器可读结果
 *
 * 纯校验逻辑（loadManifest / extensionDirsFromManifest / parseRpcOutput /
 * checkSmoke）导出给 `test/install-smoke.test.ts` 单测；CLI 只在直接执行时跑。
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
 * baseDir 是本次临时安装目录——任何扩展命令的 sourceInfo.path 不在其下，
 * 都说明加载的不是这份拷贝（真实用户配置串入 / 路径拼错）。
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
  const root = baseDir ? path.resolve(baseDir) : undefined;
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
  if (root) {
    for (const command of commands) {
      const sourcePath = command?.sourceInfo?.path;
      if (!sourcePath || sourcePath.startsWith("<")) continue; // 宿主内联扩展（llama.cpp）
      if (!path.resolve(sourcePath).startsWith(root)) {
        problems.push(`命令 /${command.name} 来自 ${sourcePath}，不在本次安装目录 ${root} 内`);
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

const SMOKE_REQUEST_ID = "install-smoke-1";

function runPi({ configDir, timeoutMs }) {
  const request = `${JSON.stringify({ id: SMOKE_REQUEST_ID, type: "get_commands" })}\n`;
  const args = ["--mode", "rpc"];
  // Windows 上 pi 是 .cmd，必须经 cmd.exe 解析；显式拼 ComSpec 而不是
  // shell:true + args（后者触发 Node DEP0190 警告）。参数均为字面量，无注入面。
  const [command, commandArgs] =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pi", ...args]]
      : ["pi", args];
  const child = spawn(command, commandArgs, {
    cwd: configDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: configDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
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
    child.stdin.end(request);
  });
}

/** 运行一次完整的全新安装冒烟；返回结果对象（不打印、不退出）。 */
export async function runInstallSmoke({ repoRoot = REPO_ROOT, keep = false, timeoutMs = 120_000 } = {}) {
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
  try {
    const run = await runPi({ configDir, timeoutMs });
    const parsed = parseRpcOutput(run.stdout ?? "", SMOKE_REQUEST_ID);
    problems = checkSmoke({
      exitCode: run.exitCode,
      stderr: run.stderr,
      spawnError: run.spawnError,
      commands: parsed.commands,
      uiKeys: parsed.uiKeys,
      baseDir: configDir,
      dirs,
    });
    return { problems, dirs, commands: parsed.commands, uiKeys: parsed.uiKeys, configDir, run };
  } finally {
    // 失败时自动保留临时目录（便于排查），成功时清掉；--keep 一律保留。
    const failed = problems.length > 0;
    if (!keep && !failed) fs.rmSync(configDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const result = await runInstallSmoke({ keep });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: result.problems.length === 0,
          extensions: result.dirs,
          commands: result.commands.length,
          uiKeys: [...result.uiKeys],
          problems: result.problems,
          configDir: keep ? result.configDir : undefined,
        },
        null,
        2,
      ),
    );
  } else if (result.problems.length === 0) {
    console.log(`✓ 全新安装冒烟通过：${result.dirs.length} 个扩展在 ${result.configDir ?? "(temp)"} 下全部加载`);
    console.log(`  · 命令面 ${result.commands.length} 条，全部来自本次安装目录`);
    console.log(`  · 启动期 TUI 键：${[...result.uiKeys].sort().join(", ")}`);
  } else {
    console.error(`✗ 全新安装冒烟失败（${result.problems.length} 个问题）：`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    if (result.configDir) console.error(`  已保留临时安装目录（排查用）：${result.configDir}`);
  }
  process.exit(result.problems.length === 0 ? 0 : 1);
}
