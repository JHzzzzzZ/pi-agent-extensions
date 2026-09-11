/**
 * Below-editor run widget tests: data-driven registration (live run ⇒
 * frame, settled ⇒ setWidget(undefined)), the `main → leader → 成员 → 任务`
 * tree projection, the modal key reducer (activate/move/confirm/escape/
 * passthrough), the focus probe, and the renderKey skip. Pure functions +
 * a host-agnostic controller with fake ports; the pi-tui host component
 * itself is never instantiated here (widget-focus-host.test.ts covers the
 * real host path).
 */

import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  RunWidgetController,
  WIDGET_MAX_LINES,
  buildWidgetView,
  handleWidgetKey,
  initialWidgetKeyState,
  isEditorComponentLike,
  probeEditorFocus,
  renderWidgetView,
  type WidgetRowSpec,
} from "../widget.ts";
import type { RunStatusSnapshot } from "../cockpit.ts";
import { plainStyles, visibleWidth } from "../viewer.ts";

const ACTIVATE_CSI = "\x1b[1;3B"; // alt+down, modified-arrow CSI encoding
const ACTIVATE_LEGACY = "\x1b\x1b[B"; // alt+down, legacy xterm ESC-prefix encoding
const ACTIVATE_UP_CSI = "\x1b[1;3A"; // alt+up
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";

function liveSnapshot(): RunStatusSnapshot {
  return {
    running: true,
    progress: {
      runId: "r",
      team: "dev-team",
      task: "修复登录 bug",
      startedAtMs: 0,
      leaderModel: "m1",
      leaderNote: "turn 2",
      leaderActivity: "正在审查成员结果",
      members: [
        { name: "frontend", status: "running", note: "turn 1", latest: "正在编辑 login.tsx" },
        { name: "backend", status: "done" },
      ],
    },
    lastRecord: null,
  };
}

function doneSnapshot(): RunStatusSnapshot {
  return {
    running: false,
    progress: null,
    lastRecord: {
      runId: "run-1",
      team: "dev-team",
      task: "修复 bug",
      startedAt: "2026-09-05T12:00:00Z",
      status: "completed",
      report: "done",
      members: [
        { name: "frontend", model: "m", status: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } },
      ],
      totalCost: 0.05,
      totalTokens: 100,
      durationMs: 12000,
    },
  };
}

/** Main/leader/members tree rows for liveSnapshot at 1m5s（任务摘要并入 leader 行，无独立任务行）。 */
const LIVE_ROWS: WidgetRowSpec[] = [
  { text: "main", actor: "_leader", kind: "root" },
  { text: "leader dev-team · 修复登录 bug ▶ running · 1m5s · 1/2 并行", actor: "_leader", kind: "leader" },
  { text: "├─ frontend ● running · turn 1", actor: "frontend", kind: "member" },
  { text: "╰─ backend ✓ done", actor: "backend", kind: "member" },
];

// ---------------------------------------------------------------------------
// Tree projection (pure)
// ---------------------------------------------------------------------------

test("buildWidgetView live: collapsed one-liner + main→leader→成员 tree（任务摘要进 leader 行，无独立任务行）", () => {
  const view = buildWidgetView(liveSnapshot(), 65000);
  assert.equal(view.collapsed, "agent-team dev-team · ↓/← 查看详情", "running 折叠行：团队 + 激活提示");
  assert.deepEqual(view.rows, LIVE_ROWS, "树行序：main → leader（含任务摘要）→ 成员");
  assert.equal(view.rows.at(-1)?.kind, "member", "末行是成员行（无任务行陷阱：光标到底即成员）");
});

test("buildWidgetView member rows: 五种状态图标 queued · / running ● / done ✓ / failed ✗ / aborted ⊘", () => {
  const snapshot = liveSnapshot();
  snapshot.progress!.members = [
    { name: "a", status: "queued" },
    { name: "b", status: "running" },
    { name: "c", status: "done" },
    { name: "d", status: "failed" },
    { name: "e", status: "aborted" },
  ];
  const view = buildWidgetView(snapshot, 0);
  assert.deepEqual(
    view.rows.slice(2, 7).map((row) => row.text),
    ["├─ a · queued", "├─ b ● running", "├─ c ✓ done", "├─ d ✗ failed", "╰─ e ⊘ aborted"],
  );
  assert.deepEqual(
    view.rows.slice(2, 7).map((row) => row.actor),
    ["a", "b", "c", "d", "e"],
    "成员行 actor = sanitizeActorName(成员名)",
  );
  assert.ok(view.rows.slice(2, 7).every((row) => row.kind === "member"));
});

test("buildWidgetView 成员连接符：非末项 ├─、末项 ╰─（圆角，非方角 └─）；前缀 3 列与旧 |- 等宽", () => {
  const two = buildWidgetView(liveSnapshot(), 65000);
  assert.equal(two.rows[2].text, "├─ frontend ● running · turn 1", "非末项成员用 ├─（box-drawing）");
  assert.equal(two.rows[3].text, "╰─ backend ✓ done", "末项成员用圆角 ╰─");
  assert.ok(
    !two.rows.some((row) => row.text.includes("└─")),
    "本仓库取圆角 ╰─（上游 fleet-status 用方角 └─，差异登记 tui-sync §3）",
  );

  const single = liveSnapshot();
  single.progress!.members = [{ name: "solo", status: "running" }];
  assert.equal(buildWidgetView(single, 65000).rows[2].text, "╰─ solo ● running", "单一成员即末项 → ╰─");

  for (const prefix of ["├─ ", "╰─ "]) {
    assert.equal(
      visibleWidth(prefix),
      3,
      `连接符前缀 ${JSON.stringify(prefix)} 显示宽度 = 3（与旧 |- 等宽，truncateVisible 预算不变）`,
    );
  }
});

test("buildWidgetView member tail: note 优先、否则 latest；压平换行且 ≤30 字符", () => {
  const snapshot = liveSnapshot();
  snapshot.progress!.members = [
    { name: "frontend", status: "running", note: "turn 1", latest: "正在编辑 login.tsx" },
    { name: "backend", status: "failed", latest: "第一行\n第二行   第三行" },
    { name: "long", status: "running", latest: `${"x".repeat(40)}\n${"y".repeat(10)}` },
    { name: "blank", status: "running", note: "   \n  " },
  ];
  const rows = buildWidgetView(snapshot, 0).rows;
  assert.equal(rows[2].text, "├─ frontend ● running · turn 1", "note 优先于 latest");
  assert.equal(rows[3].text, "├─ backend ✗ failed · 第一行 第二行 第三行", "换行压平");
  const longTail = rows[4].text.replace(/^├─ long ● running · /, "");
  assert.ok(longTail.length <= 30, `尾部 ≤30 字符，实得 ${longTail.length}`);
  assert.match(longTail, /…$/, "超长尾部截断加省略号");
  assert.equal(rows[5].text, "╰─ blank ● running", "空白尾注不加 · 段（末项圆角连接符）");
  for (const row of rows) assert.doesNotMatch(row.text, /\n/, "任何 row 文本不得含换行（宿主要把残行渲染成额外行）");
});

test("buildWidgetView leader row: 团队 + 任务摘要 + elapsed + running/total；配了费用上限且未超限才显示 剩 $X.XX", () => {
  const base = liveSnapshot();
  const budget = {
    maxDispatchCalls: 12,
    maxMemberRuns: 40,
    maxCostUsd: 5,
    maxTotalTokens: null,
    spentCost: 0.42,
    spentTokens: 113,
    dispatchCalls: 1,
    memberRuns: 2,
  };
  base.progress!.budget = budget;
  assert.equal(
    buildWidgetView(base, 65000).rows[1].text,
    "leader dev-team · 修复登录 bug ▶ running · 1m5s · 1/2 并行 · 剩 $4.58",
  );

  // No cap → no hint.
  const uncapped = liveSnapshot();
  uncapped.progress!.budget = { ...budget, maxCostUsd: null };
  assert.doesNotMatch(buildWidgetView(uncapped, 65000).rows[1].text, /剩 \$/);

  // Cap already breached → no hint (the run aborts anyway).
  const breached = liveSnapshot();
  breached.progress!.budget = { ...budget, spentCost: 5.2 };
  assert.doesNotMatch(buildWidgetView(breached, 65000).rows[1].text, /剩 \$/);

  // 空任务：任务摘要段整体省略（不留双分隔符/悬空空格）。
  const noTask = liveSnapshot();
  noTask.progress!.task = "   ";
  assert.equal(buildWidgetView(noTask, 65000).rows[1].text, "leader dev-team ▶ running · 1m5s · 1/2 并行");
});

test("buildWidgetView 终态（running=false）：空投影（终态亮块自动卸载，行数据不进 widget）", () => {
  assert.deepEqual(buildWidgetView(doneSnapshot(), 0), { collapsed: "", rows: [] });
  assert.deepEqual(buildWidgetView({ running: false, progress: null, lastRecord: null }, 0), {
    collapsed: "",
    rows: [],
  });
});

test("buildWidgetView running 但 progress 为空：防御性空投影", () => {
  assert.deepEqual(buildWidgetView({ running: true, progress: null, lastRecord: null }, 0), {
    collapsed: "",
    rows: [],
  });
});

test("buildWidgetView leader 行任务摘要：压平换行 + 44 字符截断 + 折叠行压平（截图实读回归）", () => {
  const snapshot = liveSnapshot();
  snapshot.progress!.task = "目标: 输出小写单词 hello。\n特别注意：这是对 count-duet 的一次复用任务";
  const view = buildWidgetView(snapshot, 65000);
  assert.equal(view.rows[1].text, "leader dev-team · 目标: 输出小写单词 hello。 特别注意：这是对 count-duet 的一次复用任… ▶ running · 1m5s · 1/2 并行");

  const long = liveSnapshot();
  long.progress!.task = `${"a".repeat(30)}\n${"b".repeat(30)}   ${"c".repeat(10)}`;
  const leader = buildWidgetView(long, 65000).rows[1].text;
  const task = leader.slice("leader dev-team · ".length, leader.indexOf(" ▶ running"));
  assert.ok(task.length <= 45, `bounded task summary, got ${task.length}`);
  assert.match(task, /…$/);
  assert.doesNotMatch(task, /\s$/);

  // 折叠单行来自团队名，同样必须压平（多行团队名不把一行变多行）。
  const multilineTeam = liveSnapshot();
  multilineTeam.progress!.team = "count\nduet";
  const collapsed = buildWidgetView(multilineTeam, 65000).collapsed;
  assert.equal(collapsed, "agent-team count duet · ↓/← 查看详情");
  assert.doesNotMatch(collapsed, /\n/);
});

// ---------------------------------------------------------------------------
// Key reducer (pure)
// ---------------------------------------------------------------------------

const rows = LIVE_ROWS;

test("key reducer: activation consumes alt+down/up in both encodings; bare keys pass through", () => {
  const state = initialWidgetKeyState();

  // 未选中 + 编辑器非空（canActivate=false）时，所有裸编辑器键原样放行。
  assert.equal(handleWidgetKey(state, KEY_DOWN, rows, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_LEFT, rows, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_UP, rows, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ENTER, rows, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ESC, rows, false).type, "none");
  assert.equal(handleWidgetKey(state, "x", rows, false).type, "none");
  assert.equal(handleWidgetKey(state, "\x03", rows, false).type, "none", "ctrl+c passes through");

  // No rows: nothing to select even when activation is allowed.
  assert.equal(handleWidgetKey(state, ACTIVATE_CSI, [], true).type, "none");

  // Both encodings activate (consume) with the cursor kept where it was.
  const csi = handleWidgetKey(state, ACTIVATE_CSI, rows, false);
  assert.ok(csi.type === "update" && csi.state.selected && csi.state.cursor === 0);
  const legacy = handleWidgetKey(state, ACTIVATE_LEGACY, rows, false);
  assert.ok(legacy.type === "update" && legacy.state.selected);
  const altUp = handleWidgetKey(state, ACTIVATE_UP_CSI, rows, false);
  assert.ok(altUp.type === "update" && altUp.state.selected);
});

test("key reducer 激活门控：空编辑器（canActivate=true）才允许 ↓/← 激活（对齐 fleet-status getEditorText）", () => {
  // 规格表 §4：激活键 down/left，且编辑器文本为空才激活（fleet-status.ts:606-607）。
  // 编辑器有文本（canActivate=false）：↓/← 不拦截，放行编辑器。
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, rows, false).type, "none");
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_LEFT, rows, false).type, "none");

  // 编辑器为空（canActivate=true）：↓/← 进入选中。
  const down = handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, rows, true);
  assert.ok(down.type === "update" && down.state.selected && down.state.cursor === 0);
  const left = handleWidgetKey(initialWidgetKeyState(), KEY_LEFT, rows, true);
  assert.ok(left.type === "update" && left.state.selected);

  // 无行时即便允许激活也不进入选中。
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, [], true).type, "none");
});

test("key reducer 激活门控：alt+↓/↑ 为不受门控的第二通道", () => {
  // 差异表 §3.3：alt 通道是 agent-team 特有语义（模态选中风格），无论编辑器
  // 是否有文本都可进入选中。
  for (const activate of [ACTIVATE_CSI, ACTIVATE_LEGACY, ACTIVATE_UP_CSI]) {
    for (const canActivate of [false, true]) {
      const r = handleWidgetKey(initialWidgetKeyState(), activate, rows, canActivate);
      assert.ok(
        r.type === "update" && r.state.selected,
        `alt 通道（${JSON.stringify(activate)}）在 canActivate=${canActivate} 下应激活`,
      );
    }
  }
});

test("key reducer selected: arrows move and clamp；enter 返回命中行（含 kind 与 actor）", () => {
  let state = { selected: true, cursor: 0 };

  const moved = handleWidgetKey(state, KEY_DOWN, rows);
  assert.ok(moved.type === "update" && moved.state.cursor === 1 && moved.state.selected);
  state = moved.type === "update" ? moved.state : state;

  state = { selected: true, cursor: 2 };
  const confirm = handleWidgetKey(state, KEY_ENTER, rows);
  assert.ok(confirm.type === "confirm");
  assert.ok(confirm.type === "confirm" && confirm.row.text === "├─ frontend ● running · turn 1");
  assert.ok(confirm.type === "confirm" && confirm.row.actor === "frontend");
  assert.ok(confirm.type === "confirm" && confirm.row.kind === "member");
  assert.ok(confirm.state.selected === false, "confirm leaves selection mode");

  // 根部 main 行同样返回命中行（kind=root；宿主把它映射为仅收起选中）。
  const root = handleWidgetKey({ selected: true, cursor: 0 }, KEY_ENTER, rows);
  assert.ok(root.type === "confirm" && root.row.kind === "root" && root.row.text === "main");

  // 底部钳位保留（末行 = 成员行；无任务行陷阱）；到顶（cursor 0）再按 up 退出选中（fleet-status 同构，见下）。
  const last = rows.length - 1;
  const bottom = handleWidgetKey({ selected: true, cursor: last }, KEY_DOWN, rows);
  assert.ok(bottom.type === "update" && bottom.state.cursor === last && bottom.state.selected);
});

test("key reducer selected: cursor 0 再按 up/k 退出选中放行编辑器（fleet-status 同构）", () => {
  // fleet-status.ts:620-625：选中第 0 行再按 up → deactivate（退出选中，
  // 后续键到达编辑器）；退出时保持 cursor 供再次激活恢复。
  for (const key of [KEY_UP, "k"]) {
    const exited = handleWidgetKey({ selected: true, cursor: 0 }, key, rows);
    assert.ok(exited.type === "update");
    assert.ok(exited.type === "update" && exited.state.selected === false && exited.state.cursor === 0);
  }
});

test("key reducer selected: esc deselects, other keys deselect and pass through", () => {
  const selected = { selected: true, cursor: 1 };

  const esc = handleWidgetKey(selected, KEY_ESC, rows);
  assert.ok(esc.type === "update" && esc.state.selected === false && esc.state.cursor === 1);

  const other = handleWidgetKey(selected, "x", rows);
  assert.ok(other.type === "passthrough" && other.state.selected === false);

  const ctrlC = handleWidgetKey(selected, "\x03", rows);
  assert.ok(ctrlC.type === "passthrough" && ctrlC.state.selected === false);
});

test("key reducer: re-activation keeps the previous cursor position", () => {
  const deselected = handleWidgetKey({ selected: true, cursor: 2 }, KEY_ESC, rows);
  assert.ok(deselected.type === "update");
  const state = deselected.type === "update" ? deselected.state : initialWidgetKeyState();
  const reactivated = handleWidgetKey(state, ACTIVATE_CSI, rows);
  assert.ok(reactivated.type === "update" && reactivated.state.selected && reactivated.state.cursor === 2);
});

test("key reducer: enter 而行为空（run 恰落定）→ 收起选中并放行该键", () => {
  const result = handleWidgetKey({ selected: true, cursor: 0 }, KEY_ENTER, []);
  assert.ok(result.type === "passthrough" && result.state.selected === false);
});

// Kitty 键盘协议 flag 2（report event types）下每次按键额外发送 release 事件
// （`:3` 编码，如 ↓ press `\x1b[1;1B` / release `\x1b[1;1:3B`）。release 同样
// 能被 matchesKey 命中——不过滤会让一次按键生效两次（用户 2026-09-15 真机
// 反馈；fleet-status.ts:699 同款 `isKeyRelease` 过滤）。
test("key reducer: Kitty release 事件一律忽略（一次按键不得生效两次）", () => {
  const RELEASE_DOWN = "\x1b[1;1:3B";
  const RELEASE_UP = "\x1b[1;1:3A";
  const RELEASE_LEFT = "\x1b[1;1:3D";
  const RELEASE_ENTER = "\x1b[13;1:3u";

  // 未选中：release ↓/← 不得激活（编辑器空/非空都不行）。
  for (const canActivate of [true, false]) {
    assert.equal(handleWidgetKey(initialWidgetKeyState(), RELEASE_DOWN, rows, canActivate).type, "none");
    assert.equal(handleWidgetKey(initialWidgetKeyState(), RELEASE_LEFT, rows, canActivate).type, "none");
  }
  // 选中态：release 不移动、不 confirm、不退出。
  const selected = { selected: true, cursor: 1 };
  assert.equal(handleWidgetKey(selected, RELEASE_DOWN, rows).type, "none");
  assert.equal(handleWidgetKey(selected, RELEASE_UP, rows).type, "none");
  assert.equal(handleWidgetKey(selected, RELEASE_ENTER, rows).type, "none");
});

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

test("renderWidgetView collapsed: exactly one line with the activation hint and no tree rows", () => {
  const view = buildWidgetView(liveSnapshot(), 65000);
  const lines = renderWidgetView(view, { selected: false, cursor: 0 }, 80, plainStyles());
  assert.equal(lines.length, 1, "折叠默认态恰好 1 行");
  assert.equal(lines[0], "agent-team dev-team · ↓/← 查看详情");
  assert.doesNotMatch(lines[0], /任务:/);
});

test("renderWidgetView expanded: main/leader（含任务摘要）/成员 rows + bottom hint, gutter on the cursor row", () => {
  const view = buildWidgetView(liveSnapshot(), 65000);
  const lines = renderWidgetView(view, { selected: true, cursor: 1 }, 80, plainStyles());
  assert.equal(lines.length, view.rows.length + 1, "展开 = rows + 底部提示行");
  assert.match(lines[0], /^ {2}main$/);
  assert.match(lines[1], /^▸ leader dev-team · 修复登录 bug ▶ running/);
  assert.match(lines[2], /^ {2}├─ frontend ● running/);
  assert.match(lines[3], /^ {2}╰─ backend ✓ done$/);
  assert.match(lines[lines.length - 1], /↑↓ 选择 · enter 查看 · esc 退出/);
  assert.ok(
    !lines.some((line) => /上方还有|下方还有/.test(line)),
    "窗口未溢出（小团队全部行可见）时不得出现折叠提示行",
  );
});

/** 大团队快照：2 根行 + count 个成员行。 */
function largeTeamSnapshot(count: number): RunStatusSnapshot {
  const snapshot = liveSnapshot();
  snapshot.progress!.members = Array.from({ length: count }, (_, index) => ({
    name: `member-${index}`,
    status: "running" as const,
    latest: `任务片段 ${index}`,
  }));
  return snapshot;
}

test("renderWidgetView 大团队窗口化：帧 ≤ 宿主 10 行上限、选中行与提示行恒在帧内", () => {
  // 宿主 setExtensionWidget 对 string[] 硬截 MAX_WIDGET_LINES = 10 并追加
  // "... (widget truncated)"：本插件自产帧超限时尾部提示行会被吃掉、光标可能落在
  // 不可见行（第六轮读宿主源码发现的候选问题）。窗口化后此不变量由本测试钉住。
  const view = buildWidgetView(largeTeamSnapshot(12), 65000);
  assert.equal(view.rows.length, 14, "2 根行 + 12 成员行");
  const styles = plainStyles();
  for (let cursor = 0; cursor < view.rows.length; cursor++) {
    const lines = renderWidgetView(view, { selected: true, cursor }, 80, styles);
    assert.ok(
      lines.length <= WIDGET_MAX_LINES,
      `cursor=${cursor}: 帧 ${lines.length} 行超过宿主上限 ${WIDGET_MAX_LINES}`,
    );
    const marked = lines.filter((line) => line.startsWith("▸ "));
    assert.equal(marked.length, 1, `cursor=${cursor}: 恰好一个行光标`);
    assert.ok(
      marked[0]!.includes(view.rows[cursor]!.text),
      `cursor=${cursor}: 光标行必须是选中行（${view.rows[cursor]!.text}）`,
    );
    assert.match(lines[lines.length - 1]!, /↑↓ 选择 · enter 查看 · esc 退出/, `cursor=${cursor}: 提示行固定在帧内`);
  }
});

test("renderWidgetView 大团队折叠提示：首行只提示下方、末行只提示上方、中段两侧都提示", () => {
  const view = buildWidgetView(largeTeamSnapshot(12), 65000);
  const styles = plainStyles();
  const top = renderWidgetView(view, { selected: true, cursor: 0 }, 80, styles);
  assert.ok(top.some((line) => /下方还有 6 行/.test(line)), "光标在首行：只提示下方隐藏行");
  assert.ok(!top.some((line) => /上方还有/.test(line)), "首行窗口上侧无隐藏行");
  const bottom = renderWidgetView(view, { selected: true, cursor: view.rows.length - 1 }, 80, styles);
  assert.ok(bottom.some((line) => /上方还有 6 行/.test(line)), "光标在末行：只提示上方隐藏行");
  assert.ok(!bottom.some((line) => /下方还有/.test(line)), "末行窗口下侧无隐藏行");

  const both = Array.from({ length: view.rows.length }, (_, cursor) =>
    renderWidgetView(view, { selected: true, cursor }, 80, styles),
  ).find((lines) => lines.some((line) => /上方还有/.test(line)) && lines.some((line) => /下方还有/.test(line)));
  assert.ok(both, "中段光标：窗口两侧都有隐藏行时应同时给出两条折叠提示");
});

test("WIDGET_MAX_LINES 与真实宿主 string[] widget 上限一致（宿主漂移即红）", async () => {
  const hostSource = await readFile(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
      import.meta.url,
    ),
    "utf8",
  );
  const match = /MAX_WIDGET_LINES\s*=\s*(\d+)/.exec(hostSource);
  assert.ok(match, "宿主源码应含 MAX_WIDGET_LINES 常量（宿主布局变化时本测试需更新）");
  assert.equal(
    WIDGET_MAX_LINES,
    Number(match[1]),
    "本插件窗口上限必须等于宿主 string[] widget 截断上限",
  );
});

test("renderWidgetView empty view: no lines in either mode", () => {
  const empty = buildWidgetView({ running: false, progress: null, lastRecord: null }, 0);
  assert.deepEqual(renderWidgetView(empty, { selected: false, cursor: 0 }, 80, plainStyles()), []);
  assert.deepEqual(renderWidgetView(empty, { selected: true, cursor: 0 }, 80, plainStyles()), []);
});

test("renderWidgetView truncates every line to terminal width (collapsed + expanded, CJK-heavy rows)", () => {
  // Regression: the host TUI crashes when a component line renders wider
  // than the terminal; rows are bounded by char count only, so CJK-heavy
  // text (44-char task = up to 88 columns) must be width-fitted here.
  const snapshot = liveSnapshot();
  snapshot.progress!.task = "实现一个摄影教学网页产出完整的页面结构与文案与样式与脚本内容超长截断示例";
  const view = buildWidgetView(snapshot, 65000);
  const styles = plainStyles();

  for (const width of [270, 120, 40, 20]) {
    assert.equal(
      renderWidgetView(view, { selected: false, cursor: 0 }, width, styles).length,
      1,
      `宽度 ${width} 折叠态仍恰好 1 行`,
    );
    for (const selected of [false, true]) {
      const lines = renderWidgetView(view, { selected, cursor: 1 }, width, styles);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `selected=${selected} width=${width}: line renders ${visibleWidth(line)} > ${width}`,
        );
      }
    }
  }

  // Selection gutter counts toward the budget, cursor marker still visible.
  const selected = renderWidgetView(view, { selected: true, cursor: 1 }, 270, styles);
  assert.match(selected[1], /^▸ /);
  assert.match(selected[selected.length - 1], /↑↓ 选择/);
});

test("renderWidgetView 大团队窗口的每行同样受终端宽度约束（折叠提示行含在内）", () => {
  const view = buildWidgetView(largeTeamSnapshot(12), 65000);
  const styles = plainStyles();
  for (const width of [40, 20, 12]) {
    for (const cursor of [0, 8, view.rows.length - 1]) {
      for (const line of renderWidgetView(view, { selected: true, cursor }, width, styles)) {
        assert.ok(
          visibleWidth(line) <= width,
          `width=${width} cursor=${cursor}: line renders ${visibleWidth(line)} > ${width}`,
        );
      }
    }
  }
});

test("widget rows never carry raw newlines (multi-line task/activity/latest flattened)", () => {
  // 与 viewer 同族的边界契约：宿主逐行渲染 widget 字符串项，任何残余换行都会
  // 变成额外残行（widget.ts 的 flatten/truncateTask 是唯一防线，此测试钉住它）。
  const snapshot = liveSnapshot();
  snapshot.progress!.task = "第一行\n第二行";
  snapshot.progress!.leaderActivity = "审查中\n回显第二行";
  snapshot.progress!.members[0]!.latest = "编辑中\n回显第二行";
  const view = buildWidgetView(snapshot, 65000);
  const styles = plainStyles();
  for (const selected of [false, true]) {
    for (const line of renderWidgetView(view, { selected, cursor: 1 }, 120, styles)) {
      assert.doesNotMatch(line, /[\r\n]/, `widget 行不得含原始换行：${JSON.stringify(line)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Controller: data-driven registration (mount/unmount + fingerprint)
// ---------------------------------------------------------------------------

function registrationHarness(load: () => RunStatusSnapshot): {
  controller: RunWidgetController;
  pushed: Array<string[] | undefined>;
} {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 长 tick：只验证显式 refresh 语义
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  controller.start();
  return { controller, pushed };
}

test("controller 空闲（无 run）：start 不注册亮块（数据驱动挂载，不再动作驱动常驻）", () => {
  const { controller, pushed } = registrationHarness(() => ({ running: false, progress: null, lastRecord: null }));
  try {
    assert.equal(pushed.length, 0, "无活跃 run 不得推送任何 setWidget");
  } finally {
    controller.stop();
  }
});

test("controller 终态记录：不注册亮块（终态行不进 widget）", () => {
  const { controller, pushed } = registrationHarness(doneSnapshot);
  try {
    assert.equal(pushed.length, 0, "终态记录不得推送亮块");
  } finally {
    controller.stop();
  }
});

test("controller 活跃 run：start 推折叠单行；落定 refresh 推 undefined 卸载；再 refresh 不重复推送", () => {
  let snapshot = liveSnapshot();
  const { controller, pushed } = registrationHarness(() => snapshot);
  try {
    assert.equal(pushed.length, 1, "活跃 run 挂载恰好一帧");
    assert.deepEqual(pushed[0], ["agent-team dev-team · ↓/← 查看详情"]);

    snapshot = doneSnapshot(); // run 落定（coordinator 清空 progress）
    controller.refresh();
    assert.equal(pushed.length, 2, "落定后立即卸载一帧");
    assert.equal(pushed[1], undefined, "卸载帧为 setWidget(undefined)");

    controller.refresh();
    controller.refresh();
    assert.equal(pushed.length, 2, "已卸载后 refresh 不再 setWidget");
  } finally {
    controller.stop();
  }
});

test("controller 数据驱动挂载：空闲 → 新 run refresh 出帧（事件刷新不等 tick）；再次落定再卸载", () => {
  let snapshot: RunStatusSnapshot = { running: false, progress: null, lastRecord: null };
  const { controller, pushed } = registrationHarness(() => snapshot);
  try {
    assert.equal(pushed.length, 0);

    snapshot = liveSnapshot();
    controller.refresh(); // 派单事件即时刷新（不依赖 1s tick）
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0], ["agent-team dev-team · ↓/← 查看详情"]);

    snapshot = doneSnapshot();
    controller.refresh();
    assert.deepEqual(pushed.at(-1), undefined);
  } finally {
    controller.stop();
  }
});

test("controller 活跃帧静态内容：连续 refresh 跳过 setWidget（renderKey 语义）", () => {
  const { controller, pushed } = registrationHarness(liveSnapshot);
  try {
    const afterStart = pushed.length;
    assert.equal(afterStart, 1);
    controller.refresh();
    controller.refresh();
    assert.equal(pushed.length, afterStart, "折叠行未变应跳过 setWidget");
  } finally {
    controller.stop();
  }
});

test("controller 折叠行不含 elapsed：时间推进也跳过（少 churn）", () => {
  let nowMs = 65000;
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    { load: liveSnapshot, styles: plainStyles(), onConfirm: () => {}, width: () => 80, nowMs: () => nowMs, tickMs: 60 * 60 * 1000 },
    (lines) => {
      pushed.push(lines);
    },
  );
  controller.start();
  try {
    const afterStart = pushed.length;
    nowMs = 66000; // elapsed 1m5s → 1m6s：折叠行不变
    controller.refresh();
    assert.equal(pushed.length, afterStart, "折叠行不含 elapsed → 时间推进也不重绘");
  } finally {
    controller.stop();
  }
});

test("controller 展开态：elapsed 变化触发重绘（时间信息只在展开行）", () => {
  let nowMs = 65000;
  const pushed: Array<string[] | undefined> = [];
  const handlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => nowMs,
      tickMs: 60 * 60 * 1000,
      editorState: () => ({ text: "" }),
    },
    (lines) => {
      pushed.push(lines);
    },
    (handler) => {
      handlers.push(handler);
      return () => {};
    },
  );
  controller.start();
  try {
    handlers[0]!("\x1b[B"); // 展开
    const expanded = pushed.length;
    controller.refresh();
    assert.equal(pushed.length, expanded, "同秒展开帧应跳过");

    nowMs = 66000;
    controller.refresh();
    assert.equal(pushed.length, expanded + 1, "elapsed 变化 → 展开帧重建");
  } finally {
    controller.stop();
  }
});

test("controller setPaused(true) 隐藏亮块并冻结重绘，恢复后立即刷出最新行", () => {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 长 tick：本用例只验证暂停/恢复的同步语义
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    assert.ok(pushed.length >= 1, "start 后立即刷出一帧");
    assert.ok((pushed[pushed.length - 1]?.length ?? 0) > 0, "运行中有亮块行");

    controller.setPaused(true);
    assert.deepEqual(pushed[pushed.length - 1], undefined, "暂停时推 undefined 隐藏亮块");

    const frozen = pushed.length;
    controller.refresh();
    assert.equal(pushed.length, frozen, "暂停期间 refresh 不再 setWidget");

    controller.setPaused(false);
    assert.ok(pushed.length > frozen, "恢复后立即刷出一帧");
    assert.equal(pushed[pushed.length - 1]?.length, 1, "恢复后亮块回来且为折叠单行");
    assert.match(pushed[pushed.length - 1]![0], /agent-team dev-team · ↓\/← 查看详情/);
  } finally {
    controller.stop();
  }
});

test("controller 暂停期间 run 落定：恢复后不重挂（数据驱动卸载跨暂停成立）", () => {
  let snapshot = liveSnapshot();
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    { load: () => snapshot, styles: plainStyles(), onConfirm: () => {}, width: () => 80, nowMs: () => 65000, tickMs: 60 * 60 * 1000 },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    const mounted = pushed.length;
    controller.setPaused(true);
    assert.deepEqual(pushed.at(-1), undefined);
    snapshot = doneSnapshot(); // 暂停期间 run 落定
    controller.setPaused(false);
    assert.equal(pushed.length, mounted + 1, "恢复时终态视图不重挂（无新 setWidget）");
    assert.deepEqual(pushed.at(-1), undefined, "最后一帧仍是卸载帧");
  } finally {
    controller.stop();
  }
});

test("controller 暂停后 tick 停止（折叠态静止：tick 只刷新不 setWidget）", async () => {
  const pushed: Array<string[] | undefined> = [];
  let loadCalls = 0;
  let nowMs = 65000;
  const controller = new RunWidgetController(
    {
      load: () => {
        loadCalls += 1;
        return liveSnapshot();
      },
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => nowMs,
      tickMs: 5,
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    const afterStart = pushed.length;
    const callsAfterStart = loadCalls;
    // 折叠行不含 elapsed：tick 持续刷新（load 被反复调用）但渲染串不变，
    // 指纹门控跳过 setWidget（少 churn，与 fleet-status renderKey 语义一致）。
    nowMs = 67000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(loadCalls > callsAfterStart, `tick 应持续刷新，load 调用数实得 ${loadCalls}`);
    assert.equal(pushed.length, afterStart, "折叠态静止内容：tick 不再 setWidget");

    controller.setPaused(true);
    assert.deepEqual(pushed[pushed.length - 1], undefined, "暂停帧为 undefined");
    const afterPause = pushed.length;
    const callsAfterPause = loadCalls;
    nowMs = 69000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pushed.length, afterPause, "暂停帧后 tick 不再 setWidget");
    assert.equal(loadCalls, callsAfterPause, "暂停期间 tick 循环已停（load 不再被调用）");
  } finally {
    controller.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 4：editorState 门控 + j/k 导航（seam D：经 fake 端口的真实 controller）
// ---------------------------------------------------------------------------

function controllerHarness(opts: {
  load: () => RunStatusSnapshot;
  editorState?: () => { text: string };
  editorFocus?: () => boolean | undefined;
  onConfirm?: (actor: string) => void;
}) {
  const pushed: Array<string[] | undefined> = [];
  const handlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: opts.load,
      styles: plainStyles(),
      onConfirm: opts.onConfirm ?? (() => {}),
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 长 tick：本用例只验证键盘事件路径
      editorState: opts.editorState,
      editorFocus: opts.editorFocus,
    },
    (lines) => {
      pushed.push(lines);
    },
    (handler) => {
      handlers.push(handler);
      return () => {};
    },
  );
  controller.start();
  return { controller, pushed, handlers };
}

const lastLines = (pushed: Array<string[] | undefined>): string[] => pushed[pushed.length - 1] ?? [];
const cursorRow = (lines: string[]): number => lines.findIndex((line) => line.startsWith("▸ "));

// 首帧即折叠单行：活跃 run 的默认态只有一行。
test("controller 首帧：折叠单行（无行光标、含激活提示）", () => {
  const { controller, pushed } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    const lines = lastLines(pushed);
    assert.equal(lines.length, 1, "默认态恰好 1 行");
    assert.equal(lines[0], "agent-team dev-team · ↓/← 查看详情");
    assert.equal(cursorRow(lines), -1, "折叠态无行光标");
  } finally {
    controller.stop();
  }
});

// 编辑器为空：bare ↓ 进入选中并 consume（对齐 fleet-status getEditorText===""）。
test("controller 空编辑器按 ↓ 激活 widget（consume、展开树 + 提示行、出现行光标）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    assert.equal(handlers.length, 1, "attachInput 应收到一个 handler");
    const r = handlers[0]!("\x1b[B");
    assert.equal(r?.consume, true, "空编辑器 ↓ 应被 widget 消费");
    const lines = lastLines(pushed);
    assert.equal(cursorRow(lines), 0, "激活后行光标应在第 0 行（main）");
    assert.equal(lines.length, LIVE_ROWS.length + 1, "展开 = 树行 + 底部提示行");
    assert.match(lines[lines.length - 1], /↑↓ 选择 · enter 查看 · esc 退出/);
  } finally {
    controller.stop();
  }
});

// 编辑器有文本：bare ↓/← 放行编辑器（不消费），widget 不劫持输入。
test("controller 编辑器有文本时 ↓/← 不消费（放行编辑器，保持折叠）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "abc" }),
  });
  try {
    assert.equal(handlers[0]!("\x1b[B"), undefined, "有文本时 ↓ 不消费");
    assert.equal(handlers[0]!("\x1b[D"), undefined, "有文本时 ← 不消费");
    assert.equal(cursorRow(lastLines(pushed)), -1, "未进入选中，无行光标");
    assert.equal(lastLines(pushed).length, 1, "保持折叠单行");
  } finally {
    controller.stop();
  }
});

// 编辑器有文本：alt+↓/↑ 第二通道仍激活（差异表 §3.3）。
test("controller 编辑器有文本时 alt+↓/↑ 仍激活（第二通道不受门控）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "abc" }),
  });
  try {
    const r = handlers[0]!("\x1b[1;3B");
    assert.equal(r?.consume, true, "有文本时 alt+↓ 仍应激活");
    assert.equal(cursorRow(lastLines(pushed)), 0);
  } finally {
    controller.stop();
  }
});

// 选中态 j/k 移动行光标（对齐 fleet selectDown/selectUp 的 down/j、up/k）。
test("controller 选中态 k/j 移动行光标（▸ 前缀位置随之变化）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    handlers[0]!("\x1b[B"); // 激活（cursor 0）
    assert.equal(cursorRow(lastLines(pushed)), 0);

    handlers[0]!("j"); // 下移
    assert.equal(cursorRow(lastLines(pushed)), 1, "j 应下移到 leader 行");
    handlers[0]!("k"); // 上移
    assert.equal(cursorRow(lastLines(pushed)), 0, "k 应回到 main 行");
    handlers[0]!("k"); // 顶部再按 k：退出选中放行编辑器（fleet-status 同构）
    assert.equal(cursorRow(lastLines(pushed)), -1, "到顶再按 k 应退出选中（无行光标）");
    assert.equal(lastLines(pushed).length, 1, "退出选中后收回折叠单行");
    assert.equal(handlers[0]!("j"), undefined, "退出选中后 j 放行编辑器");
    handlers[0]!("\x1b[1;3B"); // alt+↓ 重新激活（cursor 保持）
    assert.equal(cursorRow(lastLines(pushed)), 0, "再次激活回到原光标");
    handlers[0]!("j");
    handlers[0]!("j");
    handlers[0]!("j");
    handlers[0]!("j"); // 底部（任务行）再按 j：钳位不越界（仍选中）
    assert.equal(cursorRow(lastLines(pushed)), LIVE_ROWS.length - 1);
  } finally {
    controller.stop();
  }
});

// enter 按行 kind 分派：root 仅收起选中；leader/成员行调 onConfirm(actor)。
test("controller enter：main 行不进 viewer；leader/成员行 onConfirm 对应 actor", () => {
  const confirmed: string[] = [];
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
    onConfirm: (actor) => confirmed.push(actor),
  });
  try {
    handlers[0]!("\x1b[B"); // main 行（cursor 0）
    assert.equal(handlers[0]!("\r")?.consume, true, "main 行 enter 被消费");
    assert.deepEqual(confirmed, [], "main 行 enter 不进 viewer");
    assert.equal(cursorRow(lastLines(pushed)), -1, "main 行 enter 只收起选中");

    handlers[0]!("\x1b[1;3B"); // 重新激活（cursor 保持 0）
    handlers[0]!("j"); // leader 行
    assert.equal(cursorRow(lastLines(pushed)), 1);
    handlers[0]!("\r");
    assert.deepEqual(confirmed, ["_leader"], "leader 行 enter 打开 leader 转录");

    handlers[0]!("\x1b[1;3B"); // 重新激活（cursor 保持 1）
    handlers[0]!("j"); // frontend 成员行
    assert.equal(cursorRow(lastLines(pushed)), 2);
    handlers[0]!("\r");
    assert.deepEqual(confirmed, ["_leader", "frontend"], "成员行 enter 打开该成员转录");
  } finally {
    controller.stop();
  }
});

// 宿主无 editorState 端口：降级为仅 alt 通道激活（bare ↓ 不消费）。
test("controller 宿主无 editorState 端口 → 降级：仅 alt 通道激活", () => {
  const { controller, handlers } = controllerHarness({ load: liveSnapshot });
  try {
    assert.equal(handlers[0]!("\x1b[B"), undefined, "降级时 bare ↓ 不消费");
    assert.equal(handlers[0]!("\x1b[1;3B")?.consume, true, "降级时 alt+↓ 仍激活");
  } finally {
    controller.stop();
  }
});

// 真机回归（用户 2026-09-15）：Kitty 协议下一次按键 = press + release，
// release 必须被忽略，否则光标一次跳两格（表现成“选不中成员”）。
test("controller: press+release 序列只生效一次（光标只移动一格）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    handlers[0]!("\x1b[B"); // press：激活，cursor 0
    handlers[0]!("\x1b[1;1:3B"); // release：必须忽略
    assert.equal(cursorRow(lastLines(pushed)), 0, "release 不得把光标推到下一行");
    handlers[0]!("\x1b[B"); // 第二次 ↓ press
    handlers[0]!("\x1b[1;1:3B"); // 第二次 release
    assert.equal(cursorRow(lastLines(pushed)), 1, "两次按键 = 移动一格，不跳行");
  } finally {
    controller.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 8：焦点门控（对齐 fleet-status editorHasFocus，v0.66.0
// fleet-status.ts:701/965）——结构判定 + probe + controller 端口
// ---------------------------------------------------------------------------

function editorShape(): Record<string, unknown> {
  return { render: () => [], invalidate: () => {}, handleInput: () => {}, getText: () => "", setText: () => {} };
}

function selectorShape(): Record<string, unknown> {
  return { render: () => [], invalidate: () => {}, handleInput: () => {} };
}

test("isEditorComponentLike：五方法齐全的编辑器形状为真，选择器/空对象为假（fleet-status 同款结构判定）", () => {
  assert.equal(isEditorComponentLike(editorShape()), true);
  // 选择器形状（无 getText/setText，如 OAuthSelectorComponent/ExtensionSelectorComponent）
  assert.equal(isEditorComponentLike(selectorShape()), false);
  assert.equal(isEditorComponentLike(null), false);
  assert.equal(isEditorComponentLike(undefined), false);
  assert.equal(isEditorComponentLike({}), false);
  assert.equal(isEditorComponentLike({ handleInput: () => {} }), false, "仅 handleInput 的对话框组件不是编辑器");
  assert.equal(isEditorComponentLike({ getText: () => "", setText: () => {} }), false, "缺 render 也不是编辑器");
});

test("probeEditorFocus：getFocusedComponent 优先、字段回退、皆无/抛错 → undefined（未知=降级）", () => {
  assert.equal(probeEditorFocus({ getFocusedComponent: () => editorShape() }), true);
  assert.equal(probeEditorFocus({ getFocusedComponent: () => selectorShape() }), false);
  assert.equal(probeEditorFocus({ focusedComponent: editorShape() }), true);
  assert.equal(probeEditorFocus({ focusedComponent: selectorShape() }), false);
  // 方法优先于运行时字段（宿主同时具备时以公共 getter 为准）
  assert.equal(probeEditorFocus({ getFocusedComponent: () => editorShape(), focusedComponent: selectorShape() }), true);
  // 宿主无字段也无方法 → undefined（未知识别，controller 侧保留旧门控）
  assert.equal(probeEditorFocus({}), undefined);
  assert.equal(probeEditorFocus(null), undefined);
  assert.equal(probeEditorFocus(undefined), undefined);
  // 取用抛错 → undefined（门控绝不弄崩按键路径）
  assert.equal(
    probeEditorFocus({
      getFocusedComponent: () => {
        throw new Error("host getter exploded");
      },
    }),
    undefined,
  );
  // 字段存在但值 null → false（确定没有编辑器焦点）
  assert.equal(probeEditorFocus({ focusedComponent: null }), false);
});

test("controller 焦点非编辑器（选择器/对话框）：裸 ↓ 与 alt+↓ 都不消费、不选中（对话框期 widget 完全不介入）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
    editorFocus: () => false,
  });
  try {
    assert.equal(handlers[0]!("\x1b[B"), undefined, "焦点在 /login 选择器时裸 ↓ 必须让行");
    assert.equal(handlers[0]!("\x1b[D"), undefined, "裸 ← 同样让行");
    assert.equal(handlers[0]!("\x1b[1;3B"), undefined, "alt+↓ 第二通道在对话框期也不介入");
    assert.equal(handlers[0]!("\x1b[1;3A"), undefined, "alt+↑ 同样不介入");
    assert.equal(cursorRow(lastLines(pushed)), -1, "不得进入选中");
    assert.equal(lastLines(pushed).length, 1, "对话框期保持折叠单行");
  } finally {
    controller.stop();
  }
});

test("controller 选中态焦点丢失（选择器打开）：退出选中且该键放行（保留 cursor 供再激活）", () => {
  let focused: boolean | undefined = true;
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
    editorFocus: () => focused,
  });
  try {
    handlers[0]!("\x1b[B"); // 编辑器焦点 + 空编辑器 → 激活
    assert.equal(cursorRow(lastLines(pushed)), 0);
    focused = false; // 宿主把焦点交给选择器
    assert.equal(handlers[0]!("\x1b[B"), undefined, "焦点丢失后按键放行选择器（不消费）");
    assert.equal(cursorRow(lastLines(pushed)), -1, "选中态自动退出（无行光标）");
    assert.equal(lastLines(pushed).length, 1, "退出选中后收回折叠单行");
    focused = true;
    handlers[0]!("\x1b[1;3B"); // alt 通道重新激活
    assert.equal(cursorRow(lastLines(pushed)), 0, "焦点回来后可从原 cursor 再激活");
  } finally {
    controller.stop();
  }
});

test("controller editorFocus=true + 空编辑器：裸 ↓ 照常激活（真编辑器焦点不被误伤）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
    editorFocus: () => true,
  });
  try {
    assert.equal(handlers[0]!("\x1b[B")?.consume, true, "主编辑器焦点时空编辑器裸 ↓ 仍应激活");
    assert.equal(cursorRow(lastLines(pushed)), 0);
  } finally {
    controller.stop();
  }
});

test("controller editorFocus=undefined（宿主无焦点信息）→ 与旧门控语义一致：空编辑器裸 ↓ 照常激活", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
    editorFocus: () => undefined,
  });
  try {
    assert.equal(handlers[0]!("\x1b[B")?.consume, true, "焦点未知时不得改变既有行为（降级）");
    assert.equal(cursorRow(lastLines(pushed)), 0);
  } finally {
    controller.stop();
  }
});

test("controller 无 editorFocus 端口 → 旧语义回归锁（空编辑器裸 ↓ 激活、非空不激活、alt 照旧）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    assert.equal(handlers[0]!("\x1b[B")?.consume, true);
    assert.equal(cursorRow(lastLines(pushed)), 0);
  } finally {
    controller.stop();
  }
  const nonEmpty = controllerHarness({ load: liveSnapshot, editorState: () => ({ text: "x" }) });
  try {
    assert.equal(nonEmpty.handlers[0]!("\x1b[B"), undefined);
    assert.equal(nonEmpty.handlers[0]!("\x1b[1;3B")?.consume, true, "alt 第二通道照旧");
  } finally {
    nonEmpty.controller.stop();
  }
});

// ---------------------------------------------------------------------------
// 选中态 toggle 重绘（跳过逻辑不得压制选中态变化）
// ---------------------------------------------------------------------------

test("controller 选中态 toggle 触发重绘（不被跳过逻辑压制）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    const before = pushed.length;
    handlers[0]!("\x1b[B"); // 进入选中：渲染串出现 ▸ + 提示行 → 必须重绘
    assert.equal(pushed.length, before + 1, "进入选中应触发一次重绘");
    assert.equal(cursorRow(lastLines(pushed)), 0, "选中后行光标在第 0 行");
    assert.equal(lastLines(pushed).length, LIVE_ROWS.length + 1, "展开 = 树行 + 提示行");

    handlers[0]!("\x1b"); // esc 退出选中：渲染串回到折叠单行 → 必须重绘
    assert.equal(pushed.length, before + 2, "退出选中应再触发一次重绘");
    assert.equal(cursorRow(lastLines(pushed)), -1, "退出后无行光标");
    assert.equal(lastLines(pushed).length, 1, "esc 收回折叠单行");
  } finally {
    controller.stop();
  }
});
