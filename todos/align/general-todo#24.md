# 对齐：general-todo#24 — package-lock.json 的 version 字段与 package.json 漂移

- 条目：`general-todo#24`（tags: 仓库卫生，priority 4）· 分支引用：`feat/general-lock-drift`
- 日期：2026-10-11（UTC）· 参与：用户（本会话「都做」授权开工）+ agent（实测收敛范围、发现本轮已被撞两次）
- 状态：**已对齐**（用户「都做」授权；落点未指定 ⇒ 按本节声明的默认 (A) 执行，如需 (B) 请直接说）

## 意图

`package-lock.json` 顶层的 `version` 与 `packages[""].version` 落后于同目录 `package.json` 的 `version`。同级 `"": { "version": … }` 字段本应镜像 `package.json`，漂移后**任何人跑一次 `npm install` 都会顺手改这些 lock**：

- `tools/test-all.mjs --install` 会改（它给每个扩展跑 `npm install`）；
- 每次装依赖（如新增测试文件前）也会改。

后果是**无关改动混进 diff**，交付时必须逐个 `git checkout` 回滚，否则会挡住并行会话的工作区。

**本轮已实测撞到两次**（都是 agent 自己）：`feat/dir-context-remote-context`（#6）与 `feat/dir-context-unreadable`（#7）各带进过一次 `opencode-bridge/package-lock.json` 的漂移，两次都要额外补一个「撤掉误带」的提交。（#6 那次没发现，是评审第 3 轮才揪出来的。）

## 范围

**当前漂移实测（范围已比条目写作时收敛）**

条目原文写「至少 4 个扩展漂移」（pwr 2.9.3/2.10.0、opencode-bridge 1.7.0/1.7.1 等）。**现在只剩 1 个**——其余在别的会话的提交（`856d7bd`）里被顺手改到一致了。全仓扫描结果：

| 扩展 | package.json | lock 顶层 | lock 内层 |
|---|---|---|---|
| `opencode-bridge` | 1.7.1 | 1.7.0 ✗ | 1.7.0 ✗ |

（11 个扩展带 `package.json`，其中 10 个已一致。）

**做什么**

1. **把漂移修到一致**：在 `src/extensions/opencode-bridge/` 跑一次 `npm install`，让 lock 的顶层与内层 `version` 变成 `1.7.1`。**不动 `package.json`**——发布版本以 `package.json` 为准，lock 是派生物。
2. **加防漂移守门（条目明确要求的那半）**：新增根测试 `test/package-lock-drift.test.ts`（`node:test` + `node:assert/strict`，纯读文件、无网络、无子进程），扫描全仓每个非 `node_modules` 的 `package-lock.json`，断言：
   - 存在同目录 `package.json` 时，lock 顶层 `version` === `package.json.version`、`packages[""].version` === 同值；
   - 不存在同目录 `package.json`（纯 lock 形态）则跳过（不误报）。
   - 挂进根 `package.json`（`test:lock` 脚本）与 `tools/test-all.mjs` 的 `DEFAULT_SUITES`，使 `npm run test:all` 覆盖。
3. **文档**：`docs/tools/test-all.md`（或对应工具卡）补一句这个守门测试；根 `README.md` 测试数与命令表同步。

**明确不做什么**

- **不批量重生成所有 lock**：只剩 1 个真漂移，全量 `npm install` 会引入无意义的 lock 波动（上百行 diff，反而制造新噪声），违背本条目的本意。
- **不动任何 `package.json` 的 `version`**（这不是发版任务）。
- **不在 `tools/test-all.mjs` 里加 `--install` 后校验**：条目原文给了这个替代落点，但选它的话漂移只在「带 `--install` 跑全仓」时才可见，日常 `npm test` 看不见；根测试文件则是常规测试面，且仓库已有 `test/test-all.test.ts` 这个「元测试」先例。若你更想要前者的落点，说一声即可换。

## 验收标准

1. **漂移归零**：全仓扫描（含 `agent-manager/`）每个 `package-lock.json` 的顶层与内层 `version` 都与同目录 `package.json.version` 一致；`git diff` 里 `opencode-bridge/package-lock.json` 的改动**只有版本相关行**，没有依赖树波动。
2. **守门测试真能抓**（变异验证）：临时把某个 lock 的 `version` 改回旧值 ⇒ 新测试**红**且报得出是哪个文件/哪个字段；改回 ⇒ 绿。（防「写了个恒绿的测试」。）
3. **能抓内层漂移**：只改 `packages[""].version` 而不改顶层 ⇒ 也红。
4. **不误报**：没有同级 `package.json` 的 lock 形态不报错；`node_modules/` 下的 lock 一律不扫。
5. **接进全仓**：`npm run test:all` 里能看到这个套件；套件与用例数在根 `README.md`、`tasks`/命令注释里同步。
6. 新测试 + 相关扩展 typecheck 双绿；全仓 `test:all` 绿（`todo-cli-todo#21` 的 Windows 并发抖动除外，若仍存在）。
7. 跨厂商独立评审（红线 11）逐条处理到某轮无新意见（本条目是机械改动，预计 1 轮）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）· **方式**：对话内回答「都做」（授权两件都做，并同意先做本条）
- **需要你点头的一处选择**：防漂移守门的**落点**
  - **(A) 新增根测试 `test/package-lock-drift.test.ts` + 挂进 `test:all`**（agent 推荐）：日常 `npm test`/`test:all` 就能看见；仓库已有 `test/test-all.test.ts` 元测试先例。
  - **(B) 写进 `tools/test-all.mjs` 的 `--install` 后校验**（条目原文的备选）：只在带 `--install` 的全仓跑里生效，日常看不见。
  若你不特别指定，按 **(A)** 执行。
- **已确认的默认口径**（不另问）：lock 跟随 `package.json`（不反向降级 `package.json`）；不改任何 `package.json` 版本；不全量重生成 lock；不做发布。
