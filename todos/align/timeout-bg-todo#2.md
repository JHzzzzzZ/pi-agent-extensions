# timeout-bg-todo#2 包装 bash 跟上游结构化结果契约

## 意图

本扩展**替换**了内置 `bash` / `powershell` 工具（`createBashTool(cwd, { operations })` 包装形态）。pi 0.99 起内置 bash 的结构化结果变了：

- `output` 上限从「模型可见的 2000 行 / 50KB」提到 **1 MiB**（超长保留首尾各 512 KiB + 省略标记）
- 新增 `truncated` 与 `full_output_path` 字段
- 空输出从 `(no output)` 变为 `""`

这些字段**只有 codemode 脚本看得到**（模型侧仍是 2000 行 / 50KB）。而 codemode 现在已经在本机打开。

关键问题：**脚本调 `bash` 拿到的是本扩展的返回值，不是内置的**。如果包装器的 `operations` 适配层没有透传/构造这几个字段，则 codemode 场景下 bash 能力**退化**——脚本拿不到完整输出、也拿不到落盘路径。

这是一个**退化风险**，不是功能增强——所以本条目标记为 p7。

## 范围

**做什么**

1. **只读排查先行**（第一步，不改代码）：跑一段 codemode 脚本，实测 `tools.bash({ command: "..." })` 的返回结构，与 pi 文档声明的 `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` 逐字段比对，产出一份差异表。
2. 按差异表决定修法：
   - 若差异只在新增字段缺失 → 在 `operations` 适配层补齐 `truncated` / `full_output_path`，并把 `output` 上限对齐 1 MiB 口径。
   - 若结构形态都不同（例如包装器返回自定义 details 而非 outputSchema 值）→ 明确 `outputSchema` 并回填，使脚本视角与内置一致。
   - 若排查显示**已经一致** → 本条以「实测已对齐 + 差异表留档」收口，不改代码。
3. 补测试锁定该结构（现有测试是否覆盖 codemode 视角需先确认）。

**不做什么**

- 不改超时转后台语义、默认超时（`PI_TIMEOUT_BG_DEFAULT`）、后台任务注册表与日志落盘
- 不改 `/bg:*` 命令面
- **不改宿主**（红线 8）——若发现上游缺陷，走 issue 稿路径（`docs/pi-*.md` 先例）

## 验收标准

1. 产出**差异表**：本扩展 bash 返回值 vs pi 文档声明的结构化契约，逐字段。
2. 差异表为空 → 条目以实测结论收口；有差异 → 修复后差异表为空。
3. `cd src/extensions/timeout-bg && npm test` 全绿 + `npm run typecheck` 零错误；新增测试锁定 codemode 视角的结构。
4. **真机实测**：在真实会话的 codemode 脚本里调 `bash`，能看到 `truncated` / `full_output_path`（在需要时），且 `output` 不被 2000 行截断。
5. 模型侧行为零回归（仍是 2000 行 / 50KB 口径），超时转后台路径零回归。
6. 文档同步：`docs/extensions/timeout-bg.md` 卡 + 根 README。

## 人工确认

用户 2026-10-04 本会话确认：

- 本条优先级 **p7**（高于其余调研条目）：它是**退化风险**而非增强，且 codemode 已实际开启。
- **开工方式**：先做只读排查（实测现状 + 差异表），**结论可能是"已经对了"**——不预设要改代码。此点由提出方（我）在调研时明确写出，用户未提出异议。
- **Q5**：并行开 worktree；本条因为可能只产出排查结论，worktree 规模按实际需要定。
