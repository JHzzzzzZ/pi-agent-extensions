# 对齐：remote-tools-todo#7 — 宿主标记路径的前提硬化（信道不再靠「本地恰好不存在」）

- 条目：`remote-tools-todo#7`（tags: `bugfix`）· 分支引用：`fix/remote-tools-marker-image`
- 日期：2026-10-10（UTC）· 参与：用户（选型与放行）+ agent（事实核查、实测与方案）
- 状态：用户已选定方案 C'（下方「人工确认」），待 `align` 过后进入 `processing`

## 意图

`remote-tools` 的路径信道（把远端路径编码成宿主本地路径形态交给内置工具）此前押在一条**不可执行的约定**上：
「本机一定不存在这个标记根」。约定被打破时（本地真存在 `C:\pi-remote`），宿主的本地文件系统调用会命中真实文件：
`resolveReadPathAsync` 的变体探测（原路径 → AM/PM 窄空格 → NFD → 弯引号，全部用**本地** `accessSync`）会把远端读取的
文件名换成变体名，**静默读错文件**；且该路径不再以 ENOENT 失败，设计的 fail-closed 归因随之失真。

本次要把这条约定从「测试断言」变成**结构性保证 + 被执行的检查**：标记根锚在扩展目录里一个**已存在的普通文件**下面
（`<插件目录>/index.ts/pi-remote`），只要 `index.ts` 还是普通文件，本机就**建不出**这个目录（实测 Windows：
`mkdir -p` 报 `ENOTDIR`，`realpath` 报 `ENOENT`）；再加一个运行时守卫兜住「锚文件被换成目录」这一种破坏方式。
模型侧契约（`path` 仍是远端绝对 POSIX 路径 + `remote`/`remotePort`/`remoteCwd`）不变——标记形态是内部实现细节。

已实测的事实（本机 Windows / Node 22.23.1，均为只读探针）：

1. `fs.realpathSync(<ext>/index.ts/pi-remote)` → `ENOENT`（含深层带弯引号的文件名样本、含 345 字符长路径样本）；
   `withFileMutationQueue` 的 `getMutationQueueKey` 只容忍 `ENOENT`/`ENOTDIR`，此形态两处都过。
2. `fs.mkdirSync(<ext>/index.ts/pi-remote, { recursive: true })` → `ENOTDIR`（**本地不可能存在标记根**，这就是结构性证据）。
3. 宿主对工具路径的本地副作用只有两处（读宿主 `dist/core/tools` 源码确认）：`path-utils.js` 的 `accessSync`（`fileExists`
   吞掉一切错误）、`file-mutation-queue.js` 的 `realpath`（只容忍 ENOENT/ENOTDIR）；`read.js` 的图片嗅探、`ls`/`find` 的默认
   ops 都已被我们替换或与本议题无关。
4. 宿主 `utils/paths.js` 的 `normalizePath` 只做 unicode 空格替换 / `@` 前缀剥离 / win32 盘符改写，**不做** Unicode NFC/NFD
   归一——标记根里的中日韩字符不会被改写（跨平台前缀匹配仍需大小写与分隔符归一，见范围）。
5. `path.relative` 在跨盘符时返回目标绝对路径、同盘符时返回相对路径——两种形态都仍带标记（前缀剥离按「绝对标记根前缀」实现）。

## 范围

**做什么**

1. 标记根改为 `<插件目录>/index.ts/pi-remote`（两平台同一形态；由 `import.meta.dirname` 运行时求值，删掉写死的盘符探测
   `hostDrive()`）。`toHostPath` / `stripHostMarker` 都按这个根实现；`HOST_PATH_MARKER` 常量保留（标记段名不变，
   `assertModelPathInput` 的输入护栏继续拒「首段是 `pi-remote`」的模型输入）。
2. 运行时守卫（fail-closed）：远端调用前检查锚文件仍是普通文件，否则报专码 `HOST_MARKER_CONFLICT` 并提示重装/恢复扩展目录；
   本地分支零影响（不 stat、不触网）。
3. 测试：`realpath(标记根) ∈ {ENOENT, ENOTDIR}`（典型 + 深层 + 长路径样本）；`mkdir(标记根)` 必须失败（结构性断言）；
   round-trip/剥离/护栏的既有断言跟着新根更新；守卫的 fail-closed 用例（锚文件不是普通文件 ⇒ 专码、零 ssh）。
4. 文档同步：ADR 0010 决策 3 落定（C' 取代 A+B'，写明 B' 的 `?` 方案不再采用）、`docs/extensions/remote-tools.md` 卡片、
   扩展 README（删掉「本机不得存在 `C:\pi-remote`」的用户前提，换成锚文件说明）、根 README 测试数、AGENTS.md 测试数。

**明确不做什么**

- 不做 R1（整份重写、脱离宿主命名空间）——保真是本特性立身之本，重写要另立条目重新对齐。
- 不改模型面契约、不改本地分支行为、不动宿主 `dist/`、不引入运行时常量配置（YAGNI）。
- 不追求 POSIX 上的「数学不可能」（POSIX 无非法字符可用）；本方案用「锚在普通文件下」取得两平台同等级的结构性保证。

## 验收标准

1. **结构性**：`fs.realpath(标记根)` 的错误码 ∈ {`ENOENT`, `ENOTDIR`}（绝不是 `UNKNOWN`/`EACCES`/`ENAMETOOLONG`），
   且 `fs.mkdir(标记根, { recursive: true })` 必须抛错——两个断言都能在 Windows 与 POSIX 上跑。
2. **守卫**：锚文件不是普通文件时，任一远端调用在**发 ssh 之前** fail-closed 报 `HOST_MARKER_CONFLICT`；
   `remote` 为空的本地调用不受影响（零 ssh、零本地 stat）。
3. **行为不回归**：既有 62 个单测（含本地保真对照、Windows 路径往返、输入护栏、采样器噪声、缺省值字面量）保持绿；
   真机 6/6 回归通过；`npm run typecheck` 零错误。
4. **文档一致**：ADR 决策 3 状态更新、卡片与 README 不再出现「本机不得存在 `C:\pi-remote`」这类已失效前提，
   根 README / AGENTS.md 的测试数与实际一致。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：对话内选择 + 指示一并修复另一条问题
- **逐条决策**：
  1. 方案 = **C'**（用户原话「走2」，即“把标记根锚在插件目录里一个已存在的普通文件下面”那条），
     取代此前的 `A+B'`（`?` 非法字符只覆盖 Windows 且不再必要）。
  2. 形状 = `<插件目录>/index.ts/pi-remote`（保留 `pi-remote` 标记段；不采用 `<插件目录>/pi-remote` 这种
     「只是不太可能被占用」的形态）。
  3. 守卫（原 A）作为**兜底保留**：只检查锚文件仍是普通文件，成本 ≤10 行。
  4. 交付纪律：worktree 实现、TDD 测试先行、跨厂商评审到无新意见、文档四处同步（用户原话「记得改相关文档」）。
- **已知取舍（显式接受）**：标记根路径比 `C:\pi-remote` 长 ~90 字符（Windows 长路径样本已实测为 ENOENT，不引入新错误码）；
  标记根随安装形态变化（全局 / 包缓存 clone / 项目 `.pi/extensions/`），单测不再断言常量前缀。
- **开工放行**：用户在本轮会话已给出实施指示（「走2」），登记与对齐文档落盘后进入 `processing`。
