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
import {
  LOG_KEEP_MAX,
  LOG_RETENTION_MS,
  isProcessAlive,
  nextJobSeq,
  pruneJobLogs,
  sessionLogDir,
  stripControlChars,
  tailFileSync,
} from "../logs.ts";

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

test("sessionLogDir / nextJobSeq：目录缺失或没有 bg-N.log 时从 1 起；有则取最大号 + 1", () => {
  const root = tmp();
  assert.equal(sessionLogDir(root), path.join(root, String(process.pid)));
  assert.equal(nextJobSeq(root), 1, "会话目录还不存在 → 1");

  const session = path.join(root, "4242");
  fs.mkdirSync(session, { recursive: true });
  assert.equal(nextJobSeq(root, 4242), 1, "目录存在但没有日志 → 1（无匹配名不算数）");
  for (const name of ["bg-1.log", "bg-3.log", "bg-11.log", "other.txt", "bg-x.log"]) {
    fs.writeFileSync(path.join(session, name), "x");
  }
  assert.equal(nextJobSeq(root, 4242), 12, "取现有 bg-<n>.log 的最大号 + 1（文件名数字序，不是字典序）");
});

test("isProcessAlive：本进程活着；不存在的 pid 判死", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999_999), false, "超大 pid 在任何平台都不存在（ESRCH）");
});

test("pruneJobLogs：活着的会话目录不吃数量上限（含并发的第二个 pi），死目录照旧；保留期对所有目录生效", () => {
  const root = tmp();
  const now = Date.now();
  const mine = path.join(root, "1111");       // 本进程的会话目录
  const otherLive = path.join(root, "2222");  // 并发的第二个 pi（另一个终端 / pi --print / 子 agent）
  const dead = path.join(root, "3333");       // 已退出会话的目录
  for (const dir of [mine, otherLive, dead]) fs.mkdirSync(dir, { recursive: true });
  const write = (dir: string, name: string, ageMs: number): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const stamp = new Date(now - ageMs);
    fs.utimesSync(file, stamp, stamp);
    return file;
  };
  const mineLogs = ["bg-1", "bg-2", "bg-3"].map((name, index) => write(mine, `${name}.log`, (3 - index) * 1_000));
  const otherLogs = ["bg-1", "bg-2"].map((name, index) => write(otherLive, `${name}.log`, (2 - index) * 1_000));
  const staleLive = write(otherLive, "bg-9.log", LOG_RETENTION_MS + 60_000);
  const deadLogs = ["bg-1", "bg-2"].map((name, index) => write(dead, `${name}.log`, (2 - index) * 1_000));
  const isAlive = (pid: number): boolean => pid === 1111 || pid === 2222;

  // keepMax=1：两个活目录的新鲜日志全留（通知里的路径还在被引用；只看「是不是自己」不够——别的活会话也一样），
  // 死目录只留最新 1 条，过期文件连活目录也被清。
  assert.equal(pruneJobLogs(root, now, { keepMax: 1, isAlive }), 2);
  for (const file of [...mineLogs, ...otherLogs]) assert.equal(fs.existsSync(file), true, `${file} 应保留（活会话不吃数量上限）`);
  assert.equal(fs.existsSync(staleLive), false, "保留期对活会话目录仍生效");
  assert.equal(fs.existsSync(deadLogs[0]!), false, "死目录最旧的仍被数量上限删");
  assert.equal(fs.existsSync(deadLogs[1]!), true);
});

test("pruneJobLogs：不注入 isAlive 时按真实进程判活（本进程目录不吃数量上限）", () => {
  const root = tmp();
  const now = Date.now();
  const mine = path.join(root, String(process.pid));
  fs.mkdirSync(mine, { recursive: true });
  const files = ["bg-1", "bg-2"].map((name, index) => {
    const file = path.join(mine, `${name}.log`);
    fs.writeFileSync(file, "x");
    const stamp = new Date(now - (2 - index) * 1_000);
    fs.utimesSync(file, stamp, stamp);
    return file;
  });
  // 真实接线（options.isAlive ?? isProcessAlive）也得被判活：keepMax=1 下两条都留。
  assert.equal(pruneJobLogs(root, now, { keepMax: 1 }), 0);
  for (const file of files) assert.equal(fs.existsSync(file), true);
});

test("pruneJobLogs：空目录被收掉、不存在的根目录不报错", () => {
  const root = tmp();
  const empty = path.join(root, "9999");
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(pruneJobLogs(root, Date.now()), 0);
  assert.equal(fs.existsSync(empty), false);
  assert.equal(pruneJobLogs(path.join(root, "missing"), Date.now()), 0);
});
