/**
 * ChatAnywhere API key 解析（auth.ts）测试
 *
 * 真实探测（2026-09-09）发现：key 存在 ~/.pi/agent/auth.json 时扩展探测拿不到
 * （只认 CHATANYWHERE_API_KEY 环境变量）→ 401 → fail-closed 空模型。本模块按
 * 环境变量 → auth.json（chatanywhere → chatanywhere-claude 条目）顺序解析。
 * 文件读取经注入的 readFn 隔离（进程边界 fake）。
 * 运行：node --experimental-strip-types --test test/auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyFromAuth, readAuthJson, resolveApiKey } from "../auth.ts";

test("resolveApiKey：环境变量优先", () => {
	assert.equal(resolveApiKey("sk-env", { chatanywhere: { key: "sk-auth" } }, ["chatanywhere"]), "sk-env");
});

test("resolveApiKey：环境变量为空/缺省时回退 auth.json，并按 id 顺序尝试", () => {
	const auth = { chatanywhere: { key: "sk-ca" }, "chatanywhere-claude": { key: "sk-claude" } };
	assert.equal(resolveApiKey("", auth, ["chatanywhere", "chatanywhere-claude"]), "sk-ca");
	assert.equal(resolveApiKey(undefined, { "chatanywhere-claude": { key: "sk-claude" } }, ["chatanywhere", "chatanywhere-claude"]), "sk-claude");
	assert.equal(resolveApiKey(undefined, {}, ["chatanywhere", "chatanywhere-claude"]), undefined);
});

test("apiKeyFromAuth：结构校验（非对象/非字符串/空 key 均视为无）", () => {
	assert.equal(apiKeyFromAuth(null, ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth([], ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth("x", ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth({ chatanywhere: 5 }, ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth({ chatanywhere: { key: 123 } }, ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth({ chatanywhere: { key: "   " } }, ["chatanywhere"]), undefined);
	assert.equal(apiKeyFromAuth({ chatanywhere: { key: "sk-ok" } }, ["chatanywhere"]), "sk-ok");
});

test("readAuthJson：读失败/解析失败返回 undefined（不抛异常、不阻断加载）", () => {
	assert.equal(readAuthJson("x.json", () => { throw new Error("enoent"); }), undefined);
	assert.equal(readAuthJson("x.json", (() => "{not json") as never), undefined);
	assert.deepEqual(readAuthJson("x.json", (() => '{"chatanywhere":{"key":"sk-1"}}') as never), { chatanywhere: { key: "sk-1" } });
});