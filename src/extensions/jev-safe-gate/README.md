# jev-safe-gate

`tool_call` **发生前**插一道便宜的 Jev 风险判断：模型（或被注入的模型）想静默执行不可逆操作时，先把人叫进来问一句。

```text
bash: rm -rf build          → 候选 → Jev 判断 → 可疑 → 宿主确认框 → 拒绝 ⇒ 这次调用被阻止
bash: npm test              → 非候选（正则筛掉）⇒ 零分类调用、零额外延迟
solo 开启                   → 本门完全不介入（不筛候选、不判断、不弹框）
```

## 行为边界（两条不可协商）

1. **只加摩擦**——判定「安全」不授予任何权限：本扩展永不因判定安全而跳过或弱化任何既有门（宿主/其它扩展的 `tool_call` 处理器照常运行、照常可以 block），也**绝不修改命令文本**（同意 = 原样执行，不追加参数）。
2. **fail-open 但必须可观测**——`classify` 抛错 / 超时 / 目录里没有分类器模型 / 无 UI（headless）/ 弹框崩溃 / 门自身异常，一律放行，但每一次都留下痕迹：footer 段 `⚠ jev 放行N（原因）`、本会话首次放行的一次性 `notify`、一行日志（**无 UI 时日志是唯一通道**）。不允许门静默失效。

## 判据

- **拦什么**：只有 `bash`（第一版最窄档；`write` / `edit` / 其它工具一概不看）。
- **候选筛**（`candidates.ts`，纯正则、无 IO）：`rm` 递归/强制删除、`rd /s` / `del /f` / `Remove-Item -Recurse|-Force`、`git reset --hard`、`git push --force[-with-lease]`、`git clean -f`、`dd of=` / `> /dev/sd*` / `mkfs` / `diskpart` / `fdisk` / `parted`、`format-volume`、`curl|wget|iwr|irm … | sh|bash|iex|node`。判据是「不可逆」而非「看起来凶」。
- **判断**（`gate.ts`）：构造 `ClassifierContext`（工具名 + 命令原文（截断 2000 字）+ cwd + 工具注解）→ `ctx.modelRegistry.classify()` 走内置 `typesafe/jev-latest`（无需新 provider / API key 录入）→ 一条 choice 问题（`safe` / `destructive`）。
- **弹框条件**：判定 `destructive`、或 `destructive` 概率 ≥ 0.5、或 `confidence` < 0.6、或**答案读不懂**（读不懂 ≠ 安全，交给人看一眼）。
- **超时**：默认 4s（`AbortController` → 宿主分类 API 的 `signal`），到点按 fail-open 放行并记录。

## solo 豁免（跨扩展契约）

solo 免审批模式开启时本门**完全不介入**：solo 的语义就是「本会话不要摩擦」。状态只经 `docs/cross/solo-approval-gate.md` 的契约读（同构 `solo-gate.ts`：`${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}` + `pid === process.pid`，其余一律 fail-closed 为「未开启」⇒ 门照常工作）。

## 文件地图

- `index.ts` — 宿主接线：`pi.on("tool_call")` / `session_start` / `session_shutdown` + 端口装配（`JevSafeGateDeps`：solo 读取 / 超时 / 日志出口）
- `candidates.ts` — 便宜候选筛（模式表 + `findCandidates`）
- `gate.ts` — 判定层：`judgeToolCall`（顺序即成本顺序）、`readJudgement`、`buildClassifierContext`、`classifyCommand`、原因码表
- `observability.ts` — fail-open 计数 / 状态条段文本 / 一次性 notify / 日志行
- `solo-gate.ts` — solo 状态只读（契约同构拷贝）
- `status-band.ts` — footer 段前缀协调（契约同构拷贝，键 `60:jev-safe-gate`）

## 安装与测试

```bash
# 安装：整目录复制到 ~/.pi/agent/extensions/jev-safe-gate/ 或 <项目>/.pi/extensions/，Pi 内 /reload
cd src/extensions/jev-safe-gate && npm install && npm test && npm run typecheck
```

真机验收步骤见 [`docs/jev-safe-gate-checklist.md`](../../../docs/jev-safe-gate-checklist.md)。
