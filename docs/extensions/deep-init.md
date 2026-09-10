# deep-init — /deep-init 层级 AGENTS.md 深度初始化

> last verified @ 0260f89

## 职责与边界

- `/deep-init` 为目标仓库生成层级知识库：根 AGENTS.md + 按复杂度评分选出的子目录 AGENTS.md。
- 插件本体是提示词驱动 thin 封装：只做参数解析、已有文件预检、`--create-new` 确认门控；四阶段（Discovery→Scoring→Generate→Review）由主 agent 按下发的提示词执行。
- **不做**：插件自己不派子 pi 进程、不删文件、不硬依赖 LSP/ast-grep——删除与落盘都由主 agent 在提示词约束下完成。
- 已有知识文件识别 AGENTS.md 与 CLAUDE.md 两种（`findExistingAgentsMd` 一视同仁）。

## 文件地图

- 单文件 `index.ts`（约 400 行）+ `index.test.ts` + 带 `pi.extensions` 清单的 package.json + tsconfig；纯目录复制即可被 pi 加载。审批门读取在同目录 `solo-gate.ts`（只读，fail-closed）。
- `index.ts` 三段结构：纯函数（parse / clamp / gate / prompt / report / planDispatch）→ 运行时适配器（createNodeScanner / getGitInfo）→ 扩展工厂 `createDeepInitExtension`。
- 四阶段提示词全部内联在 `buildDeepInitPrompt` 模板字符串里——评分权重表、选址规则（>15 建 / 8–15 有独立领域才建 / <8 跳过）、生成格式都是提示词文本而非代码；改四阶段语义 = 改这个字符串。
- `DeepInitDeps`（index.ts）注入 scanner / cwd / nowIso / gitInfo，是唯一测试端口。

## 核心数据流

1. `/deep-init <args>` → `parseDeepInitArgs`（纯函数）→ `findExistingAgentsMd` 扫描目标树（BFS，跳过 node_modules / .git）。
2. `planDispatch` 纯决策三出口：help / blocked（create-new 撞已有文件且无 --yes）/ dispatch；solo 激活时 confirm-required 自动放行（notice 标注“solo 已自动确认”，见 `docs/cross/solo-approval-gate.md`）。
3. dispatch → `pi.sendMessage({ customType: "deep-init-start", deliverAs: "followUp", triggerTurn: true })`，提示词带 generatedAt / commit / branch 元信息。
4. 主 agent 执行四阶段：Discovery 按仓库规模并行派 subagent（每路只 REPORT 不写盘，<100 文件可减派直做）→ 评分选址 → 主 agent 串行 edit/write 落盘（单写者）→ Review 压缩复核 → 照发完成报告。

## 不变量

- 门控 fail-closed：create-new + 已有知识文件 + 无 `--yes` ⇒ 必须拒绝（`resolveCreateGate`，index.ts）；update 模式永不删文件，此契约不可放宽。唯一例外是 solo 审批门：`planDispatch(..., { soloActive: true })` 时仅放行 `confirm-required`，其它门控失败仍拦截。
- 深度钳制 1–5、默认 3（DEFAULT/MIN/MAX_MAX_DEPTH，index.ts）；目标路径 >256 字符直接拒绝（MAX_TARGET_LENGTH）。
- 落盘铁律在提示词层：已存在用 edit、不存在用 write，绝不用 write 覆盖已有文件；`--create-new` 也是先读后删再重建。
- 已有文件回显上限 20 条（MAX_EXISTING_ECHO），超出截断——防提示词膨胀。
- 完成报告 `=== init-deep Complete ===` 是对上游 init-deep 的格式对齐契约，主 agent 必须原文照发（buildFinalReport / 提示词内约定）。
- git 元信息获取失败降级为 "unknown" 而非报错（`getGitInfo`）——元信息仅回显用，失败不阻断主流程。

## 已知坑

- cwd 快照陷阱：`createDeepInitExtension` 在工厂创建时固化 `deps.cwd ?? process.cwd()` 为 baseCwd，`/deep-init`（target="."）始终解析到该快照，不是命令调用时刻的 cwd。
- v1.1.0（319ba4f）把 Discovery 从固定 agent 数改为按规模动态加派（>100 文件每 100 加 1、monorepo 每包加 1 等）——提示词"反模式"清单明确禁止固定 agent 数与串行等待，改提示词别把这些加回去。
- node 适配器静默吞错：readDir 异常返回 undefined、isDirectory 异常返回 false（`createNodeScanner`），无权限目录被无声跳过，扫描结果偏少且无任何告警。
- 56da138：devDeps 对齐 ^0.85.1 是跟随 undici / brace-expansion 高危漏洞的传递修复——升级依赖前先 npm audit，别为方便随意降版本。
- sendMessage 失败仅 notify 吞掉（工厂内 try/catch），用户看到"已启动"但回合可能没触发；排查"没动静"先看主会话有无 deep-init-start 消息。

## 改动清单

- 必跑：`cd deep-init && npm install && npm test`（37 个）+ `npm run typecheck`；缩进 2 空格。
- 必看测试：`index.test.ts`（fakeScanner tree 字典 + planDispatch 决策断言是理解门控与三出口语义的最快路径）。
- fake 模式：按 docs/cross/deps-ports.md——fs 边界手写 fake `DirScanner`（tree Record），git / 时钟经 `DeepInitDeps` 注入 fake；纯逻辑不 fake 直接测真函数；禁止引入 mock 库。
- 改四阶段行为：先改 `buildDeepInitPrompt` 模板并同步 index.test.ts 的提示词断言，再 bump package.json 版本（当前 1.1.0）。
