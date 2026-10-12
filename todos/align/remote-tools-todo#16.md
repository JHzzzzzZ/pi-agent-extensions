# 对齐：remote-tools-todo#16 — write/edit 的成功文案回灌宿主标记路径

- 条目：`remote-tools-todo#16`（priority 6）· 分支引用：`feat/remote-tools-ssh-ux`
- 日期：2026-10-12（UTC）· 参与：用户（真机实测发现）+ agent（根因核实、方案设计）
- 状态：**已对齐**（用户会话内授权按所述方案执行，与 #15 同分支）

## 意图

用户 2026-10-12 实测：带 `remote` 的 `write` / `edit` 成功之后，回给模型与用户看的文案写的是**本机形态的假路径**（形如 `C:\…\remote-tools\index.ts\pi-remote\srv\app\x.ts`），读起来像「写入到了本机某个缓存目录」——引向错误的判断（以为改动落在本机，或以为远端没写成功）。

**根因**（已核宿主 dist 源码）：宿主内置定义把**入参 `path` 原样**插进文案与补丁：

- `write.js:50` — `` `Successfully wrote to ${path}` ``
- `edit.js:134` — `` `Successfully replaced N block(s) in ${path}.` ``
- `edit.js:112` 与 `edit-diff.js` 的一族报错同样插值 `path`
- `edit.js:129` — `generateUnifiedPatch(path, path, …)` ⇒ `details.patch` 的 `---` / `+++` 头也带假路径

而 remote-tools 为了让宿主本地的 `path`/`fs` 管线不炸（盘符注入、`withFileMutationQueue` 的 `realpath`），**必须**把远端路径换成标记形态（`paths.ts` 的设计）⇒ 标记形态顺着宿主模板进了文案。`#10` 修的是 ls/find 的**错误**文案，成功文案这条路径当时没覆盖；`read.js:139` 的「行太大」提示是同族漏点。

## 范围

**做什么**

1. **结果改写**（远端分支）：把宿主标记形态路径（= 我们传给内置定义的那个字符串）逐字换回远端绝对路径，作用于 content 文本块与 `details.patch` / `details.diff`。
2. **报错改写**（远端分支）：执行期抛出的 `Error` 文本（`Could not edit file: …` / `Could not find the exact text in …` / `No changes made to …` 等）同样换回远端路径后再抛。
3. `read` 远端分支共用同一改写（`read.js:139` 的 oversize 提示）。
4. 改写 helper 落在 `paths.ts`（宿主形态 ↔ 远端形态换算的唯一出口）：纯字符串映射，无 ssh、无新依赖、无状态。
5. 文档：`docs/extensions/remote-tools.md` 补一条口径（远端分支的结果/错误文案一律展示远端真实路径），`last verified` 更新。

**明确不做什么**

- 不改宿主 `dist/`（红线 8），不做宿主侧补丁；上游没有「展示路径与执行路径分离」的 API，所以只能事后改写文本。
- 不动本地分支**一个字**（「本地零行为漂移」是整套覆盖策略的根前提；测试用同参数对拍宿主原实现）。
- 不泛化到「把 bash 输出里的本机路径也换掉」——本次只修**我们自己插进去**的那个假路径。
- 不改渲染器（TUI 用的是模型给的入参，本来就是远端路径，已正确）。

## 验收标准

1. 远端 `write` 成功文案 = `Successfully wrote to /srv/app/x.ts`：含远端绝对路径，**不含** `pi-remote` 标记、不含盘符形态。
2. 远端 `edit` 成功文案同理；`details.patch` 的 `---` / `+++` 行是远端路径。
3. 远端 `edit` 失败（oldText 不匹配 / 文件不存在）的报错消息里是远端路径。
4. **本地分支逐字不变**：同参数分别打我们的定义与宿主 `createWriteToolDefinition` / `createEditToolDefinition`，结果文本与 details 完全一致。
5. 新增单测锁定 1–4；`remote-tools` 全量测试绿、`npm run typecheck` 零错误（全仓 `test:all` 除已知并发抖动外全绿）。
6. 跨厂商评审（红线 11）终轮无新意见。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-12 · **方式**：agent 在会话内说明「#16 无待决策、与 #15 同分支一起做」后，用户回复 **「A」** 授权开工；对 #16 的方案未提出异议。若与预期不符，按 `reopen` 退回重议。
- **agent 提请注意的一处**：改写锚点是**我们传进内置定义的那个字符串**——宿主是原样插值（已核 `write.js:50` / `edit.js:129,134`），所以这是精确替换，不是「猜文案格式」的启发式；代价是宿主若改文案格式，本改写仍需保证不漏（测试用真实宿主实现跑，宿主升级即暴露）。
- **已确认的默认口径**：只改远端分支；不改宿主；只修我们自己注入的假路径，不泛化改写 bash 输出。
