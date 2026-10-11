/**
 * codemode.ts 单测：**顶层 codemode 工具结果**的 `details.calls` → 触碰列表。
 *
 * 边界：纯逻辑，不碰文件系统也不碰宿主 runner——只锁定「哪些嵌套调用算触碰」与降级口径
 * （截断 args / 非 JSON / 未知工具 / 非 codemode 结果）。宿主事件路径（真实 ExtensionRunner
 * 分发 + 真实注入）见 index-host.test.ts。
 *
 * 为什么值得单独测：`args` 是宿主的**截断预览**（200 字符 + `...` 尾），解析失败必须**跳过**
 * 而不是猜——这里的降级就是「少注入但不误注入」这条不变量的落点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNestedTouchBuffer, dedupeTouches, detectCodemodeTouches, isCodemodeResult, MAX_NESTED_CALL_GROUPS, MAX_NESTED_TOUCHES_PER_CALL } from "../codemode.ts";
import type { Touch } from "../touch.ts";

/** 真实 CodemodeNestedCall 形状（id/name/args/status）；args 默认按宿主的紧凑 JSON 生成。 */
function call(name: string, args: unknown, status = "ok") {
  return { id: `call-1/${name}`, name, args: typeof args === "string" ? args : JSON.stringify(args), status };
}

function touchesOf(calls: unknown[]): Touch[] | null {
  return detectCodemodeTouches("codemode", { calls });
}

test("五个触碰工具都认：read/write/edit/ls 的 path 与 bash 白名单单文件读", () => {
  assert.deepEqual(
    touchesOf([
      call("read", { path: "src/components/Button.tsx" }),
      call("write", { path: "src/components/New.tsx", content: "x" }),
      call("edit", { path: "src/app.ts", edits: [] }),
      call("ls", { path: "src/components" }),
      call("bash", { command: "cat src/index.ts" }),
    ]),
    [
      { rawPath: "src/components/Button.tsx", kind: "file" },
      { rawPath: "src/components/New.tsx", kind: "file" },
      { rawPath: "src/app.ts", kind: "file" },
      { rawPath: "src/components", kind: "directory" },
      { rawPath: "src/index.ts", kind: "file" },
    ],
  );
});

test("ls 省略 path：算触碰当前目录（与顶层同一语义）", () => {
  assert.deepEqual(touchesOf([call("ls", {})]), [{ rawPath: ".", kind: "directory" }]);
});

test("非触碰工具与 models.* 明细：零触碰", () => {
  assert.deepEqual(
    touchesOf([
      call("grep", { pattern: "x", path: "src" }),
      call("find", { pattern: "x", path: "src" }),
      call("team_run", { team: "x" }),
      call("chat", "opencode-go/deepseek-flash"),
      call("image", "opencode-go/router"),
    ]),
    [],
  );
});

test("远端调用的明细：零触碰——远端路径按本机 cwd 解就是错注入（dir-context-todo#4）", () => {
  assert.deepEqual(
    touchesOf([
      call("read", { path: "docs/x.md", remote: "prod" }),
      call("write", { path: "docs/y.md", remote: "user@10.0.0.1", content: "x" }),
      call("ls", { path: "docs", remote: "prod" }),
      call("bash", { command: "cat docs/z.md", remote: "prod" }),
    ]),
    [],
  );
  // 同一次脚本里本地与远端混着来：只留本地那条。
  assert.deepEqual(touchesOf([call("read", { path: "src/a.ts" }), call("read", { path: "src/b.ts", remote: "prod" })]), [
    { rawPath: "src/a.ts", kind: "file" },
  ]);
  // 缺省值字面量 / 空串 = 没给 remote ⇒ 仍是本地触碰（与 remote.ts 同口径）。
  assert.deepEqual(touchesOf([call("read", { path: "src/a.ts", remote: "null" })]), [{ rawPath: "src/a.ts", kind: "file" }]);
  assert.deepEqual(touchesOf([call("read", { path: "src/a.ts", remote: "  " })]), [{ rawPath: "src/a.ts", kind: "file" }]);
});

test("bash 只认单文件读白名单：重定向 / 变量 / 多文件一律「拿不准」⇒ 零触碰", () => {
  assert.deepEqual(
    touchesOf([call("bash", { command: "cat a.ts b.ts" }), call("bash", { command: "cat $FILE" }), call("bash", { command: "cat x.ts > y.ts" })]),
    [],
  );
});

test("args 截断（宿主 previewArgs 的 ... 尾）或非 JSON：该条跳过，其余照算", () => {
  const truncated = `${JSON.stringify({ path: "src/components/Button.tsx", content: "x".repeat(400) }).slice(0, 197)}...`;
  assert.deepEqual(
    touchesOf([call("read", truncated), call("write", ""), call("read", "{不是 JSON"), call("ls", { path: "src" })]),
    [{ rawPath: "src", kind: "directory" }],
    "只有合法 JSON 的那条留下；截断/空/非法一律跳过（少注入，不误注入）",
  );
});

test("args 解析出非对象（数组 / 数字 / null）：跳过", () => {
  assert.deepEqual(touchesOf([call("read", "[]"), call("read", "5"), call("read", "null")]), []);
});

test("status 为 error / cancelled 的嵌套调用照算（文件可能已被读写，注入与脚本成败无关）", () => {
  assert.deepEqual(
    touchesOf([call("read", { path: "src/a.ts" }, "error"), call("write", { path: "src/b.ts" }, "cancelled"), call("ls", {}, "running")]),
    [
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src/b.ts", kind: "file" },
      { rawPath: ".", kind: "directory" },
    ],
  );
});

test("同一路径重复触碰：去重且保序（脚本里的调用顺序）", () => {
  assert.deepEqual(
    touchesOf([
      call("read", { path: "src/a.ts" }),
      call("bash", { command: "cat src/a.ts" }),
      call("read", { path: "src/b.ts" }),
    ]),
    [
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src/b.ts", kind: "file" },
    ],
  );
});

test("不是 codemode 顶层结果：返回 null（调用方走普通触碰路径）", () => {
  assert.equal(detectCodemodeTouches("read", { calls: [] }), null, "工具名不同");
  assert.equal(detectCodemodeTouches("codemode", undefined), null, "details 缺失");
  assert.equal(detectCodemodeTouches("codemode", "x"), null, "details 不是对象");
  assert.equal(detectCodemodeTouches("codemode", {}), null, "没有 calls");
  assert.equal(detectCodemodeTouches("codemode", { calls: "x" }), null, "calls 不是数组");
});

test("是 codemode 但没有可认的触碰：返回空数组（与「不是 codemode」区分）", () => {
  assert.deepEqual(detectCodemodeTouches("codemode", { calls: [] }), []);
  assert.deepEqual(detectCodemodeTouches("codemode", { calls: [null, "x", { name: "read" }, { args: "{}" }], fullOutputPath: "C:/tmp/x" }), []);
});

// —— 嵌套触碰缓冲（dir-context-todo#3）：嵌套 tool_result 事件的**完整 input** 是主来源，
// `details.calls` 的截断 args 降级为兜底。

test("dedupeTouches：按 kind + rawPath 去重且保序（并集用）", () => {
  assert.deepEqual(
    dedupeTouches([
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src", kind: "directory" },
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src/a.ts", kind: "directory" },
    ]),
    [
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src", kind: "directory" },
      { rawPath: "src/a.ts", kind: "directory" },
    ],
    "同路径不同 kind 是两条；同 kind 同路径只留首次出现",
  );
});

test("嵌套缓冲：按父调用归组，take 取走即清（同一组不会被消费两次）", () => {
  const buffer = createNestedTouchBuffer();
  buffer.record("call-A", { rawPath: "src/a.ts", kind: "file" });
  buffer.record("call-B", { rawPath: "src/b.ts", kind: "file" });

  assert.deepEqual(buffer.take("call-A").touches, [{ rawPath: "src/a.ts", kind: "file" }]);
  assert.deepEqual(buffer.take("call-A").touches, [], "已取走的组不再返回");
  assert.deepEqual(buffer.take("call-B").touches, [{ rawPath: "src/b.ts", kind: "file" }], "其他组不受影响");
  assert.deepEqual(buffer.take("call-C"), { touches: [], remote: false }, "未知组返回空组");
});

test("嵌套缓冲：远端记号与触碰是两个维度，互不干扰", () => {
  const buffer = createNestedTouchBuffer();
  buffer.markRemote("call-A");
  buffer.record("call-B", { rawPath: "src/b.ts", kind: "file" });

  const remoteOnly = buffer.take("call-A");
  assert.deepEqual(remoteOnly.touches, [], "远端调用不产生本地触碰（路径在远端解析）");
  assert.equal(remoteOnly.remote, true);
  assert.equal(buffer.take("call-B").remote, false, "没标过的组 remote 恒 false");

  // 同一组里远端与本地混着来：本地的照记，记号也留着（顶层既注入又提示）。
  const mixed = createNestedTouchBuffer();
  mixed.record("call-C", { rawPath: "src/a.ts", kind: "file" });
  mixed.markRemote("call-C");
  mixed.record("call-C", { rawPath: "src/c.ts", kind: "file" });
  assert.deepEqual(mixed.take("call-C"), {
    touches: [
      { rawPath: "src/a.ts", kind: "file" },
      { rawPath: "src/c.ts", kind: "file" },
    ],
    remote: true,
  });
});

test("嵌套缓冲：单组超过上限的后续触碰丢弃（少记，不误记）", () => {
  const buffer = createNestedTouchBuffer();
  for (let index = 0; index < MAX_NESTED_TOUCHES_PER_CALL + 5; index += 1) {
    buffer.record("call-A", { rawPath: `src/f${index}.ts`, kind: "file" });
  }
  const taken = buffer.take("call-A").touches;
  assert.equal(taken.length, MAX_NESTED_TOUCHES_PER_CALL);
  assert.equal(taken[0]?.rawPath, "src/f0.ts", "先记的保留");
  assert.equal(taken.at(-1)?.rawPath, `src/f${MAX_NESTED_TOUCHES_PER_CALL - 1}.ts`);
});

test("嵌套缓冲：组数超过上限时淘汰最旧的组（内存有界）", () => {
  const buffer = createNestedTouchBuffer();
  for (let index = 0; index < MAX_NESTED_CALL_GROUPS + 2; index += 1) {
    buffer.record(`call-${index}`, { rawPath: `src/g${index}.ts`, kind: "file" });
  }
  assert.deepEqual(buffer.take("call-0").touches, [], "最旧的组已被淘汰");
  assert.deepEqual(buffer.take("call-1").touches, []);
  assert.equal(buffer.take(`call-${MAX_NESTED_CALL_GROUPS + 1}`).touches.length, 1, "最新的组在");
});

test("嵌套缓冲：clear 清空全部组", () => {
  const buffer = createNestedTouchBuffer();
  buffer.record("call-A", { rawPath: "src/a.ts", kind: "file" });
  buffer.clear();
  assert.deepEqual(buffer.take("call-A").touches, []);
});

test("isCodemodeResult：只认工具名，与 details 形状解耦（消费缓冲的判据）", () => {
  assert.equal(isCodemodeResult("codemode"), true);
  assert.equal(isCodemodeResult("read"), false);
  assert.equal(isCodemodeResult("my-codemode"), false, "只认内置工具名，不认前缀/近似名");
  assert.deepEqual(detectCodemodeTouches("codemode", undefined), null, "details 形状不对只是解析不出触碰，不影响「是不是 codemode」");
});
