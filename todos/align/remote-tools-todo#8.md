# 对齐：remote-tools-todo#8 — 远端 read 的图片识别（补 `detectImageMimeType` 端口）

- 条目：`remote-tools-todo#8`（tags: `bugfix`）· 分支引用：`fix/remote-tools-marker-image`
- 日期：2026-10-10（UTC）· 参与：用户（实测发现与放行）+ agent（根因定位与方案）
- 状态：与 `remote-tools-todo#7` 同一变更一起交付（用户指示「一起修复」）

## 意图

用户实测：用 `read` 读**远端** PNG，结果是一屏乱码文本（`�PNG…`），而不是宿主本地 read 那样的图片块。
根因已核实：宿主 `dist/core/tools/read.js:80` 是
`const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;`
——`ReadOperations` 的这个端口是**可选**的，我们只实现了 `readFile`/`access`，于是宿主把图片当普通文本读、
进文本截断管线。`remote` 为空的本地分支用宿主默认 ops（`detectSupportedImageMimeTypeFromFile`），所以只有远端分支坏。

本条目把这个端口补上，让远端图片走宿主**同一套**图片管线（嗅探 → `processImage` → 图片块/降级文本），
且**不增加每次远端 read 的 ssh 往返**。

已核实的事实（宿主 `@earendil-works/pi-coding-agent`，路径相对该包根）：

1. 端口签名（`dist/core/tools/read.d.ts:42`）：`detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>`；
   宿主默认实现是 `detectSupportedImageMimeTypeFromFile`（`dist/utils/mime.js`），读**前 4100 字节**做魔数判定
   （JPEG 排除 `0xFF 0xD8 0xFF 0xF7` 有损 DC 帧、PNG 排除动图（`acTL` 早于 `IDAT`）、GIF87a/89a、`RIFF…WEBP`、校验过的 BMP）。
2. **只有 `detectSupportedImageMimeTypeFromFile` 从包根导出**（`dist/index.d.ts:42`）；纯 buffer 版的
   `detectSupportedImageMimeType` 未导出，且包 `exports` 只开 `.`/`./rpc-entry`/`./client`/`./experimental/plugin`
   ⇒ 深路径 import 不可用。要保真只能：把嗅探样本落到**本地临时文件**再喂给宿主导出的那个函数（不复制魔数表）。
3. 宿主的调用顺序是 `access` → `detectImageMimeType` → `readFile`（`read.js:73-80`）⇒ 嗅探样本可以搭 `access`
   那一次往返的顺风车（`head -c` + `base64`），往返数保持 2 次/read，不新增第 3 次。
4. `processImage`（`dist/utils/image-process.js`）由宿主 read 的内部逻辑调用，属于宿主既有管线，不需要我们再接线。

## 范围

**做什么**

1. `createRemoteReadOps` 实现 `detectImageMimeType`：远端取前 8192 字节（≥ 宿主的 4100，宿主将来调大常数也不会嗅到截断样本）+
   `base64` 传输 → 写本地临时文件 → 调**宿主导出的** `detectSupportedImageMimeTypeFromFile`（魔数逻辑零复制）。
2. 该嗅探与 `access` 合并为**一次** ssh 往返：`access` 在判定可读的同时把样本缓存进本次 ops 实例；
   `detectImageMimeType` 命中缓存不触网，缓存未命中（例如端口被单独调用）时自己发一次嗅探。
3. 语义边界：非图片 → `null`（文本路径与今天逐字一致）；空文件/目录 → `null`（目录仍由 `readFile` 报「是目录」，
   错误归因不变）；不可读/不存在 → 沿用既有 `REMOTE_NOT_READABLE` / `REMOTE_NOT_FOUND`。
4. 测试：真实 PNG/JPEG/GIF/WebP/BMP 样本 → 各自 MIME；有损 JPEG 帧与文本/空样本 → `null`；「access + detect 只发一条 ssh」
   的往返计数断言；远端 read 走到图片分支的集成用例（fake exec 提供二进制 stdout）；真机 opt-in 用例加一条读远端 PNG。
5. 文档：卡片补「图片识别走宿主同一实现」这条不变量与 host-drift 关注点、扩展 README 加一句、根 README/AGENTS 测试数更新。

**明确不做什么**

- 不复制宿主的魔数/动图/BMP 判定逻辑（复制即漂移，保真优先——ADR 决策 1 的同一取舍）。
- 不做远端文件缓存/整树同步；不改其它六个工具；不动本地分支；不新增用户可见参数。
- 不为嗅探引入常驻临时目录或跨调用缓存（每次 read 的样本用完即删）。

## 验收标准

1. 远端 PNG/JPEG/GIF/WebP/BMP 经 `read` 返回「image 块 + 说明文本」，与本地 `read` 同形；文本文件行为不变。
2. 每次远端 `read` 的 ssh 往返数不增加：fake exec 计数断言 `access`+`detectImageMimeType` 合计 **1** 次调用，
   整个 read 调用（access + detect + readFile）共 2 次。
3. 检测实现与宿主同源：代码里不出现魔数常量表，调用的是包根导出的检测函数（评审可直接核对）。
4. 全量单测 + `npm run typecheck` 绿；真机 opt-in（WSL）用例通过；`remote` 为空的本地分支零回归。
5. 文档四处同步完成（含 ADR 0010 Consequences 里对「read 的变体探测」同类隐患的表述与本条不冲突）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：用户实测报障 + 明确指示「一起修复了」
- **逐条决策**：
  1. 修法 = 补 `ReadOperations.detectImageMimeType` 端口（用户原话「因为 createRemoteReadOps 没实现 detectImageMimeType，
     而宿主 read.js 是 ops.detectImageMimeType ? … : undefined」）。
  2. 与 `remote-tools-todo#7` 同一 worktree/分支一起交付，但**各自独立登记、独立对齐、独立收口**。
  3. 文档同步按红线 7 执行（用户原话「记得改相关文档」）。
- **agent 决定、用户未反对的实现细节**（不同意可在任意一轮推翻）：嗅探样本走本地临时文件复用宿主导出的检测函数（而非复制魔数表）；
  8192 字节样本上限；嗅探搭 `access` 的顺风车（不新增往返）。
- **开工放行**：用户在本轮会话已给出实施指示，登记与对齐文档落盘后进入 `processing`。
