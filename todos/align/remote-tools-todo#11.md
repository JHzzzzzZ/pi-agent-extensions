# 对齐：remote-tools-todo#11 — 卡片里「相对路径 fail-closed」的自相矛盾

- 条目：`remote-tools-todo#11`（tags: `docs`）· 分支引用：`fix/shell-tool-composition`
- 日期：2026-10-10（UTC）· 参与：用户（指出矛盾）+ agent（核实）
- 状态：无分叉，纯文档修正

## 意图

用户指出 `docs/extensions/remote-tools.md` 自相矛盾：「路径换算只有一个出口」段写「模型给的 `C:/…` **与相对路径**在发 ssh 之前就 fail-closed」，而「校验先于 ssh」段写「只有省略/相对路径才**解析**（远端 `$HOME`）」。实测以后者为准：相对路径正常解析（`resolveToolPath` 走远端 `$HOME`），fail-closed 的只有 Windows 盘符形态、`~` 开头、以及首段是宿主标记的输入（`assertModelPathInput` + `validateRemotePath`）。

## 范围

**做什么**：把该句改成准确口径——「模型给的 `C:/…`、`~` 开头、宿主标记首段在发 ssh 之前 fail-closed；相对路径/省略 `path` 按远端 `$HOME` 解析（同目标只解析一次）」。顺带核对同卡其它段是否还有同类失实表述（`#7` 那轮已修过一处真机验收段）。

**明确不做什么**：不改任何代码与行为；不借机重写卡片结构（红线 6 的 `last verified` 行照常指向代码提交）。

## 验收标准

1. 卡片中不再出现「相对路径 fail-closed」这类失实表述；同卡关于相对路径的两处口径一致，且与 `resolveToolPath`/`assertModelPathInput` 的实际行为一致（实现处注释同步）。
2. 文档提交单独成 commit（`docs:` 前缀），`last verified` 指向本轮代码提交。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：用户实测后指出（「问题 3（文档矛盾）」）
- **逐条决策**：以实测为准（相对路径解析），改文档不改代码。
- **开工放行**：用户已给出实施指示，对齐文档落盘后进入 `processing`。
