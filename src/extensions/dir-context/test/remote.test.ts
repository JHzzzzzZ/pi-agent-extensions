/**
 * remote.ts 单测：远端调用判据与提示文案。
 *
 * 边界：纯逻辑——只看一个入参对象里的 `remote` 字段，不 import 任何其它插件、不碰文件系统。
 * 判据错一个方向的代价是不对称的：判成远端只是**少注入**（模型自己读一次），
 * 判成本地则是**错注入**（把本机约定喂给远端结果）。因此这里的用例重心是「哪些必须判 false」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRemoteCall, REMOTE_NOTICE } from "../remote.ts";

test("非空字符串即远端：host 形态不限（ssh 目标字符串、别名、IP 都认）", () => {
  for (const remote of ["prod", "user@host", "user@10.0.0.1", "10.0.0.1", "prod:2222", "  PROD  ", "pi-remote"]) {
    assert.equal(isRemoteCall({ remote }), true, remote);
  }
});

test("字段缺失 / 非字符串：按本地处理（没装 remote-tools 时字段根本不存在）", () => {
  for (const input of [{}, { remote: undefined }, { remote: null }, { remote: 42 }, { remote: true }, { remote: {} }, { remote: [] }]) {
    assert.equal(isRemoteCall(input as Record<string, unknown>), false, JSON.stringify(input));
  }
});

test("空串与纯空白：按本地处理（模型给了个空值 = 没给）", () => {
  for (const remote of ["", " ", "\t", "\n", "   \t "]) {
    assert.equal(isRemoteCall({ remote }), false, JSON.stringify(remote));
  }
});

test("缺省值字面量：按本地处理（与 remote-tools 的 ABSENCE_LITERALS 同口径，trim + 大小写无关）", () => {
  const literals = [
    "null",
    "NULL",
    " None ",
    "undefined",
    "UNDEFINED",
    "nil",
    "Nil",
    "none",
    "n/a",
    "N/A",
    "na",
    "NA",
    " n/a ",
  ];
  for (const remote of literals) assert.equal(isRemoteCall({ remote }), false, JSON.stringify(remote));
});

test("近似字面量不算缺省值：判远端（宁可少注入，也不误注入）", () => {
  for (const remote of ["nulll", "nan", "non", "n / a", "none2", "nullx"]) {
    assert.equal(isRemoteCall({ remote }), true, remote);
  }
});

test("只读 remote 字段：path 是什么都不影响判据（命中远端时不看 path）", () => {
  assert.equal(isRemoteCall({ path: "docs/x.md", remote: "prod" }), true);
  assert.equal(isRemoteCall({ path: "/srv/app/docs/x.md", remote: "prod" }), true);
  assert.equal(isRemoteCall({ path: "docs/x.md" }), false);
  assert.equal(isRemoteCall({ path: "docs/x.md", remote: "prod", remotePort: 2222 }), true);
});

test("提示文案：单行、非空、静态（不含插值位置、不提远端内容）", () => {
  assert.ok(REMOTE_NOTICE.length > 0);
  assert.equal(REMOTE_NOTICE.includes("\n"), false, "必须是一行（只追加一行提示）");
  assert.equal(REMOTE_NOTICE.includes("${"), false, "静态模板：不插值任何东西（host 名也是模型输入）");
  assert.match(REMOTE_NOTICE, /remote/, "要告诉模型用什么手段自己读远端约定");
});
