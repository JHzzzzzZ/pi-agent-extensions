# 对齐：general-todo#32 — 插件组合集成测试矩阵（A+B 兼容 / A、B 独立）

- 条目：`general-todo#32` · 分支引用：`feat/composition-test-matrix`
- 日期：2026-10-11（UTC）· 参与：用户（提出 + 第 1 轮四条「按推荐」）+ agent（实测 18 个扩展的注册面、盘点现状种子）
- 状态：第 1 轮已确认；第 2 轮两条（D5/D6，见 §范围末）已写入推荐答案，待用户整体确认后过 `align`

## 意图

插件已 18 个，但它们**只在真实 pi 会话里一起跑过，没人验证过任意两两组合**。用户要的是两种性质的可执行保证：

1. **A+B 兼容**：两个插件同时加载时都能正常工作，不互相静默覆盖。
2. **A、B 独立**：A 单独加载（B 不在）时走声明好的降级路径——不崩、不静默错行为。

现状盘点（事实，2026-10-11 实测）：

- 组合面种子只有 4 个跨扩展测试：`jev-safe-gate/test/solo-gate.test.ts`（×solo-mode）、`remote-tools/test/capability.test.ts`（提供面）、`remote-tools/test/shell-composition.test.ts`（×timeout-bg）、`timeout-bg/test/index.test.ts`（消费面）。
- `tools/install-smoke.mjs` 只验证「18 个扩展能一起加载」，不验证组合语义；`npm run test:all` 的 22 套件里没有组合套件。
- 契约知识散在 `docs/cross/` 六份卡（status-bar / shell-tool-capability / solo-approval-gate / deps-ports / messages-entries / result-unions），但**没有一份说清"谁占了哪个槽"**，因此问题只能在真机上撞出来（历史事故：`widget-band` 沉底、pwr `revive()` 缺失导致 `/new` 后永久抛错）。
- 纯正则静态提取不可靠：本轮扫描中 `pi.registerTool` 的工具名与 `registerVirtualModel` **一个都没抓到**——所以方案不能建立在"自动发现"上。

## 范围

**做什么**

1. **接触面清单单源**：新增 `docs/cross/composition-surfaces.md`，逐插件声明它占用的槽位——状态键（`setStatus`）、widget 键、内置工具面（替换/包装哪个内置工具）、`pi.events` 频道（提供 / 消费）、宿主事件钩子（`pi.on` 事件名）、模型面（provider / virtual model）、命令与快捷键前缀。无注册面的插件（deep-init / typesafe / virtual-model-router 等）显式写「无」。
2. **校验器（fail-closed）**：新增 `tools/composition-surfaces.mjs`，做三件事——① 每个扩展目录都必须在表里出现（漏写即报错，绝不静默跳过）；② 表里声明的事件名/键必须在源码中能找到（正向校验，防笔误与废弃项）；③ 由表**生成 L2 配对集合**（按"共享同一接触面"取交集，不做 18² 全跑）。
3. **L1 单装套件**：新增根套件 `test/composition-standalone.test.ts` —— 每个插件单独装进临时 PI 配置目录 + 真实 `ExtensionRunner` 加载，断言注册面自洽（自己声明的键都在自己代码里）、缺别人提供的频道/工具时不抛未捕获异常、降级路径符合声明。
4. **L2 配对套件**：新增根套件 `test/composition-pairs.test.ts` —— 对校验器生成的每一对，用真实 `ExtensionRunner` + 真事件总线同时加载，跑「兼容」断言（见 §验收标准 ①–④）。
5. **L3 契约场景白名单**：关键对走真 pi 子进程 + 真模型（opt-in，沿用 install-smoke 的临时配置目录做法）：`remote-tools × timeout-bg`（远端超时转后台）、`jev-safe-gate × solo-mode`（免审批与危险门的合成）、`dir-context × 内置 read/write/edit`、`pwr × 内置 tool_call`。opt-in 未设目标时 `skip` 而非静默绿。
6. **进总门**：新套件纳入 `npm run test:all`（记为 `root:composition`），离线、无网络、无鉴权依赖；`--matrix` 形态的端到端（真 pi）仍留在 `install-smoke` 侧由人手动跑。
7. **回归网自证**：给 L2 加一个**变异用例**——故意在测试里注册一个与某插件冲突的同名槽，断言矩阵**报错**（证明它不是纸面绿）。

**明确不做什么**

- 不改任何插件的运行时行为与既有契约（除非矩阵首跑就抓到真冲突——那时单独登记条目处理，不在本条目里顺手改）。
- 不引入 npm 依赖、不引入测试框架（沿用 `node:test` + 手写 fake 的既有口径）。
- 不做 18² 全量组合、不追求穷尽；只跑"共享接触面"的对。
- 不打宿主补丁；L3 需要真模型的部分不进 CI 必跑门。
- 不把 `docs/cross/*` 已有六份卡的内容抄进新表——新表只回答"谁占了哪个槽"，细节仍指向既有卡。

**第 2 轮决策（推荐答案，待整体确认）**

- **D5 落点**：跨扩展产物不归任何插件——接触面表落 `docs/cross/composition-surfaces.md`，校验器落 `tools/composition-surfaces.mjs`，测试落仓库根 `test/`（`test/composition-standalone.test.ts` / `test/composition-pairs.test.ts`），由根 `package.json` 与 `tools/test-all.mjs` 纳入总门。
- **D6 冲突语义**：允许插件在表里声明**独占/替换关系**（例：remote-tools 声明"替换内置 `bash`"、timeout-bg 声明"消费 bash 能力频道"、solo-mode 与 jev-safe-gate 各自声明对免审批路径的影响），同装时按声明断言（谁 owner、谁消费、谁短路）；**未声明而真冲突 = 测试失败**（fail-closed），不引入"禁止同装"这一档。

## 验收标准

1. **「兼容」判据（L2 每对断言）**：① 两个插件都注册成功、无未捕获异常；② 写同一槽（状态键 / widget / 工具名）后两者行为均在，或按 `composition-surfaces.md` 声明的 owner/优先级裁决——不出现随机互相覆盖；③ **顺序无关**：先 A 后 B 与先 B 后 A 的最终可观测状态一致；④ 卸载 / 重载（`session_shutdown` → `session_start`）后无残留、可重入。
2. **「独立」判据（L1 每插件断言）**：⑤ 缺对方提供的频道 / 工具 / 槽时，走声明好的降级路径——fail-closed 给类型化错误码，或 fail-soft 静默（二者必须在表里写明是哪一种）；⑥ 不抛未捕获异常；⑦ 注册面自洽（声明的键都能在自己源码里找到）。
3. **清单完备性**：新增扩展目录而没在 `docs/cross/composition-surfaces.md` 里出现 ⇒ `tools/composition-surfaces.mjs` 报错退出非 0（错误文案给出缺失目录名与修法一行）。
4. **覆盖现状**：L2 自动生成的配对集合**必须包含**现有 4 个跨扩展测试覆盖的 4 对（jev-safe-gate×solo-mode、remote-tools×timeout-bg、remote-tools 提供面、timeout-bg 消费面）——即自动生成不得比人工现状更弱。
5. **变异自证**：注入一个假的同槽冲突用例 ⇒ L2 套件失败（矩阵能抓到真冲突，非纸面绿）。
6. **门与成本**：`npm run test:all` 纳入新套件后全绿；L1+L2 纯本地、无网络、无鉴权；单套件墙钟 ≤ 60s（超时即须拆分为"按接触面分组"的多套件）。
7. **文档同步**：`docs/INDEX.md` 路由新卡/新套件，根 `README.md` 更新测试数（唯一来源），`docs/tools/` 增 `composition-surfaces.md` 用法卡（校验器命令面、报错码、如何加新插件）。

## 人工确认

用户 2026-10-11 在会话中回复「按推荐」，确认第 1 轮四条：Q1 接触面清单落 `docs/cross/` 单表 + 正向校验；Q2 L2 按接触面交集自动生成配对、L3 用人工白名单；Q3 L1/L2 走同进程真实 `ExtensionRunner` 进 `test:all`、L3 才用真 pi 子进程 opt-in；Q4 采用 §验收标准 ①–⑦ 的「兼容 / 独立」判据。

第 2 轮 D5（落点：`docs/cross/composition-surfaces.md` + `tools/composition-surfaces.mjs` + 根 `test/` 两个套件进 `test:all`）与 D6（冲突语义：允许声明独占/替换关系并按声明断言，未声明而真冲突即测试失败，不设「禁止同装」）**已获用户确认**——用户 2026-10-11 看过本文件后回复「确认」，未提修改。

本文件即对齐结论，实现按 §范围 与 §验收标准 执行。
