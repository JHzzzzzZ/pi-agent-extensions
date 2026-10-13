# remote-tools-todo#2 远端目标登记表（别名）+ 严格白名单 + 模型面偏好

**档位：T3**（新增工具名 `remote_targets`、新增命令面 `/remote:*`、改 7 个内置工具的模型面参数描述与 guideline、新增用户级文件契约、新增错误码——接触面清单与文档面同步）。

## 意图

三个症状，一条根因。

1. **模型偏 bash+ssh**：目标是远端主机时，模型倾向 `bash{command:"ssh host …"}` 而不是给内置工具传 `remote`。ssh 层是同一个 bin，所以"连不上"不是问题；丢的是本扩展为这条信道建的保证——远端命令原本作为**单个 argv** 交给 ssh（不过本地 shell，无双层转义），现在要过本地 shell 拼一遍；结构化 edit/write、图片嗅探、read 截断限流、`#16` 的路径回写、远端目录的 AGENTS.md 注入、`#12` 的远端超时转后台（kill 能杀远端进程组）全部拿不到。
2. **目标名不可发现**：`remote` 是一个自由字符串，模型不知道有什么目标可用（`~/.ssh/config` 它反而能用 bash 读到），于是每次都从零编一个 host。缺的不是能力，是**登记表 + 一次可查的工具**。
3. **没有白名单**：条目 `remote-tools-todo#2` 的原始动机——命令输出可诱导模型连任意主机（v1 自由填写，见 `todos/align/remote-tools-todo#1.md` 的范围外声明）。

结论：把「目标」变成一等公民——登记在用户级文件里，模型可以查、可以登记、只能引用已登记的目标（strict 默认开），并在模型面上明确写出「优先用 remote，不要拼 ssh」。别名同时把「我怎么用远端」的入口从一个可选参数变成一个显式工具，这本身就是最强的偏好抓手。

**对齐时推翻了原条目文本的一处假设**：原文写「模型只能引用已登记目标」，用户 2026-10-13 决定**模型可注册**（见「人工确认」Q2）。代价已显式接受：strict 白名单因此**不是安全边界**（注入内容同样能诱导模型注册后连上），它买到的是**可发现性 + 审计**（每条远端调用都能追到一个具名条目、来源标 `human`/`agent`）。

## 范围

本条目交付「目标登记表 + strict 白名单 + 模型面偏好」这一整块（含 `remote-tools-todo#18` 并入），不动 SSH 传输策略、不动本地分支、不碰 `remote-tools-todo#3`/`#4`/`#17` 的范围。

**做什么**

1. **登记表文件**（新模块 `targets.ts`）：`~/.pi/agent/remote-targets.json`（与 `auth.json`／`solo-mode.json` 同族，用户级；路径可经 `PI_REMOTE_TARGETS_FILE` 覆盖，测试接缝）。形态 `{version: 1, strict: boolean, targets: [{alias, host?, user?, port?, source: "human"|"agent", createdAt, note?}]}`。读/写全部走纯函数 + 注入的文件端口；写用 temp+rename 原子落盘；文件损坏或形态非法 ⇒ **类型化错误 fail-closed**（不静默当空表——静默在 strict 下会变成静默全拒，两个方向都危险）。
2. **解析接缝（唯一一处）**：别名展开发生在 `parseTarget` **之前**，产出仍喂给现有 `parseTarget`，其余校验/缓存/ssh 构造零改动。
   - 命中口径（Q3）：入参先按字面解析成 `(user, host, port)`，再与登记条目**展开后的三元组**比对——`host` 相等，且入参给了 `user`／`port` 时也必须相等；命中即用条目**补齐**入参没给的 user/port。所以 `/remote:add prod deploy@10.0.0.7 --port 2222` 之后，`remote: "prod"`、`remote: "10.0.0.7"`、`remote: "deploy@10.0.0.7"` + `remotePort: 2222` 三者都命中同一条目。
   - `ssh_config` 兜底：条目**不给 host** 时，`alias` 本身当主机名交给 ssh（`/remote:add prod` ⇒ `remote: "prod"` 走 ssh 自己的 config 解析 user/port）。
   - **strict 默认开**（Q1）：未命中任何条目 ⇒ 拒绝，新错误码（如 `UNKNOWN_REMOTE_TARGET`），消息为静态模板 + 列出已登记别名 + 给出 `/remote:add` 与 `remote_targets` 两个修复入口。`strict: false` 时未命中回落成今天的行为（字面主机名，逐字不变）。
   - 别名匹配大小写敏感；`alias` 与 `host` 的形态复用现有目标校验（前导 `-`／空白／多 `@`／内嵌端口一律拒绝）。
3. **模型面工具 `remote_targets`**（新）：动作 `list`（默认，输出别名 + user@host:port + 来源 + strict 状态）与 `register`（`alias` 必填，`host`/`user`/`port`/`note` 可选，写入 `source: "agent"` + 注册时 `ctx.ui.notify`）。**不给模型删除动作**（删除只走人工命令）。同名已存在 ⇒ 拒绝（不覆盖；覆盖只走人工 `/remote:add --force`）。
4. **命令面**：`/remote:add <别名> [user@host] [--port N] [--force]`、`/remote:list`、`/remote:rm <别名>`、`/remote:strict on|off`（命名同 `/bg:kill`、`/team:run` 惯例）。
5. **模型面偏好文案**（吸收 `remote-tools-todo#18`）：
   - 7 个工具现有的 `REMOTE_GUIDELINE` 追加一句：目标是远端主机时优先给内置工具传 `remote`，**只在连接诊断**（`ssh -v`／`ssh-keygen`／端口探测）时才在 bash 里拼 ssh。
   - 7 个工具的 `remote` 参数描述追加一行「已登记目标：a, b, c」——加载期读一次登记表（Q5 方案 a：零额外上下文，`/reload` 刷新；读不出或为空则不加这行，且**绝不因此让注册失败**）。
   - strict 拒绝文案本身是第三处抓手（错误里直接列可用别名）。
6. **契约与文档同步**：`docs/cross/composition-surfaces.md`（新增工具名 `remote_targets` 与命令 `/remote:add|list|rm|strict` 的独占声明）、`docs/extensions/remote-tools.md`、`src/extensions/remote-tools/README.md`、根 `README.md`、`CONTEXT.md` 术语、新 ADR（登记表与 strict 的取舍）、T3 规格 `docs/specs/remote-targets.md`、`errors.ts` 新码。

**不做什么**

- **不做 bash 里 ssh 的检测/软提示/硬拦**（只改 guideline 文案，不加命令嗅探；硬拦会打断 git over ssh、端口转发、ansible——用户按推荐选的「只改 guideline」档）。
- **不做系统提示词注入**（Q5 选方案 a；`before_agent_start` 只能注入消息，不采用）。
- **不做人工审批门**（Q2 选即时生效；`pending → /remote:approve` 留作将来加真安全边界时的选项）。
- **不给模型删除权限**；**不存任何凭据**（沿用「只复用密钥／ssh-agent」不变量）；条目**不带默认 `remoteCwd`**（Q4，归 `remote-tools-todo#4` 路径映射条目）。
- 不动 `ssh.ts` 的传输策略（TOFU／BatchMode／连接超时逐字不变）；不动本地分支（`remote` 为空时**不读登记表、不触网、行为逐字不变**——登记表损坏绝不能弄坏本地调用）。
- 不做远端只读模式（`remote-tools-todo#3`）、不做路径映射（`remote-tools-todo#4`）。
- `remote-tools-todo#17`（`/remote:setup`）依赖本条目，不在本次范围。

## 验收标准

1. **解析**：命中别名（补齐 user/port）、字面三元组命中、`ssh_config` 兜底条目、strict 未命中拒绝（`UNKNOWN_REMOTE_TARGET` + 静态文案 + 列出别名）、`strict: false` 未命中透传、大小写与形态非法（前导 `-`／空白／内嵌端口）各自有锁住行为的用例。
2. **零影响不变量**：`remote` 为空时**不读登记表**——登记表缺失/损坏/非法时本地调用逐字不变（用「登记表读写端口一旦被调用就抛错」锁住）；既有「本地分支绝不 spawn ssh」用例继续绿。
3. **登记表读写**：原子落盘、损坏 fail-closed 类型化错误、`PI_REMOTE_TARGETS_FILE` 覆盖生效、写失败不破坏会话（异常隔离）。
4. **`remote_targets` 工具**：`list` 输出含别名/目标/来源/strict；`register` 形状守卫（非法形态静态报错）、`source: "agent"` 落盘、同名拒绝；无删除动作。
5. **命令面**：`/remote:add|list|rm|strict` 的参数解析与非法输入静态报错；`--force` 覆盖语义锁住。
6. **模型面**：7 个工具描述含「已登记目标：…」（空表/读不出时不含）；guideline 含「优先 remote，不要 bash 拼 ssh」。断言到文本级。
7. **契约面**：`node tools/composition-surfaces.mjs` 与 `npm run test:contract` 绿（新工具名/命令已声明）；`npm run test:all` 全绿；`cd src/extensions/remote-tools && npm test && npm run typecheck` 绿。
8. **真机 opt-in 取证**：真实 ssh 目标上 `ls remote=<别名>` 成功；未登记目标被拒的输出留档。
9. **文档**：`docs/extensions/remote-tools.md`（含 `last verified` 行）、README（根 + 扩展）、`docs/cross/composition-surfaces.md`、`CONTEXT.md`、新 ADR、`docs/specs/remote-targets.md` 同变更同步；`node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 绿。
10. **评审**：T3 全流程——跨厂商 reviewer（kimi-coding/k3-256k）迭代到「终轮无新意见」，≤3 轮、有预算上限；意见逐条处理（改或明确驳回）。
11. **收口**：`remote-tools-todo#18` 以 `complete --note "由 remote-tools-todo#2 一并交付（模型面偏好已含在 #2 范围）"` 收口；`remote-tools-todo#17` 保持 open（依赖本条目，解锁后另开 worktree）。

## 人工确认

用户 2026-10-13 本会话逐轮确认（第一轮 4 问、第二轮 5 问，均「按推荐」）：

**第一轮**

- 存储位置 → **用户级 `~/.pi/agent/remote-targets.json`**（非项目级）。
- 模型能否注册别名 → **能**（推翻原条目「模型只能引用」；已显式接受「白名单不再是安全边界，只剩可发现性 + 审计」的代价）。
- 严格白名单 → **要**。
- bash+ssh 议题的处置档位 → **只改 guideline 文案**（不做软提示、不做硬拦）。

**第二轮**

- Q1 strict 默认 → **默认开**，拒绝文案给修复路径 + 列已登记目标。
- Q2 模型注册 → **即时生效** + `source: "agent"` 来源标记 + `/remote:list` 显示来源 + notify；删除只走人工 `/remote:rm`；不引入审批门。
- Q3 命中口径 → **按展开后三元组匹配**（别名只是入口）+ 支持 `ssh_config` 兜底（条目不给 host）。
- Q4 条目字段 → **只 host/user/port**（不带默认 `remoteCwd`）。
- Q5 目标清单怎么让模型知道 → **加载期把别名烘进 7 个工具的 `remote` 参数描述**（+ `remote_targets` 工具），不注入系统提示词。

**同一会话中我直接定下、用户未反对的条款**：命令 `/remote:add|list|rm|strict`；工具名 `remote_targets` 只有 `list`/`register`；同名重登记拒绝（要 `--force`）；`remote-tools-todo#18` 并入本 worktree 同一变更交付（一行文案不值得单独一轮评审，收口见验收标准 11）。

**越界说明（红线 8）**：本条目运行时会在**仓库外**写 `~/.pi/agent/remote-targets.json`——与 `auth.json`／`solo-mode.json` 同族的用户级状态文件，非宿主安装目录、非系统文件；不修改任何宿主包、不写 `settings.json`。回滚方式：删除该文件（strict 随之消失，行为回到今天的自由填写）。
