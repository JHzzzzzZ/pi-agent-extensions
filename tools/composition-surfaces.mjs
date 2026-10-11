/**
 * tools/composition-surfaces.mjs — 插件接触面清单的解析、校验与配对生成器
 * （general-todo#32 / docs/specs/composition-test-matrix.md）
 *
 * 清单唯一来源是 docs/cross/composition-surfaces.md（逐插件一节 + `键: 值` 行）。
 * 本工具做三件事：
 *   1. --check（默认）完备性与声明有效性：每个扩展目录都必须在清单里出现；
 *      声明的键必须在**该扩展自己的非测试源码**里能找到字面量（正向校验）。
 *   2. --pairs 按接触面生成 L2 配对集合（只对「会产生交互」的维度配对，见 PAIRING）。
 *   3. --json 给测试与脚本消费的机器输出。
 *
 * 设计口径（为什么这样）：
 *   - 只做「声明 → 源码存在」的单向校验。反向自动提取已被实测否掉：正则提不出
 *     `registerTool({ name })` 里的工具名与 `registerVirtualModel` 的注册面，
 *     假阴性会让组合静默漏跑——而漏跑正是本工具要消灭的东西。
 *   - 生命周期钩子（session_start / session_shutdown / session_compact）不参与配对：
 *     人人都有，配对会退化成 O(n²) 且不产生新信息；它们的正确性是「可重入/无残留」，
 *     由 L1 单装与 L2 的卸载重载断言覆盖。
 *   - 配对只覆盖会产生交互的维度：状态键 / widget / 工具名 / 能力频道（提供↔消费）/
 *     拦截型钩子（tool_call、tool_result、input、before_agent_start、model_select）/
 *     模型面 / 命令 / 快捷键。
 *
 * 纯函数（parseSurfaces / validateSurfaces / computePairs / PAIRING）导出给
 * test/composition-surfaces.test.ts；CLI 只在直接执行时跑。
 *
 * 用法：
 *   node tools/composition-surfaces.mjs                 # 校验（exit 0 / 1）
 *   node tools/composition-surfaces.mjs --pairs         # 打印生成的配对
 *   node tools/composition-surfaces.mjs --json          # 机器输出
 *   node tools/composition-surfaces.mjs --root <dir>    # 指定仓库根（默认本文件上一级）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
const SURFACES_REL = "docs/cross/composition-surfaces.md";
const EXTENSIONS_REL = "src/extensions";

/** 清单字段 → 该字段是否参与配对，以及配对时用的维度名。 */
export const PAIRING = {
  status: { pair: true, dim: "status" },
  widget: { pair: true, dim: "widget" },
  tool: { pair: true, dim: "tool", kind: "self" },
  toolSurface: { pair: true, dim: "tool", kind: "target" },
  eventsProvide: { pair: true, dim: "capability", kind: "provide" },
  eventsConsume: { pair: true, dim: "capability", kind: "consume" },
  hooks: { pair: true, dim: "hook", values: ["tool_call", "tool_result", "input", "before_agent_start", "model_select"] },
  model: { pair: true, dim: "model" },
  fileContract: { pair: true, dim: "file-contract" },
  commands: { pair: true, dim: "command" },
  shortcuts: { pair: true, dim: "shortcut" },
  lifecycle: { pair: false },
  bare: { pair: false },
};

/** 清单里出现的合法字段标签 → 内部字段名（`events 提供/消费` 是兼容旧写法的别名）。 */
const FIELD_ALIASES = new Map([
  ["状态键", "status"],
  ["widget", "widget"],
  ["工具", "tool"],
  ["工具面", "toolSurface"],
  ["events 广播", "eventsProvide"],
  ["events 提供", "eventsProvide"],
  ["events 订阅", "eventsConsume"],
  ["events 消费", "eventsConsume"],
  ["宿主钩子", "hooks"],
  ["模型面", "model"],
  ["文件契约", "fileContract"],
  ["命令", "commands"],
  ["快捷键", "shortcuts"],
  ["会话生命周期", "lifecycle"],
  ["独占声明", "exclusive"],
  ["共享槽", "shared"],
  ["模式", "mode"],
  ["无注册面", "bare"],
]);

const EMPTY = new Set(["-", "无", "none", "n/a", ""]);

/** 去掉括号注释（`widget-band（上方排序带，…）` → `widget-band`）后再切分。 */
const stripNotes = (raw) => raw.replace(/[（(][^）)]*[）)]/g, "");

const splitValues = (raw) =>
  stripNotes(raw)
    .split(/[，,、]/)
    .map((v) => v.trim())
    .filter((v) => !EMPTY.has(v.toLowerCase()));

/** 解析清单 markdown → Map<扩展名, { source, fields: Map<字段, string[]>, line }>。 */
export function parseSurfaces(markdown) {
  const surfaces = new Map();
  let current = null;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const heading = /^###\s+([A-Za-z0-9._-]+)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1], fields: new Map(), line: index + 1 };
      surfaces.set(current.name, current);
      return;
    }
    if (/^##\s/.test(line)) {
      current = null;
      return;
    }
    if (!current) return;
    // 支持 `键: 值`；值里允许反引号包裹（写作 `pwr:run` 也认）
    const field = /^[-*]?\s*([^:：#]+?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (!field) return;
    const key = FIELD_ALIASES.get(field[1].trim());
    if (!key) return;
    const raw = field[2].replace(/`/g, "").trim();
    current.fields.set(key, EMPTY.has(raw.toLowerCase()) ? [] : splitValues(raw));
  });
  return surfaces;
}

/** 列出 src/extensions 下所有扩展目录（含 index.ts 的才算扩展）。 */
export function listExtensions(repoRoot) {
  const dir = path.join(repoRoot, EXTENSIONS_REL);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(dir, name, "index.ts")))
    .sort();
}

/** 读取某扩展的非测试源码文本（用于声明有效性校验）。 */
export function readExtensionSource(repoRoot, ext) {
  const root = path.join(repoRoot, EXTENSIONS_REL, ext);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "vendor", "dist", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
        out.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return out.join("\n");
}

/** 每个字段声明值在源码里应该出现的字面量（用于正向校验）。 */
function literalsFor(field, value) {
  if (field === "toolSurface" || field === "exclusive" || field === "shared") {
    return [value.replace(/^(replace|wrap)\s*[:：]\s*/, "").trim()];
  }
  if (field === "shortcuts") return []; // 快捷键名可能来自宿主常量，不做字面量校验
  if (field === "mode") return []; // 模式名不要求出现在源码里（环境变量值）
  if (field === "bare" || field === "lifecycle") return [];
  return [value];
}

/**
 * 校验清单。返回 { problems: string[], surfaces, extensions }。
 * problems 为空即通过。
 */
export function validateSurfaces({ repoRoot = REPO_ROOT, markdown } = {}) {
  const source = markdown ?? fs.readFileSync(path.join(repoRoot, SURFACES_REL), "utf8");
  const surfaces = parseSurfaces(source);
  const extensions = listExtensions(repoRoot);
  const problems = [];

  for (const ext of extensions) {
    if (!surfaces.has(ext)) {
      problems.push(`扩展 \`${ext}\` 未在 ${SURFACES_REL} 声明接触面：新增插件必须补一节（无注册面写「无注册面: true」）`);
    }
  }
  for (const name of surfaces.keys()) {
    if (!extensions.includes(name)) {
      problems.push(`清单里的 \`${name}\` 不是 src/extensions 下的扩展目录（拼写错误或已删除？）`);
    }
  }
  for (const surface of surfaces.values()) {
    if (surface.fields.size === 0) {
      problems.push(`${surface.name}（第 ${surface.line} 行）没有任何可识别字段：至少要写「无注册面」或「状态键」等一行`);
      continue;
    }
    if (!extensions.includes(surface.name)) continue;
    const text = readExtensionSource(repoRoot, surface.name);
    for (const [field, values] of surface.fields) {
      for (const value of values) {
        for (const literal of literalsFor(field, value)) {
          if (!text.includes(literal)) {
            problems.push(`${surface.name}: 声明 \`${field}: ${value}\`，但源码里找不到字面量 "${literal}"（声明与实现分叉）`);
          }
        }
      }
    }
  }
  return { problems, surfaces, extensions };
}

const valuesOf = (surface, field) => surface.fields.get(field) ?? [];

/** 配对用的取值：工具面去掉 replace:/wrap: 前缀后与同名工具归入同一维度。 */
const pairingValues = (surface, field, rule) =>
  valuesOf(surface, field)
    .filter((v) => !rule.values || rule.values.includes(v))
    .map((v) => (field === "toolSurface" ? v.replace(/^(replace|wrap)\s*[:：]\s*/, "").trim() : v));

/** 某扩展在各配对维度上的取值集合（工具面已按 replace:/wrap: 归一）。 */export function pairingDimensions(surface) {
  const dims = new Map();
  for (const [field, rule] of Object.entries(PAIRING)) {
    if (!rule.pair || field === "eventsProvide" || field === "eventsConsume") continue;
    for (const value of pairingValues(surface, field, rule)) {
      if (!dims.has(rule.dim)) dims.set(rule.dim, new Set());
      dims.get(rule.dim).add(value);
    }
  }
  return dims;
}

/** 生成 L2 配对集合：[{ pair: [a, b], reasons: [{ dim, value }] }]（a < b 字典序）。 */
export function computePairs(surfaces) {
  const names = [...surfaces.keys()].sort();
  const dims = new Map(names.map((name) => [name, pairingDimensions(surfaces.get(name))]));
  const pairs = new Map();
  const add = (left, right, reason) => {
    const [a, b] = [left, right].sort();
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, { pair: [a, b], reasons: [] });
    const entry = pairs.get(key);
    if (!entry.reasons.some((r) => r.dim === reason.dim && r.value === reason.value)) {
      entry.reasons.push(reason);
    }
  };

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = surfaces.get(names[i]);
      const b = surfaces.get(names[j]);
      const dimsA = dims.get(a.name);
      const dimsB = dims.get(b.name);
      for (const [dim, valuesA] of dimsA) {
        for (const value of valuesA) {
          if (dimsB.get(dim)?.has(value)) add(a.name, b.name, { dim, value });
        }
      }
      // 能力频道：A 提供、B 消费（或反向）
      for (const provided of valuesOf(a, "eventsProvide")) {
        if (valuesOf(b, "eventsConsume").includes(provided)) add(a.name, b.name, { dim: "capability", value: provided });
      }
      for (const provided of valuesOf(b, "eventsProvide")) {
        if (valuesOf(a, "eventsConsume").includes(provided)) add(a.name, b.name, { dim: "capability", value: provided });
      }
    }
  }
  return [...pairs.values()].sort((x, y) => x.pair[0].localeCompare(y.pair[0]) || x.pair[1].localeCompare(y.pair[1]));
}

/**
 * 冲突仲裁（L2 口径，D6）：两个插件在任一维度共享同一取值时，**双方都必须把它列进
 * `独占声明` 或 `共享槽`**——否则就是「未声明的真冲突」，L2 必须报错。
 * 返回 problems 列表（空即全部已裁决）。
 */
export function checkArbitration({ surfaces, pairs = null }) {
  const target = pairs ?? computePairs(surfaces);
  const problems = [];
  for (const { pair: [a, b], reasons } of target) {
    const surfaceA = surfaces.get(a);
    const surfaceB = surfaces.get(b);
    if (!surfaceA || !surfaceB) continue;
    const claimed = (surface) =>
      new Set(
        [...valuesOf(surface, "exclusive"), ...valuesOf(surface, "shared")].map((value) =>
          value.replace(/^(replace|wrap)\s*[:：]\s*/, "").trim(),
        ),
      );
    const claimsA = claimed(surfaceA);
    const claimsB = claimed(surfaceB);
    for (const { dim, value } of reasons) {
      if (dim === "capability") continue; // 能力频道本来就是「双方各持一半」，频道名即契约
      const missing = [];
      if (!claimsA.has(value)) missing.push(a);
      if (!claimsB.has(value)) missing.push(b);
      if (missing.length > 0) {
        problems.push(`${a} × ${b} 在 \`${dim}:${value}\` 上共享同一槽，但 ${missing.join("、")} 未在「独占声明 / 共享槽」里声明（未声明的真冲突）`);
      }
    }
  }
  return problems;
}

const USAGE = `用法（仓库根）：node tools/composition-surfaces.mjs [选项]

  --check          校验清单完备性与声明有效性（默认；exit 0 通过 / 1 失败）
  --pairs          打印按接触面生成的 L2 配对集合
  --json           机器输出（校验结果 + 配对）
  --root <dir>     指定仓库根（默认本文件上一级）
  --help           本说明
`;

/** CLI 主体：返回退出码（0 通过 / 1 校验失败 / 2 用法错误）。 */
export function runCli(argv, { log = console.log, repoRoot = REPO_ROOT } = {}) {
  const args = argv.slice(2);
  let mode = "check";
  let root = repoRoot;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help") {
      log(USAGE.trimEnd());
      return 0;
    }
    if (arg === "--check" || arg === "--pairs" || arg === "--json") {
      mode = arg.slice(2);
      continue;
    }
    if (arg === "--root") {
      root = path.resolve(args[i + 1] ?? "");
      i += 1;
      continue;
    }
    log(`未知参数: ${arg}\n${USAGE}`);
    return 2;
  }

  let result;
  try {
    result = validateSurfaces({ repoRoot: root });
  } catch (error) {
    log(`读取清单失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const pairs = computePairs(result.surfaces);
  const arbitrationProblems = checkArbitration({ surfaces: result.surfaces, pairs });
  const problems = [...result.problems, ...arbitrationProblems];

  if (mode === "json") {
    log(JSON.stringify({ ok: problems.length === 0, problems, pairs, surfaces: [...result.surfaces.keys()] }, null, 1));
    return problems.length === 0 ? 0 : 1;
  }
  if (mode === "pairs") {
    for (const { pair: [a, b], reasons } of pairs) {
      log(`${a} × ${b}  ← ${reasons.map((r) => `${r.dim}:${r.value}`).join(", ")}`);
    }
    log(`共 ${pairs.length} 对（覆盖 ${result.extensions.length} 个扩展），仲裁问题 ${arbitrationProblems.length} 条`);
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0) {
    log(`接触面清单校验失败（${problems.length} 条）：`);
    for (const problem of problems) log(`- ${problem}`);
    return 1;
  }
  log(`接触面清单校验通过：${result.extensions.length} 个扩展全部声明，配对 ${pairs.length} 对且均已裁决`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli(process.argv);
}
