/**
 * context.ts 单测：远端目录上下文能力（提供方一侧，dir-context-todo#6）。
 *
 * 边界：ssh 是**进程边界**，用手写 fake 的 `SshExec` 替身（与本目录其它测试同一套路）；
 * 祖先链计算、命令拼装、NUL 分帧解析、失败收敛全是纯逻辑，不碰真实远端。
 * 真机对照见 `remote-live.test.ts`（opt-in）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  buildContextCommand,
  contextChainDirs,
  CONTEXT_FILE_NAMES,
  createRemoteContextCapability,
  MAX_CONTEXT_CHAIN_DEPTH,
  offerRemoteContextCapability,
  parseContextFiles,
  REMOTE_CONTEXT_CHANNEL,
  UNREADABLE_FRAME_PREFIX,
  type RemoteContextFile,
  type RemoteContextRequest,
  type RemoteContextTarget,
} from "../context.ts";
import type { SshExec, SshExecRequest, SshExecResult } from "../ssh.ts";

/** 大部分用例只关心文件列表；`unreadable` 由专门的用例直接断言。 */
const filesOf = (stdout: Buffer): RemoteContextFile[] => parseContextFiles(stdout).files;

const TARGET: RemoteContextTarget = { remotePath: "/home/u/docs/x.md", baseDir: "/home/u", target: { host: "prod", user: undefined, port: undefined } };

function makeExec(handler: (request: SshExecRequest) => Partial<SshExecResult> = () => ({})) {
  const calls: SshExecRequest[] = [];
  const exec: SshExec = async (request) => {
    calls.push(request);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: false, ...handler(request) };
  };
  return { exec, calls };
}

/** 用 NUL 分帧造一段真实形态的 stdout。 */
function framed(files: Array<[string, string]>): Buffer {
  return Buffer.concat(files.flatMap(([path, content]) => [Buffer.from(`${path}\u0000`, "utf8"), Buffer.from(`${content}\u0000`, "utf8")]));
}

const REQUEST: RemoteContextRequest = { remote: "prod", path: "docs/x.md", kind: "file" };

test("祖先链：相对路径走到远端 $HOME 为止（两端都含，由外向内）", () => {
  assert.deepEqual(contextChainDirs("/home/u/docs", "/home/u"), ["/home/u", "/home/u/docs"]);
  assert.deepEqual(contextChainDirs("/home/u/.config/app", "/home/u"), ["/home/u", "/home/u/.config", "/home/u/.config/app"]);
  assert.deepEqual(contextChainDirs("/home/u", "/home/u"), ["/home/u"], "$HOME 自身就是一级（远端没有 cwd 概念，基准照算）");
});

test("祖先链：绝对路径走到 / 为止（含 /）", () => {
  assert.deepEqual(contextChainDirs("/srv/app/docs", "/"), ["/", "/srv", "/srv/app", "/srv/app/docs"]);
  assert.deepEqual(contextChainDirs("/", "/"), ["/"]);
});

test("祖先链：锚点不在基准之内 ⇒ 空链（fail-closed，防 `..` 逃逸出 $HOME）", () => {
  assert.deepEqual(contextChainDirs("/etc", "/home/u"), []);
  assert.deepEqual(contextChainDirs("/home/other/docs", "/home/u"), [], "同前缀但不是子目录（home/u vs home/other）");
});

test("祖先链：深度有上限（命令长度与内存有界）", () => {
  const deep = `/${Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")}`;
  const chain = contextChainDirs(deep, "/");
  assert.equal(chain.length, MAX_CONTEXT_CHAIN_DEPTH, "触顶就停（不再向 / 走）");
  assert.equal(chain.at(-1), deep, "锚点自身总在内");
  assert.notEqual(chain[0], "/", "被截断的是更外层");
});

test("远端命令：一条命令覆盖全部层级与候选名，NUL 分帧，路径单引号包裹", () => {
  const command = buildContextCommand(["/home/u", "/home/u/docs"]);
  for (const name of CONTEXT_FILE_NAMES) assert.ok(command.includes(name), `缺候选名 ${name}`);
  assert.equal(command.split("for n in").length - 1, 2, "两级 = 两个循环段（一趟 ssh 取完整条链）");
  assert.ok(command.includes("f='/home/u'/$n"), "目录被单引号包裹后拼候选名");
  assert.ok(command.includes("[ -f "), "用 -f 而不是 -e：目录叫 AGENTS.md 时不当文件读");
  assert.ok(command.includes("\\000"), "NUL 分帧");
});

test("远端命令：目录名里的单引号被正确转义（不产生注入）", () => {
  const command = buildContextCommand(["/home/u/it's"]);
  assert.ok(command.includes("'/home/u/it'\\''s'"), command);
});

test("远端命令：根目录不产出 `//` 前缀（POSIX 对 `//` 是实现自定义，Cygwin 会当 UNC）", () => {
  const command = buildContextCommand(["/", "/srv"]);
  assert.ok(command.includes("f=''/$n"), command.slice(0, 120));
  assert.equal(command.includes("f='/'/$n"), false);
});

test("NUL 分帧解析：路径帧要像绝对路径且不含换行（远端 banner/rc 吐的东西不被当文件名）", () => {
  assert.deepEqual(
    filesOf(Buffer.from("Welcome to Ubuntu!\u0000/real/AGENTS.md\u0000ok\u0000", "utf8")),
    [],
    "脏首帧把分帧错位了 ⇒ 成对的两帧都不像路径（一个含空格一个不以 / 开头）⇒ 全部丢弃、不注入垃圾标题",
  );
  // banner 直接粘在第一帧路径前面（无 NUL 分隔）：该帧被丢，后面的内容帧也不再配对得上
  assert.deepEqual(filesOf(Buffer.from("Welcome!\n/real/AGENTS.md\u0000real content\u0000", "utf8")), []);
  for (const bad of ["relative/AGENTS.md", "/with\nnewline/AGENTS.md", "", "/with\rcr/AGENTS.md"]) {
    assert.deepEqual(filesOf(Buffer.from(`${bad}\u0000content\u0000`, "utf8")), [], JSON.stringify(bad));
  }
});

test("NUL 分帧解析：路径/内容成对，空内容与尾部空段都处理正确", () => {
  assert.deepEqual(filesOf(framed([["/a/AGENTS.md", "A"], ["/b/AGENTS.md", ""]])), [
    { path: "/a/AGENTS.md", content: "A" },
    { path: "/b/AGENTS.md", content: "" },
  ]);
  assert.deepEqual(filesOf(Buffer.alloc(0)), []);
  assert.deepEqual(filesOf(Buffer.from("\u0000", "utf8")), [], "只有分帧符 = 没有文件");
  assert.deepEqual(
    filesOf(Buffer.from("/孤儿路径\u0000", "utf8")),
    [{ path: "/孤儿路径", content: "" }],
    "路径后被截断 ⇒ 与「内容为空文件」的帧完全同形（分帧本身区分不了），当一个空文件（无害）",
  );
});

test("远端命令：用 -r 而不是 -f 判读得出，读不出时发 SOH 标记帧", () => {
  const command = buildContextCommand(["/home/u"]);
  assert.ok(command.includes('[ -r "$f" ]'), "先判存在、再判读得出");
  assert.ok(command.includes(`printf '\\001%s\\000' "$f"`), "读不出时发带 SOH 前缀的标记帧");
});

test("NUL 分帧解析：SOH 标记帧进 unreadable、不进 files（与「真·空文件」可区分）", () => {
  const unreadable = `${UNREADABLE_FRAME_PREFIX}/home/u/AGENTS.md\u0000\u0000`;
  assert.deepEqual(parseContextFiles(Buffer.from(unreadable, "utf8")), { files: [], unreadable: ["/home/u/AGENTS.md"] });
  // 空的真文件仍然是合法文件（既有语义不变）
  assert.deepEqual(parseContextFiles(Buffer.from("/home/u/AGENTS.md\u0000\u0000", "utf8")), {
    files: [{ path: "/home/u/AGENTS.md", content: "" }],
    unreadable: [],
  });
  // 脏路径帧既不当文件也不当 unreadable
  assert.deepEqual(parseContextFiles(Buffer.from(`${UNREADABLE_FRAME_PREFIX}relative/x\u0000\u0000`, "utf8")), { files: [], unreadable: [] });
});

test("取上下文：链上有候选读不出 ⇒ 整条请求 ok:false（fail-closed，绝不静默少注入）", async () => {
  const { exec } = makeExec(() => ({
    stdout: Buffer.from(`${framed([["/home/u/AGENTS.md", "home 约定"]]).toString("utf8")}${UNREADABLE_FRAME_PREFIX}/home/u/docs/AGENTS.md\u0000\u0000`, "utf8"),
  }));
  const capability = createRemoteContextCapability({ resolve: async () => TARGET, exec });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.equal(outcome.ok, false, "外层可读也不交付：读不出的那份才是最该生效的约定");
  assert.match(outcome.ok === false ? outcome.message : "", /读不出/);
});

test("取上下文：成功路径——一趟 ssh，头部层级在前（由外向内）", async () => {
  const { exec, calls } = makeExec(() => ({
    stdout: framed([
      ["/home/u/AGENTS.md", "home 约定"],
      ["/home/u/docs/AGENTS.md", "docs 约定"],
    ]),
  }));
  const capability = createRemoteContextCapability({ resolve: async () => TARGET, exec });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.deepEqual(outcome, {
    ok: true,
    dir: "/home/u/docs",
    files: [
      { path: "/home/u/AGENTS.md", content: "home 约定" },
      { path: "/home/u/docs/AGENTS.md", content: "docs 约定" },
    ],
  });
  assert.equal(calls.length, 1, "一条祖先链只发一趟 ssh");
  assert.equal(calls[0]?.file, "ssh");
});

test("取上下文：目录类触碰把该路径自身当锚点（ls 不丢自己那一级）", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: framed([["/home/u/docs/AGENTS.md", "docs"]]) }));
  const capability = createRemoteContextCapability({
    resolve: async () => ({ remotePath: "/home/u/docs", baseDir: "/home/u", target: TARGET.target }),
    exec,
  });
  const outcome = await capability.fetchRemoteContext({ remote: "prod", path: "docs", kind: "directory" });
  assert.equal(outcome.ok && outcome.dir, "/home/u/docs");
  assert.ok((calls[0]?.args.at(-1) ?? "").includes("f='/home/u/docs'/$n"), "目录自身那一级在命令里");
});

test("取上下文：目录锚点的尾斜杠被归一", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: framed([["/home/u/docs/AGENTS.md", "docs"]]) }));
  const capability = createRemoteContextCapability({
    resolve: async () => ({ remotePath: "/home/u/docs/", baseDir: "/home/u", target: TARGET.target }),
    exec,
  });
  const outcome = await capability.fetchRemoteContext({ remote: "prod", path: "docs/", kind: "directory" });
  assert.equal(outcome.ok && outcome.dir, "/home/u/docs", "锚点不带尾斜杠");
  assert.ok((calls[0]?.args.at(-1) ?? "").includes("f='/home/u/docs'/$n"), "命令里目录被单引号包裹且不带尾斜杠");
});

test("取上下文：远端 $HOME 带尾斜杠时基准也归一（否则空链 ⇒ 相对路径静默零注入）", async () => {
  const { exec, calls } = makeExec(() => ({ stdout: framed([["/home/u/AGENTS.md", "home 约定"]]) }));
  const capability = createRemoteContextCapability({
    resolve: async () => ({ remotePath: "/home/u/docs/x.md", baseDir: "/home/u/", target: TARGET.target }),
    exec,
  });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.deepEqual(outcome, { ok: true, dir: "/home/u/docs", files: [{ path: "/home/u/AGENTS.md", content: "home 约定" }] });
  assert.equal(calls.length, 1, "归一后仍走正常一趟");
});

test("取上下文：解析失败 / 解析抛错 ⇒ ok:false（不抛，消费方据此退回提示）", async () => {
  const { exec } = makeExec();
  const thrown = createRemoteContextCapability({
    resolve: async () => {
      throw new Error("boom");
    },
    exec,
  });
  assert.equal((await thrown.fetchRemoteContext(REQUEST)).ok, false);
  const missing = createRemoteContextCapability({ resolve: async () => null, exec });
  assert.equal((await missing.fetchRemoteContext(REQUEST)).ok, false);
});

test("取上下文：ssh 传输失败 / 远端非零退出 ⇒ ok:false，不发第二次", async () => {
  const { exec, calls } = makeExec(() => ({ exitCode: 255, stderr: "ssh: Could not resolve hostname prod" }));
  const capability = createRemoteContextCapability({ resolve: async () => TARGET, exec });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1, "失败不重试（一趟就是一趟）");

  const nonZero = makeExec(() => ({ exitCode: 1, stderr: "nope" }));
  const capability2 = createRemoteContextCapability({ resolve: async () => TARGET, exec: nonZero.exec });
  assert.equal((await capability2.fetchRemoteContext(REQUEST)).ok, false);
});

test("取上下文：无文件（远端目录里没有 AGENTS.md）⇒ ok:true + 空列表（不是错误）", async () => {
  const { exec } = makeExec(() => ({ stdout: Buffer.alloc(0) }));
  const capability = createRemoteContextCapability({ resolve: async () => TARGET, exec });
  assert.deepEqual(await capability.fetchRemoteContext(REQUEST), { ok: true, dir: "/home/u/docs", files: [] });
});

test("取上下文：空链（锚点在基准之外）不发 ssh", async () => {
  const { exec, calls } = makeExec();
  const capability = createRemoteContextCapability({
    resolve: async () => ({ remotePath: "/etc/x.md", baseDir: "/home/u", target: TARGET.target }),
    exec,
  });
  const outcome = await capability.fetchRemoteContext(REQUEST);
  assert.deepEqual(outcome, { ok: true, dir: "/etc", files: [] });
  assert.equal(calls.length, 0, "没有可取的层级就不该花一趟 ssh");
});

test("握手：提供方在同步回调里填槽（emit 返回即就绪）", () => {
  const bus = createEventBus();
  offerRemoteContextCapability(bus, createRemoteContextCapability({ resolve: async () => TARGET, exec: makeExec().exec }));
  const box: { remoteContext?: unknown } = {};
  bus.emit(REMOTE_CONTEXT_CHANNEL, box);
  assert.equal(typeof (box.remoteContext as { fetchRemoteContext?: unknown } | undefined)?.fetchRemoteContext, "function");
});

test("握手：槽位已有主不覆盖（先到先得）", () => {
  const bus = createEventBus();
  const mine = { fetchRemoteContext: async () => ({ ok: true as const, dir: "/a", files: [] }) };
  offerRemoteContextCapability(bus, mine);
  const box: { remoteContext?: unknown } = { remoteContext: "别人的能力" };
  bus.emit(REMOTE_CONTEXT_CHANNEL, box);
  assert.equal(box.remoteContext, "别人的能力");
});

test("握手：盒子不是对象 ⇒ 静默忽略，回调不抛", () => {
  const bus = createEventBus();
  offerRemoteContextCapability(bus, createRemoteContextCapability({ resolve: async () => TARGET, exec: makeExec().exec }));
  assert.doesNotThrow(() => bus.emit(REMOTE_CONTEXT_CHANNEL, null));
  assert.doesNotThrow(() => bus.emit(REMOTE_CONTEXT_CHANNEL, "not-a-box"));
});

test("握手：请求形状非法 ⇒ 回 ok:false，绝不抛给消费方", async () => {
  const bus = createEventBus();
  let seen: unknown;
  offerRemoteContextCapability(bus, {
    fetchRemoteContext: async (request) => {
      seen = request;
      return { ok: true, dir: "/a", files: [] };
    },
  });
  const box: { remoteContext?: unknown } = {};
  bus.emit(REMOTE_CONTEXT_CHANNEL, box);
  const capability = box.remoteContext as { fetchRemoteContext: (r: unknown) => Promise<{ ok: boolean }> };

  for (const bad of [null, {}, { remote: "" }, { remote: "prod" }, { remote: "prod", kind: "nope" }, { remote: "prod", kind: "file", path: 42 }]) {
    const outcome = await capability.fetchRemoteContext(bad);
    assert.equal(outcome.ok, false, JSON.stringify(bad));
  }
  assert.equal(seen, undefined, "非法请求根本不该到达实现");

  const good = await capability.fetchRemoteContext({ remote: "prod", kind: "file", path: "docs/x.md" });
  assert.equal(good.ok, true);
  assert.deepEqual(seen, { remote: "prod", remotePort: undefined, path: "docs/x.md", kind: "file" });
});

test("握手：实现抛错 ⇒ 收敛成 ok:false；返回形状由消费方的结果守卫兜（本侧不重复校验）", async () => {
  const bus = createEventBus();
  offerRemoteContextCapability(bus, {
    fetchRemoteContext: async () => {
      throw new Error("boom");
    },
  });
  const box: { remoteContext?: unknown } = {};
  bus.emit(REMOTE_CONTEXT_CHANNEL, box);
  const capability = box.remoteContext as { fetchRemoteContext: (r: unknown) => Promise<{ ok: boolean }> };
  assert.equal((await capability.fetchRemoteContext({ remote: "prod", kind: "file" })).ok, false);

  // 结果形状不是本侧的职责（契约：**请求**形状由提供方守、**结果**形状由消费方守）——
  // 这里只锁「原样透传」，对应的消费方守卫见 dir-context 的 remote-context.test.ts。
  const bus2 = createEventBus();
  offerRemoteContextCapability(bus2, { fetchRemoteContext: async () => "垃圾" as never });
  const box2: { remoteContext?: unknown } = {};
  bus2.emit(REMOTE_CONTEXT_CHANNEL, box2);
  const capability2 = box2.remoteContext as { fetchRemoteContext: (r: unknown) => Promise<unknown> };
  assert.equal(await capability2.fetchRemoteContext({ remote: "prod", kind: "file" }), "垃圾");
});

test("握手：没有事件总线 ⇒ 静默跳过（扩展自身照常工作）", () => {
  assert.doesNotThrow(() => offerRemoteContextCapability(undefined, { fetchRemoteContext: async () => ({ ok: true, dir: "/a", files: [] }) }));
});
