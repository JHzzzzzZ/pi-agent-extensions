/**
 * Viewer ghost regression: /team:view chrome (title top border + member
 * tabs) must render exactly once per frame, and the actor selection must
 * survive actor-list growth after a dispatch. Pure renderer only — the
 * pi-tui host component is never instantiated (repo convention).
 *
 * Covers the reported bug: after the 2nd member reply, switching views
 * stacked `agent-team · team … · Ns` + `1 leader ▸ 2 front ▸` pairs that
 * kept appending with the elapsed clock (15s/16s/17s…).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_CHROME_ROWS,
  VIEWER_OVERLAY_OPTIONS,
  handleViewerKey,
  initialViewerState,
  plainStyles,
  renderViewerFrame,
  resolveActorIndex,
  stabilizeBodyHeight,
  viewerDataFingerprint,
  withResolvedActor,
  type Styles,
  type ViewerData,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

const styles: Styles = plainStyles();

function entry(kind: TranscriptEntry["kind"], text: string, ts = "2026-09-06T12:34:56.000Z"): TranscriptEntry {
  return { kind, text, ts };
}

function ghostData(overrides: Partial<ViewerData> = {}): ViewerData {
  return {
    team: "count-duet",
    runId: "run-1788924765183",
    runStatus: "running",
    elapsed: "15s",
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "front", label: "front", status: "running" },
    ],
    entries: new Map<string, TranscriptEntry[]>([
      [
        "_leader",
        [
          entry("task", "1 到 10 leader 奇数/front 偶数逐个派单"),
          entry("assistant", "收到，开始派单"),
          entry("tool", 'team_dispatch {"tasks":[{"agent":"front"}]}'),
        ],
      ],
      ["front", [entry("task", "数偶数"), entry("assistant", "2 写完")] ],
    ]),
    ...overrides,
  };
}

/** Second dispatch lands: member transcript grows, leader logs the result. */
function afterSecondDispatch(data: ViewerData): ViewerData {
  const entries = new Map(data.entries);
  entries.set("_leader", [
    ...(entries.get("_leader") ?? []),
    entry("tool", "team_dispatch → report"),
    entry("assistant", "第二个成员 Herrera 已回复，继续"),
  ]);
  entries.set("front", [...(entries.get("front") ?? []), entry("assistant", "4 写完，第二轮回复")]);
  return { ...data, entries, elapsed: "16s" };
}

function chromeCounts(frame: string[]): { tops: number; tabs: number; selected: number } {
  return {
    tops: frame.filter((line) => line.includes("╭─")).length,
    tabs: frame.filter((line) => line.includes("1 leader")).length,
    selected: (frame[1].match(/▸/g) ?? []).length,
  };
}

test("连续 N 帧（含 elapsed 跳动与二次派单）每帧恰好一组 chrome", () => {
  const bodyHeight = 10;
  const states = [initialViewerState(), { ...initialViewerState(), actorIndex: 1 }];
  let data = ghostData();
  const elapsedTicks = ["15s", "16s", "17s", "18s", "19s"];
  for (const elapsed of elapsedTicks) {
    data = { ...data, elapsed };
    for (const state of states) {
      const frame = renderViewerFrame(data, state, 80, { styles, bodyHeight });
      assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS, `elapsed=${elapsed} 帧行数恒定`);
      const counts = chromeCounts(frame);
      assert.equal(counts.tops, 1, `elapsed=${elapsed} 顶边恰出现 1 次`);
      assert.equal(counts.tabs, 1, `elapsed=${elapsed} 成员页签行恰出现 1 次`);
      assert.equal(counts.selected, 1, `elapsed=${elapsed} 页签仅一个 ▸ 选中`);
    }
  }

  // 第二个 agent 回复后 transcript 变长：逐帧仍各 1 行 chrome。
  data = afterSecondDispatch(data);
  for (let i = 0; i < 5; i++) {
    for (const state of states) {
      const frame = renderViewerFrame(data, state, 80, { styles, bodyHeight });
      assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS, `派单后第 ${i} 帧行数恒定`);
      const counts = chromeCounts(frame);
      assert.equal(counts.tops, 1, `派单后第 ${i} 帧顶边恰 1 次`);
      assert.equal(counts.selected, 1, `派单后第 ${i} 帧页签选中恰 1 个`);
    }
  }
});

test("指纹忽略 elapsed 空转，有内容变化才变化", () => {
  const base = ghostData();
  assert.equal(
    viewerDataFingerprint(base),
    viewerDataFingerprint({ ...base, elapsed: "17s" }),
    "elapsed 跳动不触发重绘",
  );
  assert.notEqual(
    viewerDataFingerprint(base),
    viewerDataFingerprint(afterSecondDispatch(base)),
    "新回复改变指纹",
  );
  assert.notEqual(
    viewerDataFingerprint(base),
    viewerDataFingerprint({
      ...base,
      actors: [
        { actor: "_leader", label: "leader", status: "running" },
        { actor: "front", label: "front", status: "done" },
      ],
    }),
    "成员状态变化改变指纹",
  );
  const withNewActor: ViewerData = {
    ...base,
    actors: [...base.actors, { actor: "backend", label: "backend", status: "queued" }],
  };
  assert.notEqual(viewerDataFingerprint(base), viewerDataFingerprint(withNewActor), "新增 actor 改变指纹");
});

test("actors 新增/排序变化时选中按 actor id 保持", () => {
  // 当前选中 front（下标 1）；新增 backend 后按 id 排序 front 后移到下标 2。
  const before = ghostData();
  const selected = { ...initialViewerState(), actorIndex: 1, actor: "front" };
  const after: ViewerData = {
    ...before,
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "backend", label: "backend", status: "queued" },
      { actor: "front", label: "front", status: "running" },
    ],
  };
  assert.equal(resolveActorIndex(after, selected), 2, "按 id 跟随到新下标");
  assert.equal(withResolvedActor(after, selected).actorIndex, 2);
  assert.equal(withResolvedActor(after, selected).actor, "front", "id 本身不变");

  // 选中的 actor 消失时回落到钳制后的下标，不抛不跳顶。
  const gone: ViewerData = {
    ...before,
    actors: [{ actor: "_leader", label: "leader", status: "running" }],
  };
  assert.equal(resolveActorIndex(gone, selected), 0);
});

test("切换成员时同时钉住 actor id", () => {
  const ids = ["_leader", "front", "backend"];
  const from = { ...initialViewerState(), actorIndex: 0, actor: "_leader" };
  const right = handleViewerKey(from, "\x1b[C", { totalLines: 10, actorCount: 3, bodyHeight: 10, actorIds: ids });
  assert.ok(right.type === "update");
  assert.equal(right.state.actorIndex, 1);
  assert.equal(right.state.actor, "front");
  assert.equal(right.state.scroll, 0, "切换重置滚动");
  assert.equal(right.state.follow, true);

  // 无 actorIds 的旧调用路径不引入 actor 键（兼容旧快照）。
  const legacy = handleViewerKey(initialViewerState(), "\x1b[C", { totalLines: 10, actorCount: 2, bodyHeight: 10 });
  assert.ok(legacy.type === "update");
  assert.ok(!("actor" in legacy.state), "旧路径不新增字段");
});

test("overlay 盒模型与 pi-subagents fleet 检查器一字不差", () => {
  // 那边 750ms 无条件重绘不鬼影；这边任何偏离都是堆叠嫌疑，不许"优化"。
  assert.deepEqual(VIEWER_OVERLAY_OPTIONS, {
    anchor: "center",
    width: "95%",
    minWidth: 60,
    maxHeight: "85%",
    margin: 1,
  });
});

test("顶边标题静态：elapsed 跳动不进标题行", () => {
  // 真机实锤：53s/54s、1m26s/1m27s 标题并存——每秒时钟就是堆叠物。
  // 秒表只留 widget，overlay chrome 区零每秒文本。
  for (const elapsed of ["53s", "54s", "1m26s"]) {
    const frame = renderViewerFrame(ghostData({ elapsed }), initialViewerState(), 80, { styles, bodyHeight: 10 });
    assert.ok(!frame[0].includes(elapsed), `标题行不应含 ${elapsed}：${frame[0]}`);
    assert.ok(
      frame.every((line) => !line.includes(elapsed)),
      `整帧无一处含 ${elapsed}（body 时间戳是内容本身，不受此限）`,
    );
  }
});

test("帧高消抖吸收 1 行抖动，大变化才跟随", () => {
  assert.equal(stabilizeBodyHeight(21, 22), 21, "±1 行保持上一高度");
  assert.equal(stabilizeBodyHeight(21, 20), 21);
  assert.equal(stabilizeBodyHeight(21, 23), 23, "±2 行跟随新高度");
  assert.equal(stabilizeBodyHeight(21, 19), 19);
  assert.equal(stabilizeBodyHeight(0, 22), 22, "无历史时直接采用");
});
