/**
 * remote-tools — 远端上下文协议 v2 的测试（工单 `remote-tools-todo#13` / `#14`）。
 *
 * 边界说明：#13 的要害是**字节级**的分帧行为——「命令里含 base64」这种纸面断言测不出真 shell 里
 * `printf` / `base64` / 重定向长什么样，所以真 shell 往返用例真的起 `bash -c` 跑
 * `buildContextCommand` 的输出再按协议解回来；平台没有 `bash`/`base64` 时按平台条件 skip
 * （不静默绿）。协议形状、归一化与能力层用例是纯本地的，ssh 边界注入手写 fake。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildContextCommand,
  createRemoteContextCapability,
  FRAME_MARK,
  parseContextFiles,
  type RemoteContextRequest,
  type RemoteContextTarget,
} from "../context.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";

const TARGET: RemoteContextTarget = { remotePath: "/home/u/docs/x.md", baseDir: "/home/u", target: { host: "prod", user: undefined, port: undefined } };
const REQUEST: RemoteContextRequest = { remote: "prod", path: "docs/x.md", kind: "file" };

/** ssh 是进程边界：注入手写 fake，只记录调用并回脚本化的结果。 */
function makeExec(handler: (request: SshExecRequest) => Partial<SshExecResult> = () => ({})) {
  const calls: SshExecRequest[] = [];
  const exec: SshExec = async (request) => {
    calls.push(request);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
  };
  return { exec, calls };
}

/** v2 的一帧：标记 + 路径 + base64 载荷 + 分帧符。 */
function frame(mark: string, filePath: string, content: string): Buffer {
  return Buffer.from(`${mark}${filePath}\u0000${Buffer.from(content, "utf8").toString("base64")}\u0000`, "utf8");
}

/** 从原始 stdout 里取第 index 个帧（段对：帧头 + 载荷）。 */
function rawFrame(stdout: Buffer, index: number): { mark: string; path: string; payload: string } {
  const parts = stdout.toString("utf8").split("\u0000");
  const head = parts[index * 2] ?? "";
  return { mark: head.slice(0, 1), path: head.slice(1), payload: parts[index * 2 + 1] ?? "" };
}

const decode = (payload: string): Buffer => Buffer.from(payload.replace(/\s+/g, ""), "base64");

/** 在**真实 bash** 里跑一次远端命令。平台缺 `bash`/`base64` 时返回 null（用例自行 skip）。 */
function runRealShell(dir: string): Buffer | null {
  if (spawnSync("bash", ["-c", "command -v base64"], { timeout: 20_000 }).status !== 0) return null;
  const result = spawnSync("bash", ["-c", buildContextCommand([dir.split("\\").join("/")])], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`真 shell 失败：${result.stderr.toString("utf8")}`);
  return result.stdout;
}

test("真 shell 往返：内容含 NUL 也只产出一个帧，字节级还原（v1 能被内容伪造出帧边界）", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-v2-"));
  try {
    // 内容撑过 57 字节：GNU base64 默认 76 列换行，短内容永远一行 ⇒「解码前剥空白」这条路径
    // 在端到端上就永远跑不到真输入（Node 的 base64 解码本身容忍空白，光看结果发现不了）。
    const forged = `FIRST\u0000/evil\u0000SECOND\n中文\t制表\r\n空行下面\n\n尾\n${"0123456789".repeat(12)}`;
    assert.ok(Buffer.byteLength(forged, "utf8") > 57, "fixture 必须撑过 57 字节，否则 base64 不换行");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), forged);
    const stdout = runRealShell(dir);
    if (stdout === null) return t.skip("本机没有 bash 或 base64（平台条件不满足）");

    const parts = stdout.toString("utf8").split("\u0000");
    const heads = parts.filter((_, index) => index % 2 === 0 && index + 1 < parts.length);
    assert.equal(heads.length, 1, "含 NUL 的内容必须仍然只产出一个帧——多出来的就是被内容伪造的近帧");
    const first = rawFrame(stdout, 0);
    assert.equal(first.mark, FRAME_MARK.readable);
    assert.ok(first.path.endsWith("/AGENTS.md"), `路径帧是真实路径：${first.path}`);
    assert.equal(decode(first.payload).toString("utf8"), forged, "字节级还原：NUL / 制表 / CRLF / 空行 / 中文都不丢");
    assert.ok(decode(first.payload).includes(0), "内容里的 NUL 真的还在（不是被悄悄吃掉）");
    assert.ok(first.payload.includes("\n"), "base64 载荷真的带换行（GNU 默认 76 列）⇒「解码前剥空白」被真实触发");
    assert.ok(!first.payload.includes("\u0000"), "载荷里不可能有 NUL：这正是内容无法伪造帧边界的原因");
    assert.equal(parts[2], "", "帧尾分帧符之后没有多余段 ⇒ 没有被伪造出来的第二个路径");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("真 shell 往返：空的真文件产出空载荷（不是缺帧），读不出时是 \\x02 标记", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-v2-"));
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "");
    const empty = runRealShell(dir);
    if (empty === null) return t.skip("本机没有 bash 或 base64（平台条件不满足）");
    assert.equal(rawFrame(empty, 0).mark, FRAME_MARK.readable, "空的真文件是「读得出」");
    assert.equal(decode(rawFrame(empty, 0).payload).length, 0, "载荷为空");

    fs.chmodSync(path.join(dir, "AGENTS.md"), 0o000);
    const blocked = runRealShell(dir);
    fs.chmodSync(path.join(dir, "AGENTS.md"), 0o644);
    if (blocked === null) return;
    const mark = rawFrame(blocked, 0).mark;
    if (mark === FRAME_MARK.unreadable) {
      assert.equal(rawFrame(blocked, 0).payload, "", "读不出 ⇒ 载荷恒空");
    } else {
      // root 或 chmod 不生效的平台（Windows）：只能仍是「读得出」，但绝不能变成别的标记
      assert.equal(mark, FRAME_MARK.readable, "chmod 不生效时仍应是读得出");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("分帧解析：`\\x03` 单帧 ⇒ unsupported（与「空文件」「读不出」都不同形）", () => {
  assert.deepEqual(parseContextFiles(Buffer.from(`${FRAME_MARK.unsupported}\u0000`, "utf8")), {
    files: [],
    unreadable: [],
    unsupported: true,
  });
});

test("取上下文：远端缺 base64 ⇒ ok:false，绝不静默当成「没有约定文件」", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: Buffer.from(`${FRAME_MARK.unsupported}\u0000`, "utf8") }));
  const capability = createRemoteContextCapability({ resolve: async () => TARGET, exec });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.code : "", "REMOTE_CONTEXT_FAILED");
  assert.match(outcome.ok === false ? outcome.message : "", /base64/);
  assert.equal(calls.length, 1);
});

test("取上下文：锚点带 `..` / `.` ⇒ 归一化后再建链（去重键与块标题不因别名漂移）", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: frame(FRAME_MARK.readable, "/home/u/docs/AGENTS.md", "约定") }));
  const capability = createRemoteContextCapability({
    resolve: async () => ({ ...TARGET, remotePath: "/home/u/docs/../docs/./x.md" }),
    exec,
  });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.ok(calls[0] !== undefined);
  assert.ok(!(calls[0]?.args.at(-1) ?? "").includes(".."), "命令里的目录已归一，不再出现 `..`");
  assert.ok((calls[0]?.args.at(-1) ?? "").includes("'/home/u/docs'"), "归一后的目录被单引号包住");
  assert.equal(outcome.ok === true ? outcome.dir : "", "/home/u/docs", "回给消费方的 dir 也是归一后的（它拿去当去重键与标题）");
});

test("取上下文：尾斜杠与 `..` 同时出现时两种归一不互相抵消", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: Buffer.alloc(0) }));
  const capability = createRemoteContextCapability({
    resolve: async () => ({ ...TARGET, remotePath: "/home/u/docs/../docs//x.md" }),
    exec,
  });
  await capability.fetchRemoteContext(REQUEST);
  assert.ok(calls[0] !== undefined);
  assert.ok((calls[0]?.args.at(-1) ?? "").includes("'/home/u/docs'"), "不出现双斜杠也不出现 `..`");
  assert.ok(!(calls[0]?.args.at(-1) ?? "").includes("'//"), "无 `//` 前缀（POSIX 对 `//` 是实现自定义）");
});
