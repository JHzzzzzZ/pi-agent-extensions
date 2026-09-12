import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDeepInitPrompt,
  buildFinalReport,
  clampDepth,
  createDeepInitExtension,
  DEEP_INIT_COMMAND,
  findExistingAgentsMd,
  parseDeepInitArgs,
  planDispatch,
  resolveCreateGate,
  USAGE,
  DEFAULT_MAX_DEPTH,
  type DeepInitOptions,
  type DirScanner,
  type PromptMeta,
} from "./index.ts";

const META: PromptMeta = { generatedAt: "2026-08-05T12:00:00.000Z", commit: "abc1234", branch: "feat/deep-init" };

function fakeScanner(tree: Record<string, string[] | undefined>): DirScanner {
  return {
    readDir: (dir: string) => tree[dir],
    isDirectory: (path: string) => tree[path] !== undefined,
  };
}

function opts(partial: Partial<DeepInitOptions> = {}): DeepInitOptions {
  return { mode: "update", maxDepth: 3, confirmed: false, target: ".", showHelp: false, ...partial };
}

describe("parseDeepInitArgs — 默认与各开关", () => {
  it("空参数 → update/深度3/目标.", () => {
    const r = parseDeepInitArgs("");
    assert.ok(r.ok);
    assert.deepEqual(r.ok ? r.value : null, { mode: "update", maxDepth: 3, confirmed: false, target: ".", showHelp: false });
  });

  it("--create-new + --yes + 路径", () => {
    const r = parseDeepInitArgs("--create-new --yes ./src");
    assert.ok(r.ok && r.value.mode === "create-new" && r.value.confirmed && r.value.target === "./src");
  });

  it("--max-depth=2 等号形态", () => {
    const r = parseDeepInitArgs("--max-depth=2");
    assert.ok(r.ok && r.value.maxDepth === 2);
  });

  it("--max-depth 2 空格形态", () => {
    const r = parseDeepInitArgs("--max-depth 2 docs");
    assert.ok(r.ok && r.value.maxDepth === 2 && r.value.target === "docs");
  });

  it("--help 与 -h → showHelp", () => {
    assert.ok(parseDeepInitArgs("--help").ok);
    const a = parseDeepInitArgs("--help");
    assert.ok(a.ok && a.value.showHelp);
    const b = parseDeepInitArgs("-h");
    assert.ok(b.ok && b.value.showHelp);
  });

  it("未知 -- 开关被忽略，不影响解析", () => {
    const r = parseDeepInitArgs("--nope");
    assert.ok(r.ok && r.value.mode === "update" && r.value.target === ".");
  });

  it("超长目标路径 → bad-target（静态消息）", () => {
    const r = parseDeepInitArgs(`--create-new ${"a".repeat(300)}`);
    assert.ok(!r.ok && r.code === "bad-target");
    assert.equal(typeof (!r.ok ? r.message : ""), "string");
  });
});

describe("clampDepth — 钳制 1–5", () => {
  it("非法/缺省 → 默认 3", () => {
    assert.equal(clampDepth(undefined), DEFAULT_MAX_DEPTH);
    assert.equal(clampDepth("abc"), DEFAULT_MAX_DEPTH);
    assert.equal(clampDepth(Number.NaN), DEFAULT_MAX_DEPTH);
  });

  it("越界钳制", () => {
    assert.equal(clampDepth(0), 1);
    assert.equal(clampDepth(-2), 1);
    assert.equal(clampDepth(99), 5);
    assert.equal(clampDepth("2"), 2);
    assert.equal(clampDepth(4.9), 4);
  });
});

describe("findExistingAgentsMd — BFS 预检", () => {
  const tree = {
    ".": ["src", "docs", "AGENTS.md", "node_modules", ".git"],
    "./src": ["index.ts", "CLAUDE.md", "sub"],
    "./src/sub": ["AGENTS.md"],
    "./docs": ["guide.md"],
    "./node_modules": ["AGENTS.md"],
    "./.git": ["AGENTS.md"],
  };

  it("找到嵌套的 AGENTS.md/CLAUDE.md，结果排序", () => {
    const found = findExistingAgentsMd(fakeScanner(tree), ".", 3);
    assert.deepEqual(found, ["./AGENTS.md", "./src/CLAUDE.md", "./src/sub/AGENTS.md"]);
  });

  it("跳过 node_modules 与 .git", () => {
    const found = findExistingAgentsMd(fakeScanner(tree), ".", 5);
    assert.ok(!found.some((p) => p.includes("node_modules") || p.includes(".git")));
  });

  it("maxDepth 生效：深度 1 看不到 src/sub", () => {
    const found = findExistingAgentsMd(fakeScanner(tree), ".", 1);
    assert.deepEqual(found, ["./AGENTS.md", "./src/CLAUDE.md"]);
  });

  it("不可读目录 → 空数组，不抛异常", () => {
    assert.deepEqual(findExistingAgentsMd(fakeScanner({}), ".", 3), []);
  });
});

describe("resolveCreateGate — 全量重建确认门", () => {
  it("create-new + 已有文件 + 无 --yes → blocked", () => {
    const r = resolveCreateGate(["./AGENTS.md"], "create-new", false);
    assert.ok(!r.ok && r.code === "confirm-required");
  });

  it("create-new + --yes → 放行", () => {
    assert.deepEqual(resolveCreateGate(["./AGENTS.md"], "create-new", true), { ok: true });
  });

  it("update 模式不受门控影响", () => {
    assert.deepEqual(resolveCreateGate(["./AGENTS.md"], "update", false), { ok: true });
  });

  it("无已有文件时 create-new 直接放行", () => {
    assert.deepEqual(resolveCreateGate([], "create-new", false), { ok: true });
  });
});

describe("buildDeepInitPrompt — 四阶段完整性", () => {
  const prompt = buildDeepInitPrompt({ mode: "update", maxDepth: 3, target: ".", existing: ["./AGENTS.md"], meta: META });

  it("包含四阶段标题与完成报告格式", () => {
    for (const marker of ["阶段 1", "阶段 2", "阶段 3", "阶段 4", "=== init-deep Complete ==="]) {
      assert.ok(prompt.includes(marker), `缺失：${marker}`);
    }
  });

  it("包含评分矩阵关键行与决策规则", () => {
    for (const marker of ["3x", ">15", "8–15", "根目录必建", "edit", "write"]) {
      assert.ok(prompt.includes(marker), `缺失：${marker}`);
    }
  });

  it("回显运行参数与元信息", () => {
    for (const marker of ["update", "3", "abc1234", "feat/deep-init", "2026-08-05"]) {
      assert.ok(prompt.includes(marker), `缺失：${marker}`);
    }
  });

  it("不硬依赖 TodoWrite/LSP 符号工具", () => {
    assert.ok(!prompt.includes("TodoWrite"));
    assert.ok(!prompt.includes("lsp_symbols"));
  });

  it("create-new 模式文案切换", () => {
    const p = buildDeepInitPrompt({ mode: "create-new", maxDepth: 2, target: "docs", existing: [], meta: META });
    assert.ok(p.includes("create-new") && p.includes("未发现"));
  });

  it("已有文件回显 capped 在 20 条", () => {
    const many = Array.from({ length: 25 }, (_, i) => `./d${i}/AGENTS.md`);
    const p = buildDeepInitPrompt({ mode: "update", maxDepth: 3, target: ".", existing: many, meta: META });
    assert.ok(p.includes("./d19/AGENTS.md"));
    assert.ok(!p.includes("./d20/AGENTS.md"));
    assert.ok(p.includes("还有 5 处"));
  });
});

describe("buildFinalReport — 报告格式", () => {
  it("空文件列表仍有骨架", () => {
    const report = buildFinalReport({ mode: "update", files: [], dirsAnalyzed: 7 });
    assert.ok(report.startsWith("=== init-deep Complete ==="));
    assert.ok(report.includes("Mode: update"));
    assert.ok(report.includes("Dirs Analyzed: 7"));
    assert.ok(report.includes("AGENTS.md Created: 0"));
  });

  it("计数与层级树正确", () => {
    const report = buildFinalReport({
      mode: "create-new",
      files: [
        { path: "./AGENTS.md", lines: 120, action: "created" },
        { path: "./src/AGENTS.md", lines: 60, action: "updated" },
      ],
      dirsAnalyzed: 12,
    });
    assert.ok(report.includes("AGENTS.md Created: 1"));
    assert.ok(report.includes("AGENTS.md Updated: 1"));
    assert.ok(report.includes("[OK] ./AGENTS.md (created, 120 lines)"));
    assert.ok(report.includes("└──"));
  });
});

describe("buildDeepInitPrompt — subagent 探索（对齐原版）", () => {
  const prompt = buildDeepInitPrompt({ mode: "update", maxDepth: 3, target: ".", existing: [], meta: META });

  it("要求并行派 subagent，每路只 REPORT 不写文件", () => {
    assert.ok(prompt.includes("并行派探索 subagent"));
    assert.ok(prompt.includes("只 REPORT、不写文件"));
  });

  it("含动态加派规则与规模阈值", () => {
    for (const marker of [">100", ">10k", "depth≥4", ">500 行", "monorepo"]) {
      assert.ok(prompt.includes(marker), `缺失：${marker}`);
    }
  });

  it("收齐合并后才进阶段 2，小仓库可减派", () => {
    assert.ok(prompt.includes("收齐各路 REPORT 再合并"));
    assert.ok(prompt.includes("<100 文件"));
  });

  it("落盘仍单写者：主 agent edit/write 串行", () => {
    assert.ok(prompt.includes("单写者"));
  });
});

describe("planDispatch — 纯决策", () => {
  it("showHelp → help，内容为 USAGE", () => {
    const d = planDispatch(opts({ showHelp: true }), [], META);
    assert.ok(d.kind === "help" && d.message === USAGE);
  });

  it("门控拦截 → blocked", () => {
    const d = planDispatch(opts({ mode: "create-new" }), ["./AGENTS.md"], META);
    assert.ok(d.kind === "blocked");
  });

  it("正常 → dispatch，notice 与 prompt 齐备", () => {
    const d = planDispatch(opts({ target: "docs" }), [], META);
    assert.ok(d.kind === "dispatch");
    if (d.kind === "dispatch") {
      assert.ok(d.notice.includes("增量更新") && d.notice.includes("docs"));
      assert.ok(d.prompt.includes("阶段 1") && d.prompt.includes("=== init-deep Complete ==="));
    }
  });
});

describe("solo 审批门（docs/cross/solo-approval-gate.md）", () => {
  it("planDispatch：soloActive 放行 --create-new 的 confirm-required，notice 标注自动确认", () => {
    const d = planDispatch(opts({ mode: "create-new" }), ["./AGENTS.md"], META, { soloActive: true });
    assert.ok(d.kind === "dispatch");
    if (d.kind === "dispatch") {
      assert.ok(d.notice.includes("全量重建"));
      assert.ok(d.notice.includes("solo 已自动确认"), "notice 标注 solo 自动确认");
    }
  });

  it("planDispatch：soloActive 缺省为 false → 仍拦截", () => {
    const d = planDispatch(opts({ mode: "create-new" }), ["./AGENTS.md"], META, {});
    assert.ok(d.kind === "blocked");
  });

  it("命令接线：solo 激活时 /deep-init --create-new 直接下发提示词", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-init-solo-"));
    const stateFile = path.join(dir, "solo-mode.json");
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, activatedAt: "2026-08-05T12:00:00Z" }), "utf8");
    const previous = process.env.PI_SOLO_MODE_FILE;
    process.env.PI_SOLO_MODE_FILE = stateFile;
    try {
      const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
      const sent: Array<{ message: { customType?: string }; options?: unknown }> = [];
      const notifications: Array<{ message: string; level?: string }> = [];
      const pi = {
        registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          commands.set(name, opts);
        },
        sendMessage: (message: { customType?: string }, options?: unknown) => {
          sent.push({ message, options });
        },
      };
      createDeepInitExtension(pi as never, {
        scanner: fakeScanner({ ".": ["AGENTS.md", "src"], "./src": [] }),
        cwd: ".",
        nowIso: () => "2026-08-05T12:00:00.000Z",
        gitInfo: () => ({ commit: "abc1234", branch: "dev" }),
      });
      const ctx = {
        hasUI: true,
        ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      };

      await commands.get(DEEP_INIT_COMMAND)!.handler("--create-new", ctx);

      assert.equal(sent.length, 1, "solo 下直接下发提示词（不被二次确认拦截）");
      assert.ok(notifications.some((n) => n.message.includes("solo 已自动确认")), "启动通知标注自动确认");
      assert.ok(!notifications.some((n) => n.level === "warning"), "无拦截警告");
    } finally {
      if (previous === undefined) delete process.env.PI_SOLO_MODE_FILE;
      else process.env.PI_SOLO_MODE_FILE = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
