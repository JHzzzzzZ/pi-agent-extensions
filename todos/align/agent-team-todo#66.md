# agent-team-todo#66 外部 CLI 成员的 thinking 级别映射

## 意图

混合团队里级别控制不对等：pi 内部成员可按成员指定推理档位（团队文件写 `model: provider/id:high`，由 `config.ts:59` 的 `splitModelThinking` 解析，`cockpit.ts:672/684`、`index.ts:727` 都在用）；外部 CLI 成员（codex / claude）写同样的后缀会被**当成模型名直传 CLI 报错**——`external.ts` 的 `buildExternalArgs` 原样透传 `member.model`，没有任何级别参数注入。结果外部成员的级别只能跟随各 CLI 全局配置（如 `~/.codex/config.toml`），同一团队内无法逐个区分。

另有既存不一致：`preflight.ts:73` 已用 `splitModelThinking(ref.model).model` 剥掉后缀算 base model，而启动路径不剥——预检与实际 spawn 对同一字符串的解释不同。

## 范围

做什么：

- 级别表达统一用 `model` 的 `:level` 后缀（复用 `splitModelThinking`），**不新增**成员字段、不改团队文件 schema。
- 外部 CLI 参数注入：codex `-c model_reasoning_effort=<level>`；claude `--effort <level>`；映射表以两端实际支持集为准（实现时实测确认后落表）。
- 预检期 fail-closed：两端不支持的档位直接报错（登记稳定错误码），不静默降级。
- 统一解析路径：所有出口 model 的地方（含 `team_resume` 的 `memberModels` 覆盖）都过同一函数，顺带修掉「预检剥、启动不剥」的隐患。
- 文档：根 `README.md` §7 + `docs/extensions/agent-team.md` 落「pi 级别 → 各 CLI 参数」映射表。测试：`external.ts` 参数构造单测 + 预检用例。

明确不做什么：

- 不做外部 leader：`preflight.ts:115` 的 `EXTERNAL_LEADER_UNSUPPORTED` 不动，外部 leader 形态留给 `#64`。
- 不改内部（pi）成员的级别语义与解析规则。
- 不做未安装 CLI 的探测增强（沿用既有 `resolveCli` / `EXTERNAL_BIN_ENV` 路径）。

## 验收标准

- `codex/x:high` 这类外部成员：spawn 参数含对应级别参数，且 `--model` 值里不再出现后缀。
- 不支持的档位（如 claude 上的 `:off`）在预检期 fail-closed，错误码稳定、消息为静态模板（不插值用户输入）。
- 预检与启动对同一 model 字符串的解析结果一致（对照组测试）。
- README 与 docs 卡的映射表有实测支撑（注明来源：各 CLI `--help` / 官方配置文档）。
- 全量测试 + `npm run typecheck` 零错误；外部成员既有用例（codex / claude 参数构造）保持绿。

## 人工确认

- 确认人：用户（本会话）
- 日期：2026-09-16
- 方式：会话内逐条问答对齐（25 问，用户回复「按你建议」）→ 5 份文档落盘后用户回复「确认」
- 结论：全部决策按本档执行（后缀而非新字段；不支持档位 fail-closed；只做成员；统一解析路径并修预检/启动不一致；落映射表 + 两处测试）。
