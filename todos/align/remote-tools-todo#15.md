# 对齐：remote-tools-todo#15 — 首次连接新主机不再需要手工 ssh

- 条目：`remote-tools-todo#15`（priority 5）· 分支引用：`feat/remote-tools-ssh-ux`
- 日期：2026-10-12（UTC）· 参与：用户（提出摩擦、选定机制）+ agent（根因核实、方案设计）
- 状态：**已对齐**（用户选定方案 A = `StrictHostKeyChecking=accept-new`）

## 意图

用户 2026-10-12 反映：带 `remote` 的调用在**一台没连过的新主机**上第一次必然失败，必须先在本机终端手工 `ssh user@host` 一次（或手工 `ssh-keyscan` 写 `known_hosts`）把指纹放进 `known_hosts` 才能用，这一步是纯摩擦；问「能不能去掉、有没有办法」。

**根因**：`ssh.ts:92` 的 `buildSshArgs` 写死 `StrictHostKeyChecking=yes`，配合 `BatchMode=yes`（无 TTY）⇒ 未知指纹直接 `SSH_CONNECT_FAILED`。这不是疏漏，是 v1 刻意选的安全姿态（`docs/specs/remote-tools.md`、`docs/extensions/remote-tools.md`、`README.md` 三处都写明「绝不 accept-new」）。

**用户决策**：方案 A —— 改 `StrictHostKeyChecking=accept-new`。

## 范围

**做什么**

1. `buildSshArgs` 的 `StrictHostKeyChecking=yes` → `accept-new`（OpenSSH ≥7.6 的 TOFU：未知主机首次自动写入 `known_hosts`；**指纹变更仍然拒绝**）。
2. 失败分类与文案同步：`classifySshFailure` 的 stderr 匹配补上指纹变更的原文（`REMOTE HOST IDENTIFICATION HAS CHANGED`，保留 `Host key verification failed`）；消息模板去掉「请先在终端手工 ssh 一次」，改为「指纹变更 / 认证失败 / 网络不可达」的排查方向。
3. 口径三处同步：`docs/extensions/remote-tools.md`（已知主机指纹那节 + `last verified`）、`README.md`（前置条件）、`docs/specs/remote-tools.md`（传输一节）；`ssh.ts` / `index.ts` 文件头注释里「不自动 accept-new」的依据改写成新口径。
4. 测试：`ssh.test.ts` 的 argv 断言改为 `accept-new`（防回退）；真机用例（opt-in）证明「干净 `known_hosts` 下首次连接成功、且条目由 ssh 自己写入」。

**明确不做什么**

- 不自动跑 `ssh-keyscan` 再自行写入：那是自己抓公钥自证，安全强度不比 TOFU 高，还多一条外部命令与一份自己维护的 `known_hosts` 写逻辑。
- 不改用户 `~/.ssh/config`、`known_hosts`、`~/.ssh/` 下任何文件（红线 8；条目写入由 ssh 进程自己完成）。
- 不加「回退 `yes`」的开关（原方案 C）：当前只有一种使用场景，属投机配置；且命令行 `-o` 优先级高于 `ssh_config`，`ssh_config` 盖不住，真需要更强姿态时按本条目 `reopen` 重议。

## 验收标准

1. **零前置步骤**：干净 `known_hosts` 的目标主机上，第一次带 `remote` 的调用成功，不需要任何人工命令。
2. **指纹变更仍 fail-closed**：主机密钥变化时调用失败并报 `SSH_CONNECT_FAILED`，消息含「指纹变更」的排查方向，且不再出现「先手工 ssh」的旧指示。
3. **argv 锁定**：`ssh.test.ts` 断言 `-o StrictHostKeyChecking=accept-new`（防止无声回退到 `yes`）。
4. **真机证据**：opt-in 用例用**临时 `UserKnownHostsFile`** 打本机 sshd ⇒ 退出码 0 且临时文件里出现该主机条目（证明 `accept-new` 语义在真实 ssh 客户端上成立，不是纸面断言）。
5. **文档一致**：三处口径不再出现「绝不 accept-new」，`last verified` 指向本变更 commit。
6. 单测 + `npm run typecheck` 绿；跨厂商评审（红线 11）终轮无新意见。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-12 · **方式**：对话内回答 **「A」**。
- **agent 提请注意**：这是翻一条 v1 明确写下的安全姿态（fail-closed → TOFU）。代价 = 首次连接不校验对端身份（中间人只可能在「首次连接且用户不知情」这一窗口内成立）；换取零前置步骤。指纹**变更**仍拒绝，第二道门不松。
- **已确认的默认口径**：不自动 `ssh-keyscan`、不加开关、不动用户 `~/.ssh` 下任何文件。
