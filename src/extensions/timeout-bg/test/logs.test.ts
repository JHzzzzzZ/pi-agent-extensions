/**
 * logs.ts 单测：后台日志的尾部读取与保留策略（timeout-bg-todo#1）
 *
 * 边界：真实临时目录 + 真实文件（这正是被测逻辑：磁盘上的日志读写），
 * 时钟用显式 nowMs 注入（保留期判定不依赖真实时间）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOG_KEEP_MAX, LOG_RETENTION_MS, pruneJobLogs, stripControlChars, tailFileSync } from "../logs.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-log-"));
}

test("tailFileSync：短文件读全文；文件缺失给空串", () => {
  const dir = tmp();
  const file = path.join(dir, "a.log");
  fs.writeFileSync(file, "line1\nline2\n");
  assert.equal(tailFileSync(file, 4096), "line1\nline2");
  assert.equal(tailFileSync(path.join(dir, "nope.log"), 4096), "");
});

test("tailFileSync：超上限只取尾部，且丢掉可能被截断的首行", () => {
  const dir = tmp();
  const file = path.join(dir, "a.log");
  fs.writeFileSync(file, `AAAA\nBBBB\nCCCC\n`);
  const tail = tailFileSync(file, 8); // 从中间切到 "BBB\nCCCC\n"
  assert.equal(tail, "CCCC");
});

test("stripControlChars / tailFileSync：剔除终端控制字符（ESC 序列不进模型上下文）", () => {
  const dir = tmp();
  const file = path.join(dir, "a.log");
  fs.writeFileSync(file, "\u001b[31mred\u001b[0m\nbell\u0007\n");
  assert.equal(tailFileSync(file, 4096), "[31mred[0m\nbell");
  assert.equal(stripControlChars("a\u0000b\tc"), "ab\tc");
});

test("pruneJobLogs：超过保留期的文件被删，新鲜文件保留", () => {
  const root = tmp();
  const session = path.join(root, "1234");
  fs.mkdirSync(session, { recursive: true });
  const old = path.join(session, "bg-1.log");
  const fresh = path.join(session, "bg-2.log");
  fs.writeFileSync(old, "old");
  fs.writeFileSync(fresh, "fresh");
  const now = Date.now();
  fs.utimesSync(old, new Date(now - LOG_RETENTION_MS - 60_000), new Date(now - LOG_RETENTION_MS - 60_000));

  assert.equal(pruneJobLogs(root, now), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("pruneJobLogs：超出数量上限时保留最新的 keepMax 个（含跨会话目录）", () => {
  const root = tmp();
  const now = Date.now();
  const total = 6;
  for (let index = 0; index < total; index += 1) {
    const session = path.join(root, `s${index % 2}`);
    fs.mkdirSync(session, { recursive: true });
    const file = path.join(session, `bg-${index}.log`);
    fs.writeFileSync(file, `log ${index}`);
    const stamp = new Date(now - (total - index) * 1_000);
    fs.utimesSync(file, stamp, stamp);
  }
  assert.equal(pruneJobLogs(root, now, { keepMax: 2 }), total - 2);
  const left = fs
    .readdirSync(root)
    .flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((name) => name))
    .sort();
  assert.deepEqual(left, ["bg-4.log", "bg-5.log"]);
  assert.equal(LOG_KEEP_MAX, 50);
});

test("pruneJobLogs：空目录被收掉、不存在的根目录不报错", () => {
  const root = tmp();
  const empty = path.join(root, "9999");
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(pruneJobLogs(root, Date.now()), 0);
  assert.equal(fs.existsSync(empty), false);
  assert.equal(pruneJobLogs(path.join(root, "missing"), Date.now()), 0);
});
