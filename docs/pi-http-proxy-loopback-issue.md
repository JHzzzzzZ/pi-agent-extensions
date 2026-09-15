# 宿主 httpProxy 不注入 NO_PROXY：本地回环请求被代理劫持（上游 issue 稿；本地不打补丁）

> **本仓库不修改宿主安装目录**（规则见 `AGENTS.md`「仓库边界」）：本文只保留问题描述与上游 issue 草稿，
> 扩展侧只在自家子进程 env 出口兜底（`docs/extensions/agent-team.md`「子进程回环代理豁免（v1.30.0，#67）」）。
> 上游目标：`@earendil-works/pi-coding-agent`（本仓库以 **0.85.1** 复现）。

## 症状

宿主设置 `httpProxy`（`~/.pi/agent/settings.json` 的 `httpProxy: "http://127.0.0.1:10899"`）后，任何**访问本地回环地址**的子进程链路都被迫走代理：

- 用户的 claude 中继监听 `http://127.0.0.1:15721`（`ANTHROPIC_BASE_URL` 指向它，由转发/中继工具提供），
  claude CLI 的请求被代理接管；
- 该代理是 **CONNECT-only** 桥（本地桥接 v2rayN 一类），对明文 HTTP 的回环请求直接拒绝 →
  **agent-team 派出的外部 claude 成员每次派单 405 CONNECT only**（2026-09-12 真机复现，同 run 的
  codex 成员与 pi 成员正常）；
- 用户在 shell 里手动 `export NO_PROXY=127.0.0.1,localhost` 后一切正常——即缺口只在「宿主注入代理、
  但没人注入豁免」时出现。

## 根因（宿主行为，非扩展问题）

`dist/core/http-dispatcher.js:38`（0.85.1，`dist/main.js:455` / `dist/main.js:685` 两处调用）：

```js
export function applyHttpProxySettings(httpProxy) {
    const proxy = httpProxy?.trim();
    if (!proxy)
        return;
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
}
```

只 `??=` 注入 `HTTP_PROXY` / `HTTPS_PROXY`，**从不注入 `NO_PROXY` / `no_proxy`**。而 Node/undici
（`EnvHttpProxyAgent`）与绝大多数 HTTP 客户端（curl、Go、各语言 SDK、各 CLI 自带的 fetch 栈）都靠
`NO_PROXY` 决定哪些主机直连——宿主只设代理不设豁免，等于把一个「回环地址必须直连」的常识判断推给每个
客户端和每个扩展。用户没在自己 shell 里配 `NO_PROXY` 时，本地中继必然被代理吃掉。

## 建议修复（宿主侧）

`applyHttpProxySettings` 注入代理的同时补上回环豁免，口径与代理一致（`??=` 语义：不覆盖用户显式值）：

```js
const LOOPBACK_BYPASS = ["127.0.0.1", "localhost", "::1"];

function addLoopbackBypass() {
  for (const key of ["NO_PROXY", "no_proxy"]) {          // 两个大小写键都写：读取口径不同
    const existing = process.env[key]?.trim();
    if (!existing) {
      process.env[key] = LOOPBACK_BYPASS.join(",");
      continue;
    }
    const entries = existing.split(",").map((entry) => entry.trim().toLowerCase());
    const missing = LOOPBACK_BYPASS.filter((host) => !entries.includes(host));
    if (missing.length > 0) process.env[key] = `${existing},${missing.join(",")}`;
  }
}
```

要点：① 两个大小写键都写（curl 优先小写、Go 优先大写）；② 已有值**只追加缺失项**（去重、显式值
逐字节保留、重复调用幂等）；③ `::1` 一并覆盖，避免 IPv6 回环绕过豁免。

## 扩展侧现状（为什么本仓库不改宿主）

agent-team 在自己的子进程 env 出口合成同样的豁免（`src/extensions/agent-team/dispatch.ts`
`withLoopbackBypass`，v1.30.0，#67），因此本仓库的用户不再受影响；但**其它扩展、其它宿主内链路
（含宿主自身的本地工具/插件发起 fetch）仍会踩到同一缺口**，修复仍应由宿主承担。

## 上游 issue 草稿（建议提交给 @earendil-works/pi-coding-agent）

**Title**: `applyHttpProxySettings` should also set `NO_PROXY` for loopback hosts

**Body**:

With `httpProxy` configured, the host injects `HTTP_PROXY` / `HTTPS_PROXY` but never `NO_PROXY`
(`dist/core/http-dispatcher.js`, `applyHttpProxySettings`). Every child process then sends loopback
requests through the proxy.

Concretely: a user runs a local relay on `http://127.0.0.1:15721` and points `ANTHROPIC_BASE_URL`
at it (a common setup — relay/proxy tooling that forwards to the upstream API). Because the
configured proxy is a CONNECT-only bridge (e.g. v2rayN via a local bridge), plain-HTTP loopback
requests are refused and every dispatch of a claude-backed sub-agent fails with
`405 CONNECT only`. Adding `NO_PROXY=127.0.0.1,localhost` to the shell fixes it — i.e. the host
injects the proxy but leaves the well-known "loopback must be direct" exception to every client.

Suggested fix: in `applyHttpProxySettings`, after setting the proxy vars, merge loopback hosts into
`NO_PROXY` **and** `no_proxy` (different clients read different casings), preserving any explicit
user value and only appending missing entries:

```js
process.env.HTTP_PROXY ??= proxy;
process.env.HTTPS_PROXY ??= proxy;
for (const key of ["NO_PROXY", "no_proxy"]) {
  const existing = process.env[key]?.trim();
  const entries = (existing ?? "").split(",").map((e) => e.trim().toLowerCase());
  const missing = ["127.0.0.1", "localhost", "::1"].filter((h) => !entries.includes(h));
  if (missing.length > 0) process.env[key] = existing ? `${existing},${missing.join(",")}` : missing.join(",");
}
```

Happy to open a PR if you agree with the direction.
