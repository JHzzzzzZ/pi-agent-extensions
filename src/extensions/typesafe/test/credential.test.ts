/**
 * typesafe/credential.test.ts — key 解析的边界（typesafe-todo#1）
 *
 * 边界口径（docs/cross/deps-ports.md 规则 3）：解析逻辑是纯函数，直接测；读文件这一
 * 进程边界用**真实临时文件**（不 mock fs），因为解密的焦点正是「文件读不到/内容坏了
 * 怎么办」——注入 fake 会把这条最容易出错的路径变成纸面正确。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  apiKeyFromAuth,
  authFilePath,
  readAuthJson,
  resolveTypeSafeKey,
  PROVIDER_ID,
} from "../credential.ts";

const KEY = "sk-typesafe-test-0001";

test("credential: 环境变量优先于 auth.json", () => {
  const auth = { [PROVIDER_ID]: { type: "api_key", key: "from-auth-file" } };
  assert.equal(resolveTypeSafeKey("from-env", auth), "from-env");
});

test("credential: 无环境变量时取 auth.json 的 typesafe 条目", () => {
  const auth = {
    deepseek: { type: "api_key", key: "sk-deepseek" },
    [PROVIDER_ID]: { type: "api_key", key: KEY },
  };
  assert.equal(resolveTypeSafeKey(undefined, auth), KEY);
});

test("credential: 环境变量为空串/纯空白时回退 auth.json", () => {
  const auth = { [PROVIDER_ID]: { type: "api_key", key: KEY } };
  assert.equal(resolveTypeSafeKey("", auth), KEY);
  assert.equal(resolveTypeSafeKey("   ", auth), KEY);
});

test("credential: key 前后空白被裁掉", () => {
  const auth = { [PROVIDER_ID]: { type: "api_key", key: `  ${KEY}\n` } };
  assert.equal(resolveTypeSafeKey(undefined, auth), KEY);
  assert.equal(resolveTypeSafeKey(` ${KEY} `, undefined), KEY);
});

test("credential: 缺失条目一律 undefined（fail-closed，不抛异常）", () => {
  assert.equal(resolveTypeSafeKey(undefined, undefined), undefined);
  assert.equal(resolveTypeSafeKey(undefined, {}), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: {} }), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: { key: "" } }), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: { key: "   " } }), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: { key: 42 } }), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: null }), undefined);
  assert.equal(resolveTypeSafeKey(undefined, { [PROVIDER_ID]: "sk-plain-string" }), undefined);
});

test("credential: 结构损坏的 auth.json 内容不炸", () => {
  assert.equal(apiKeyFromAuth(null, [PROVIDER_ID]), undefined);
  assert.equal(apiKeyFromAuth([], [PROVIDER_ID]), undefined);
  assert.equal(apiKeyFromAuth("nope", [PROVIDER_ID]), undefined);
  assert.equal(apiKeyFromAuth(7, [PROVIDER_ID]), undefined);
});

test("credential: 只认 typesafe 条目，别的 provider 的 key 不会被误取", () => {
  const auth = {
    "opencode-go": { type: "api_key", key: "sk-opencode" },
    "kimi-coding": { type: "api_key", key: "sk-kimi" },
  };
  assert.equal(resolveTypeSafeKey(undefined, auth), undefined);
});

test("credential: authFilePath 跟随 PI_CODING_AGENT_DIR（与 Pi getAgentDir 同口径）", () => {
  assert.match(authFilePath({} as NodeJS.ProcessEnv), /agent[\\/]auth\.json$/);
  assert.equal(
    authFilePath({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" } as NodeJS.ProcessEnv),
    join("/tmp/pi-agent", "auth.json"),
  );
  assert.match(authFilePath({ PI_CODING_AGENT_DIR: "   " } as NodeJS.ProcessEnv), /agent[\\/]auth\.json$/);
});

test("credential: readAuthJson 读真实文件，坏 JSON / 缺文件返回 undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "typesafe-cred-"));
  const good = join(dir, "auth.json");
  writeFileSync(good, JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: KEY } }), "utf8");
  assert.deepEqual(readAuthJson(good), { [PROVIDER_ID]: { type: "api_key", key: KEY } });
  assert.equal(resolveTypeSafeKey(undefined, readAuthJson(good)), KEY);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json", "utf8");
  assert.equal(readAuthJson(broken), undefined);
  assert.equal(readAuthJson(join(dir, "missing.json")), undefined);
});
