/**
 * remote-context.ts 单测：远端上下文的**消费方**（能力握手 + 请求/结果形状守卫）。
 *
 * 边界：纯逻辑 + 宿主真实 `EventBus`（`createEventBus`，不 fake——握手成败全在它的同步派发语义上）。
 * 「取文件」是提供方的事（remote-tools 的 context.ts 有自己的测试），这里只锁「拿回来的东西能不能用、
 * 垃圾怎么降级」——对端是别的扩展，一律当不可信。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  collectRemoteContext,
  REMOTE_CONTEXT_CHANNEL,
  toContextFiles,
  type RemoteContextCapability,
  type RemoteContextOutcome,
} from "../remote-context.ts";

const OK_OUTCOME: RemoteContextOutcome = { ok: true, dir: "/home/u/docs", files: [{ path: "/home/u/docs/AGENTS.md", content: "docs 约定" }] };

function capabilityReturning(outcome: unknown): RemoteContextCapability {
  return { fetchRemoteContext: async () => outcome as RemoteContextOutcome };
}

/** 广播一次并返回拿到的能力（模拟 dir-context 在 session_start 的握手）。 */
function handshake(fill: (box: Record<string, unknown>) => void): ReturnType<typeof collectRemoteContext> {
  const bus = createEventBus();
  bus.on(REMOTE_CONTEXT_CHANNEL, (box) => fill(box as Record<string, unknown>));
  return collectRemoteContext(bus);
}

test("握手：没有事件总线 ⇒ 没有能力、没有警告（扩展照常工作）", () => {
  assert.deepEqual(collectRemoteContext(undefined), { capability: null, warning: null });
});

test("握手：没有提供方（没装 remote-tools）⇒ 没有能力、没有警告（静默退回提示行）", () => {
  const offer = handshake(() => {});
  assert.deepEqual(offer, { capability: null, warning: null });
});

test("握手：提供方在同步回调里填槽 ⇒ collect 返回时能力已就绪", () => {
  const offer = handshake((box) => {
    box.remoteContext = capabilityReturning(OK_OUTCOME);
  });
  assert.notEqual(offer.capability, null);
  assert.equal(offer.warning, null);
});

test("握手：载荷畸形 ⇒ 当作没有能力 + 一条警告（不抛、不破坏会话）", () => {
  for (const payload of [null, 42, "capability", {}, { fetchRemoteContext: "不是函数" }]) {
    const offer = handshake((box) => {
      box.remoteContext = payload;
    });
    assert.equal(offer.capability, null, JSON.stringify(payload));
    assert.match(offer.warning ?? "", /畸形/);
  }
});

test("握手：事件总线抛错 ⇒ 当作没装对端 + 一条警告", () => {
  const bus = { emit: () => { throw new Error("bus down"); }, on: () => () => {} };
  const offer = collectRemoteContext(bus as never);
  assert.equal(offer.capability, null);
  assert.match(offer.warning ?? "", /协商失败/);
});

test("结果守卫：实现对端抛错 / 返回垃圾 ⇒ 收敛成 ok:false（消费方据退回提示行）", async () => {
  const throwing: RemoteContextCapability = {
    fetchRemoteContext: async () => {
      throw new Error("boom");
    },
  };
  const offer = handshake((box) => {
    box.remoteContext = throwing;
  });
  assert.equal((await offer.capability!.fetchRemoteContext({ remote: "prod", kind: "file" })).ok, false);

  for (const junk of [null, "垃圾", 42, { ok: true }, { ok: true, dir: "/a" }, { ok: false }]) {
    const junkOffer = handshake((box) => {
      box.remoteContext = capabilityReturning(junk);
    });
    const outcome = await junkOffer.capability!.fetchRemoteContext({ remote: "prod", kind: "file" });
    assert.equal(outcome.ok, false, JSON.stringify(junk));
  }
});

test("结果守卫：files 里的垃圾条目被逐条过滤，好条目照收", async () => {
  const offer = handshake((box) => {
    box.remoteContext = capabilityReturning({
      ok: true,
      dir: "/home/u/docs",
      files: [{ path: "/good/AGENTS.md", content: "好的" }, null, { path: 42, content: "x" }, { path: "", content: "x" }, { path: "/no-content/AGENTS.md" }],
    });
  });
  const outcome = await offer.capability!.fetchRemoteContext({ remote: "prod", kind: "file" });
  assert.deepEqual(outcome, { ok: true, dir: "/home/u/docs", files: [{ path: "/good/AGENTS.md", content: "好的" }] });
});

test("注入条目：去重键带 remote: 前缀、展示名带来源、本地与远端两个命名空间不撞车", () => {
  const files = toContextFiles("prod", [
    { path: "/srv/app/AGENTS.md", content: "远端" },
    { path: "/srv/app/docs/AGENTS.md", content: "远端子目录" },
  ]);
  assert.deepEqual(files, [
    {
      absolutePath: "remote:prod\u0000/srv/app/AGENTS.md",
      relativePath: "prod:/srv/app/AGENTS.md",
      sourcePath: "/srv/app/AGENTS.md",
      remote: "prod",
      content: "远端",
    },
    {
      absolutePath: "remote:prod\u0000/srv/app/docs/AGENTS.md",
      relativePath: "prod:/srv/app/docs/AGENTS.md",
      sourcePath: "/srv/app/docs/AGENTS.md",
      remote: "prod",
      content: "远端子目录",
    },
  ]);
  // 块头 `path=` 用远端绝对路径（不带 host）：`Loaded` 行才是带来源的展示名。
  assert.equal(files[0]?.sourcePath, "/srv/app/AGENTS.md");
  // 关键不变量：同一台机的远端路径与本机绝对路径在字符串上可能一模一样，
  // 去重键必须分属两个命名空间（本地键就是裸绝对路径）。
  assert.notEqual(files[0]?.absolutePath, "/srv/app/AGENTS.md");
});

test("注入条目：`user@host` 原样带进展示名与 remote 属性（来源要能让模型看懂）", () => {
  const files = toContextFiles("user@10.0.0.1", [{ path: "/home/u/AGENTS.md", content: "x" }]);
  assert.equal(files[0]?.relativePath, "user@10.0.0.1:/home/u/AGENTS.md");
  assert.equal(files[0]?.remote, "user@10.0.0.1");
});
