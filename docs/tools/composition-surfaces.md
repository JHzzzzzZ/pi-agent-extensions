# composition-surfaces — 插件接触面清单与组合矩阵（仓库级工具）

> last verified @ 83829d2

## 它解决什么问题

插件多了以后，两类问题只能在真机会话里撞出来：① **A+B 同装**时抢同一个槽（状态键 / widget /
内置工具名 / provider id / 命令名 / 拦截型钩子）而互相覆盖；② **A 单装**时拿不到对方提供的
能力频道，走进未声明的分支。历史事故：widget 带沉底、pwr 缺 `revive()` 导致 `/new` 之后永久抛错。

本工具把「谁占了哪个槽」变成一份**可校验的清单** + 一套**自动生成的组合测试**，来源是
`todos/align/general-todo#32.md`（对齐）与 `docs/specs/composition-test-matrix.md`（规格）。

## 命令面

```bash
node tools/composition-surfaces.mjs            # --check（默认）：清单完备 + 声明有效 + 共享槽已裁决
node tools/composition-surfaces.mjs --pairs    # 打印按接触面生成的配对集合
node tools/composition-surfaces.mjs --json     # 机器输出（测试与脚本消费）
node tools/composition-surfaces.mjs --root <dir>
```

退出码：`0` 通过 / `1` 校验失败 / `2` 用法错误。stderr 恒空，信息全走 stdout。

校验三类事实（全部 fail-closed，绝不静默跳过）：

1. **完备性**：`src/extensions` 下每个含 `index.ts` 的目录都必须在清单里有一节；
2. **声明有效性**：声明的键必须在**该扩展自己的非测试源码**里能找到字面量（"声明 → 源码"单向校验——
   反向自动提取已被实测否掉：正则提不出 `registerTool({ name })` 的工具名与 `registerVirtualModel`）；
3. **冲突已裁决**：两个插件共享同一槽取值时，双方都必须把它写进 `独占声明` 或 `共享槽`。

## 清单在哪、怎么加

唯一来源 `docs/cross/composition-surfaces.md`（逐插件一节 + `键: 值` 行）。**新增插件必须补一节**，
否则 `--check` 与 `root:composition` 套件都会红。字段口径与配对规则见该卡开头的表。

## 组合测试三层

| 层 | 位置 | 验什么 | 何时跑 |
| --- | --- | --- | --- |
| L1 单装 | `test/composition-standalone.test.ts` | A 单独加载可跑、生命周期可重入、注册面 ⊇ 声明、**注册面 ⊆ 声明** | `test:all` 的 `root:composition`（离线） |
| L2 配对 | `test/composition-pairs.test.ts` + `test/helpers/pair-probe.mjs`（子进程，每对一进程） | A+B 同装不抛错、声明的面都注册、**加载顺序无关**、共享槽已裁决 | 同上（离线，56 用例约 42s） |
| L3 契约 | 真 pi RPC + 真模型（opt-in，沿用 `tools/install-smoke.mjs` 的临时配置目录手法） | 关键组合的端到端行为（如 remote-tools × timeout-bg 远端超时转后台） | 手动，不进 CI |

校验器自身的纯函数测试在 `test/composition-surfaces.test.ts`（解析 / 完备性 / 配对 / 仲裁，含变异自证）。

## 坑与不变量

- **根目录没有 node_modules**：组合测试要在仓库根跑，而扩展会 `import` 宿主的运行期值
  （`pi-tui` 的 `Key`、`pi-coding-agent` 的 `createBashToolDefinition`）。`test/helpers/host-resolver.mjs`
  用 Node resolve hook 把裸说明符的解析基点改写到任意一个装好依赖的扩展目录——所以**至少要有一个
  扩展装了依赖**，否则 fail-closed 报错（`npm run test:all -- --install` 可一次装齐）。
- **`--test-force-exit` 是必须的**：扩展会留下真实定时器 / detached 子进程句柄，断言全绿进程也不退出。
  它只影响退出（测试结果与退出码不变），不是放宽断言。
- **每对跑一个子进程**：扩展持模块级单例与全局双加载守卫（agent-team 的
  `__piAgentTeamExtensionLoaded` 是先例），同进程反复加载会互相污染；一个 pi 会话本就是一个进程。
- **生命周期钩子不配对**（`session_start` / `session_shutdown` / `session_compact`）：人人都有，
  配对会退化成 O(n²) 且不产生新信息；它们的正确性是"可重入、无残留"，由 L1/L2 断言覆盖。
- **宿主替身只记录注册面**，不模拟 first-wins 覆盖、渲染与工具分派——真实宿主行为由 L3 与既有宿主
  路径测试（agent-team `viewer-host.test.ts`、dir-context / jev-safe-gate 的 `index-host.test.ts`）覆盖。
- **多模式扩展**（如 agent-team 的 cockpit / leader）在清单里写 `模式:` 一行，L1 据此放宽"声明必注册"，
  并由专门的模式用例覆盖另一支。
