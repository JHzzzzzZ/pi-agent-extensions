# agent-team-todo#67 httpProxy 环境下外部 claude 成员必挂（回环地址代理豁免）

## 意图

宿主设置 `httpProxy` 时，agent-team 派出的外部 claude 成员**必然失败**：用户的 claude 中继监听本地回环（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`），请求被强制送进 CONNECT-only 的 10899 桥 → 每次派单 405（用户 2026-09-12 真机复现）。

根因（已读宿主源码确认，非推测）：

- 宿主 `dist/core/http-dispatcher.js:38`：`applyHttpProxySettings()` 只做 `process.env.HTTP_PROXY ??= proxy; process.env.HTTPS_PROXY ??= proxy;`——**从不注入 `NO_PROXY`**。
- agent-team 子进程 env 只做「继承 + 剥 run 级键」：leader 走 `stripRunScopedEnv()`（`dispatch.ts:74`，cockpit.ts:1094 调用），成员走 `stripLeaderEnv()`（`dispatch.ts:59`）——都不合成代理豁免。用户的 NO_PROXY 缺失时，回环中继同样被代理劫持。
- QA 当初验收时驱动 env 自带 `NO_PROXY`，掩盖了该缺口（教训入 `docs/incidents.md`）。

因此扩展侧唯一可行修法（红线 8：宿主行为不满足需求 ⇒ 插件侧解决或提上游）：**在子进程 env 出口合成回环豁免**，不去 patch 宿主。

## 范围

**做什么**

1. 新增 `withLoopbackBypass(env)` helper，`stripLeaderEnv` 与 `stripRunScopedEnv` 都过它——leader、pi 成员、外部 CLI 成员三条 spawn 路径一次对齐（只改 leader 也能靠继承覆盖成员，但显式更稳、独立于继承链）。
2. 注入语义：**大小写都写**（`NO_PROXY` + `no_proxy`，Node/undici 与各 CLI 读取口径不同）；值 = 用户已有值**追加** `127.0.0.1,localhost,::1`；去重（已含项不重复写）、不覆盖显式值、用户已有值原样保留（前缀不动）。
3. 上游 issue：`applyHttpProxySettings` 应同时注入回环豁免（草案落盘 + 尝试提交；无 `gh`/无权限则把现成文本交用户手工提）。
4. 单测锁定：默认注入、不覆盖显式值、去重、大小写两份键、已有回环项时幂等（再跑不增字节）。
5. 真机验收一次（用户批准实跑）：httpProxy 已设 + NO_PROXY 缺失 + 本机 claude 中继，派一个外部 claude 成员，断言成功（用户明确同意消耗一次外部调用）。

**不做什么**

- 不做 doctor/预检告警（用户 Q3 决议：修好后子进程已可用，重复可见性属 YAGNI；如将来出现「用户要自查」的具体需求再回来加）。
- 不改宿主、不打补丁、不改 `httpProxy` 设置本身、不动 `HTTP(S)_PROXY` 的注入逻辑（`??=` 语义保留）。
- 不扩到私网段/自定义域名（本条目只解决回环；用户显式配置其他豁免照旧走 env）。
- 不改外部 CLI 成员的其他待定项（`agent-team-todo#64` 独立跟进）。

## 验收标准

1. 单测（先红）：无 NO_PROXY 时 ⇒ 两个键都注入且含 `127.0.0.1,localhost,::1`；已有用户值 ⇒ 追加且原值未改；已含回环项 ⇒ 不重复追加；只设了小写 ⇒ 大写补齐且不覆盖小写内容。
2. 三条 spawn 路径都带豁免：leader（cockpit `leaderEnv`）、pi 成员（`stripLeaderEnv()`）、外部成员（同出口）各有断言。
3. 零回归：`stripLeaderEnv`/`stripRunScopedEnv` 原有剥键语义与既有测试不变；`npm test` 全绿 + `npm run typecheck` 零错误。
4. 真机：httpProxy 场景下外部 claude 成员派单成功（无 405）；`httpProxy` 未设时行为与今天完全一致。
5. 文档同步：扩展 README §7（外部 CLI 成员/代理） + `docs/extensions/agent-team.md`（含 `last verified` 行） + `docs/incidents.md` 记「QA env 自带 NO_PROXY 掩盖缺口」；根 README 测试数更新。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：本轮 5 问「按建议走」——Q1 统一 helper（leader + 成员两处都接）、Q2 大小写双键 + 追加回环 + 去重不覆盖（含 `::1`）、Q3 不做 doctor 告警、Q4 提上游 issue、Q5 真机实跑一次验收。
