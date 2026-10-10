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
import { detectCodemodeTouches } from "../codemode.ts";
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
