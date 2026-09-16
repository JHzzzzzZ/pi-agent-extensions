# todo-cli-todo#15 todo 条目优先级 1-10

> 领取：2026-09-15（本会话）· 对齐访谈：2026-09-15 grill-with-docs（登记 → frontier → 终确认）

## 意图

todo 台账条目没有轻重概念，`list` / `summary` 无法表达缓急，排期全凭人工读全文。用户要求：1-10 数字优先级，默认 5，agent 登记时可自行判断取值。

## 范围

做什么：

1. **存储**：`entries[]` 新增 `priority` 字段（整数 1-10）；schema 版本升级与 todo-cli-todo#16（globalId）同版本 v3→v4。
2. **兼容（Q3）**：旧条目缺失该字段读时兜底为 5；不重写既有文件（避免批量重写丢字段——#14 教训）。
3. **命令面（Q1）**：`add --priority <1-10>`；缺省默认 5；非整数 / 越界 fail-closed（新错误码 + exit 1 不写盘）。**数字大者为高优先（10 最高）**。
4. **查询面（Q2）**：`list` 行内展示优先级标记，**默认排序不变**；新增 `--sort priority`（10 高在前、同值保持 id 稳定序）；`summary` 不加优先级；`list --json` 带 priority。
5. **语义边界**：优先级只影响展示 / 排序 / 人工排期；五态状态机与依赖门语义不变（claim / align 不按优先级拦截）。
6. **不做（Q4）**：修改优先级的独立子命令（YAGNI，第二个真实案例出现再加；登记错了暂走 reopen→重登记）。
7. **实施顺序（U3）**：排在 todo-cli-todo#16 之后，基于定稿后的 id 口径实现展示。
8. **契约同步**：SKILL.md 命令面、`docs/tools/todo-cli.md` 卡片、`docs/specs/`、根 README 测试数、版本 bump。
9. **TDD 先红后绿**。

明确不做什么：

- 不做 `priority set` 子命令、不做 1=最高的反向口径、不改状态机/依赖门、不加 summary 优先级列。

## 验收标准

1. `add` 缺省 priority=5；`--priority 1` 与 `--priority 10` 边界通过；`0` / `11` / `3.5` / `abc` 全部 exit 1 不写盘。
2. 旧数据（无字段）读出 5，且文件不被重写。
3. `--sort priority` 降序稳定（同 priority 按 id 升序）；不带 `--sort` 的 `list` 输出与现版本逐字节一致（优先级标记除外）。
4. `list --json` 带 priority；`summary` 输出不变。
5. 存量测试零破坏；`npm run test:todo` 全绿 + `lint` exit 0；README / 卡片测试数实测同步。

## 人工确认

确认人：用户 · 日期：2026-09-15 · 方式：本会话 grill-with-docs，四项决定全部采纳推荐值——Q1=10 最高、Q2=默认不排序加 `--sort priority`、Q3=读时兜底 5 不重写、Q4=本次不做 set 子命令；另按 U3 排在 #16 之后实施。用户答复「当前没问题」终确认。
