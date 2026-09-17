/**
 * todo-cli/test/failure-scene.ts — 失败现场诊断 helper（todo-cli-todo:13 第一步）。
 *
 * 为什么需要：test:todo 的并发/中断用例失败时只剩 reporter 一行与截断 200 字符的
 * stderr（`res.stderr.slice(0, 200)`），无法区分「锁等待拖到超时」「EPERM rename
 * 争用」「测试自身竞态」。本模块在用例失败时把足以判读的现场写成 markdown 文件：
 * 原始错误与完整 stack、子进程时间线（含逐 close 剩余锁快照）、每个子进程的
 * stdout/stderr 全文——文件 KB 级，不做自动清理（证据必须活到人工判读之后）。
 *
 * 契约（行为由 test/failure-scene.test.ts 锁定）：
 *   - 通过路径零写盘零输出：`activeSceneSink()` 无激活场景返回 null，调用方 `?.` 直通；
 *   - 失败路径绝不吞错：重抛同一个 Error 对象，只往 message 追加一行现场绝对路径；
 *     现场渲染或写盘自身失败则整体吞掉、原错误原样重抛——最坏丢现场，绝不丢失败；
 *   - 目录与时钟全注入：固定 now 时文件名与内容确定；`-N` 碰撞序号靠扫描目录取号；
 *   - 本文件不匹配 `*.test.ts` glob，且 test/ 不在 toolFiles() 拷贝清单内，不进 fixture。
 *
 * 接缝：模块级「当前场景」槽位 + null 直通（不做 recorder 参数穿透）。文件内用例
 * 默认顺序执行，`Promise.all` 并发喂同一 sink 在单线程事件循环下原子。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { archiveStamp } from "../align.ts";

export interface SceneDeps {
  /** 现场目录；默认 `%TEMP%/todo-cli-failure-scenes`，直到失败写盘那一刻才 mkdir recursive。 */
  dir?: string;
  /** 注入时钟（ISO）；默认真实时钟（duration 由 Date.parse 差值派生，单一时钟源）。 */
  now?: () => string;
}

/** 失败现场的事件入口：接线方全部用 `activeSceneSink()?.xxx()` 直通，无场景时零开销。 */
export interface SceneSink {
  /** 记一次子进程启动，返回 childId（后续 close/fail 用）。 */
  spawn(label: string, fields?: { pid?: number; args?: string[] }): number;
  /** 记一次子进程结束（含 stdout/stderr 全文，不截断）；durationMs = close − spawn。 */
  close(
    childId: number,
    fields: { code: number | null; signal: string | null; stdout: string; stderr: string },
  ): void;
  /** 记一次 spawn "error" 事件（进程未能启动等）。 */
  fail(childId: number, message: string): void;
  /** 记任意上下文（fixture root、逐 close 剩余锁快照），按记录顺序进备注节。 */
  note(key: string, text: string): void;
}

interface SceneChild {
  label: string;
  args: string[];
  pid: number | null;
  stdout: string;
  stderr: string;
  spawnMs: number;
}

interface SceneEvent {
  seq: number;
  at: string;
  kind: "spawn" | "close" | "error";
  childId: number;
  label: string;
  code: number | null;
  signal: string | null;
  durationMs: number | null;
  detail: string | null;
}

interface SceneNote {
  key: string;
  text: string;
}

interface SceneState {
  name: string;
  dir: string;
  now: () => string;
  startedAt: string;
  startedMs: number;
  events: SceneEvent[];
  children: Map<number, SceneChild>;
  notes: SceneNote[];
  nextChildId: number;
}

interface ActiveScene {
  state: SceneState;
  sink: SceneSink;
}

let active: ActiveScene | null = null;

/** 当前激活场景的事件入口；wrapper 外（含通过路径）为 null。 */
export function activeSceneSink(): SceneSink | null {
  return active === null ? null : active.sink;
}

/**
 * 包住一个用例体：通过则返回值原样透传、零写盘零输出；失败则写现场并重抛原值
 * （Error 只追加一行 `[失败现场] <绝对路径>`，写盘失败时连这行也不追加）。
 */
export async function withFailureScene<T>(name: string, fn: () => T | Promise<T>, deps: SceneDeps = {}): Promise<T> {
  const state = createSceneState(name, deps);
  active = { state, sink: createSink(state) };
  try {
    return await fn();
  } catch (thrown) {
    const endedAt = state.now();
    const written = tryWriteScene(state, endedAt, thrown);
    if (written !== null && thrown instanceof Error) thrown.message += `\n[失败现场] ${written}`;
    throw thrown;
  } finally {
    active = null;
  }
}

function createSceneState(name: string, deps: SceneDeps): SceneState {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  return {
    name,
    dir: deps.dir ?? path.join(os.tmpdir(), "todo-cli-failure-scenes"),
    now,
    startedAt,
    startedMs: Date.parse(startedAt),
    events: [],
    children: new Map(),
    notes: [],
    nextChildId: 1,
  };
}

function createSink(state: SceneState): SceneSink {
  const push = (event: Omit<SceneEvent, "seq">): void => {
    state.events.push({ seq: state.events.length + 1, ...event });
  };
  return {
    spawn(label, fields) {
      const childId = state.nextChildId;
      state.nextChildId += 1;
      const at = state.now();
      state.children.set(childId, {
        label,
        args: fields?.args ?? [],
        pid: fields?.pid ?? null,
        stdout: "",
        stderr: "",
        spawnMs: Date.parse(at),
      });
      push({ at, kind: "spawn", childId, label, code: null, signal: null, durationMs: null, detail: null });
      return childId;
    },
    close(childId, fields) {
      const child = state.children.get(childId);
      const at = state.now();
      if (child !== undefined) {
        child.stdout = fields.stdout;
        child.stderr = fields.stderr;
      }
      push({
        at,
        kind: "close",
        childId,
        label: child?.label ?? `child ${childId}`,
        code: fields.code,
        signal: fields.signal,
        durationMs: child === undefined ? null : Date.parse(at) - child.spawnMs,
        detail: null,
      });
    },
    fail(childId, message) {
      push({
        at: state.now(),
        kind: "error",
        childId,
        label: state.children.get(childId)?.label ?? `child ${childId}`,
        code: null,
        signal: null,
        durationMs: null,
        detail: message,
      });
    },
    note(key, text) {
      state.notes.push({ key, text });
    },
  };
}

/** 写现场：渲染 + 写盘整体 try/catch，任何失败返回 null（绝不吞掉原用例失败）。 */
function tryWriteScene(state: SceneState, endedAt: string, thrown: unknown): string | null {
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    const target = nextScenePath(state.dir, archiveStamp(state.startedAt), sanitizeSceneName(state.name));
    fs.writeFileSync(target, renderScene(state, endedAt, thrown), "utf8");
    return target;
  } catch {
    return null;
  }
}

/** 净化用例名：非 `\p{L}\p{N}` 连串折叠为 `-`，截 60 字符（文件名跨平台安全）。 */
function sanitizeSceneName(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
}

/** 同 stamp 同名碰撞的确定性取号：首份无后缀，其后 -2、-3…（扫目录取最大序号 + 1）。 */
function nextScenePath(dir: string, stamp: string, sanitized: string): string {
  const prefix = `${stamp}-${sanitized}`;
  let maxIndex = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith(prefix) || !file.endsWith(".md")) continue;
    const suffix = file.slice(prefix.length, file.length - ".md".length);
    if (suffix === "") {
      maxIndex = Math.max(maxIndex, 1);
      continue;
    }
    const numbered = /^-(\d+)$/.exec(suffix);
    if (numbered !== null) maxIndex = Math.max(maxIndex, Number(numbered[1]));
  }
  const index = maxIndex + 1;
  return path.join(dir, index === 1 ? `${prefix}.md` : `${prefix}-${index}.md`);
}

function renderScene(state: SceneState, endedAt: string, thrown: unknown): string {
  const lines: string[] = [
    `# 失败现场：${state.name}`,
    "",
    `- 开始：${state.startedAt}`,
    `- 结束：${endedAt}`,
    `- 总耗时：${Date.parse(endedAt) - state.startedMs}ms`,
    `- node：${process.version}`,
    `- platform：${process.platform}`,
    `- pid：${process.pid}`,
    `- cwd：${process.cwd()}`,
    "",
    "## 原始错误",
    "",
    fence(renderThrown(thrown)),
    "",
    "## 子进程时间线",
    "",
    ...renderTimeline(state.events, state.children),
    "",
    "## 子进程输出",
    "",
    ...renderOutputs(state.children),
    "",
    "## 备注",
    "",
    ...(state.notes.length === 0 ? ["（无备注）"] : state.notes.map((note) => `- ${note.key}：${note.text}`)),
    "",
  ];
  return lines.join("\n");
}

function renderThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    const stack = typeof thrown.stack === "string" && thrown.stack !== "" ? thrown.stack : thrown.message;
    return `${thrown.message}\n\n${stack}`;
  }
  return String(thrown);
}

/** 时间线表：seq | 时刻 | 事件 | 标签（含 args 与失败详情）| pid | exit/signal | 耗时ms。 */
function renderTimeline(events: SceneEvent[], children: Map<number, SceneChild>): string[] {
  const lines = [
    "| seq | 时刻 | 事件 | 标签 | pid | exit/signal | 耗时ms |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const event of events) {
    const child = children.get(event.childId);
    const args = child === undefined || child.args.length === 0 ? "" : ` ${child.args.join(" ")}`;
    const detail = event.detail === null ? "" : `（${event.detail}）`;
    // 表格安全：压平空白、竖线替换，避免多行/分隔符撕裂 markdown 表。
    const label = `${event.label}${args}${detail}`.replace(/\s+/g, " ").replace(/\|/g, "/");
    const code = event.code === null ? "-" : String(event.code);
    const signal = event.signal === null ? "-" : event.signal;
    const exit = event.kind === "close" ? `exit ${code} / signal ${signal}` : "-";
    const duration = event.durationMs === null ? "-" : String(event.durationMs);
    lines.push(`| ${event.seq} | ${event.at} | ${event.kind} | ${label} | ${child?.pid ?? "-"} | ${exit} | ${duration} |`);
  }
  return lines;
}

/** 子进程输出：每个 child 一节，stdout/stderr 全文 fenced、不截断。 */
function renderOutputs(children: Map<number, SceneChild>): string[] {
  if (children.size === 0) return ["（无子进程）"];
  const lines: string[] = [];
  for (const [childId, child] of children) {
    if (lines.length > 0) lines.push("");
    const pid = child.pid === null ? "" : `（pid ${child.pid}）`;
    lines.push(`### child ${childId} · ${child.label}${pid}`, "", "stdout：", "", fence(child.stdout), "", "stderr：", "", fence(child.stderr));
  }
  return lines;
}

function fence(text: string): string {
  return `\`\`\`text\n${text}\n\`\`\``;
}
