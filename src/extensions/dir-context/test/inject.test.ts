/**
 * inject.ts 单测：注入文本的格式、码点安全截断与预算。
 *
 * 纯函数（无 fs、无宿主）——这是真正隔离的逻辑，边界由调用方（index.ts 读文件）承担。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, buildInjection, truncateUtf8 } from "../inject.ts";

test("截断：未超限时原样返回", () => {
  assert.deepEqual(truncateUtf8("abc", 10), { text: "abc", truncated: false });
});

test("截断：多字节字符不劈开（按码点边界）", () => {
  const result = truncateUtf8("中文中文", 7);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "中文"); // 6 字节；再放一个 3 字节字符会到 9 > 7
  assert.equal(Buffer.byteLength(result.text, "utf8") <= 7, true);
});

test("截断：代理对 / 4 字节 emoji 不被劈开", () => {
  const result = truncateUtf8("ab😀cd", 6); // a(1) b(1) 😀(4) = 6
  assert.equal(result.text, "ab😀");
  assert.equal(result.truncated, true);
});

test("格式化：每个文件带 Loaded 抬头 + dir-context 包裹（含相对路径）", () => {
  const result = buildInjection([
    { absolutePath: "/p/src/AGENTS.md", relativePath: "src/AGENTS.md", content: "src 规则" },
    { absolutePath: "/p/src/ui/AGENTS.md", relativePath: "src/ui/AGENTS.md", content: "ui 规则" },
  ]);

  assert.equal(result.injected.length, 2);
  assert.equal(result.injected[0]?.truncated, false);
  assert.match(result.text, /Loaded src\/AGENTS\.md/);
  assert.match(result.text, /<dir-context path="src\/AGENTS\.md">/);
  assert.match(result.text, /src 规则/);
  assert.match(result.text, /Loaded src\/ui\/AGENTS\.md/);
  assert.ok(result.text.indexOf("src 规则") < result.text.indexOf("ui 规则"), "由外向内：祖先内容在前");
});

test("超单文件上限：截断到上限并在块内标注原文大小", () => {
  const content = "中".repeat(MAX_FILE_BYTES); // 3 字节/字符 → 远超上限
  const result = buildInjection([{ absolutePath: "/p/a/AGENTS.md", relativePath: "a/AGENTS.md", content }]);

  assert.equal(result.injected[0]?.truncated, true);
  const kept = result.injected[0]?.content ?? "";
  assert.ok(Buffer.byteLength(kept, "utf8") <= MAX_FILE_BYTES);
  // 标记里的字节数必须是**实际保留**的字节数：多字节字符下它小于上限。
  assert.match(result.text, new RegExp(`truncated to ${Buffer.byteLength(kept, "utf8")} bytes of ${content.length * 3} bytes`));
});

test("超总预算：按剩余额度截断后续文件，并列出被丢弃的文件", () => {
  const file = (name: string) => ({
    absolutePath: `/p/${name}/AGENTS.md`,
    relativePath: `${name}/AGENTS.md`,
    content: "x".repeat(MAX_FILE_BYTES),
  });
  // 5 个满额文件 = 160 KiB > 128 KiB 预算
  const result = buildInjection([file("a"), file("b"), file("c"), file("d"), file("e")]);

  assert.equal(result.injected.length, MAX_TOTAL_BYTES / MAX_FILE_BYTES); // 前 4 个进上下文
  const total = result.injected.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
  assert.equal(total, MAX_TOTAL_BYTES);
  assert.match(result.text, /skipped \(injection budget exhausted\): e\/AGENTS\.md/);
});

test("单文件正好等于上限：不标截断", () => {
  const result = buildInjection([{ absolutePath: "/p/a/AGENTS.md", relativePath: "a/AGENTS.md", content: "x".repeat(MAX_FILE_BYTES) }]);
  assert.equal(result.injected[0]?.truncated, false);
  assert.doesNotMatch(result.text, /truncated to/);
});

test("空列表：零注入、空文本", () => {
  const result = buildInjection([]);
  assert.deepEqual(result.injected, []);
  assert.equal(result.text, "");
});
