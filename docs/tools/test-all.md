# test-all — 仓库全量测试入口（tools/test-all.mjs）

> last verified @ 36a6314

## 职责与边界

把「跑完整仓库测试」从逐目录手工串行（general-todo#11 基线：单次 ≈32s，且缺 `node_modules` 时 `pwr`/`loop` 整份测试文件加载失败、假绿）变成一条命令：`npm run test:all`。零依赖、纯 node、无第三方包、不动测试框架（仍 `node:test` + `node:assert/strict`）。

**不做**：不跑 typecheck（各插件仍各自 `npm run typecheck`，本工具只报测试耗时）；不做增量/缓存/分片；不放宽断言换速度。测试命令一律 `node --test` 直启（Windows 上 `npm.cmd` 必须过 shell 且多一层进程开销），只有 `--install` 走 npm。

## 套件清单与口径

`DEFAULT_SUITES`（`tools/test-all.mjs` 顶部常量）逐条镜像各插件 README / `package.json` 的测试命令：12 个扩展 + agent-manager + 根三套自检（contract / smoke / todo）+ test-all 自身 = **17 套件**（用例 2025 = 2026-09-17 在 dev-laptop `5daf197` 实测；其中 `root:todo` 134 用例）。

- **serial 三条**（负载敏感，运行期独占、断言绝不放宽）：`pwr`（含 `test/perf.test.ts` 300ms 门）、`agent-manager`（core 性能门）、`root:todo`（真子进程并发/中断用例）。serial 语义 = 启动前等其它套件排空、运行中不启动任何新套件。
- 覆盖只增不减由 `test/test-all.test.ts` 锁定：形状/名字唯一/serial 集合/「`pi.extensions` 全部扩展 + 根三套自检」都有登记。
- `install: true`：pwr / agent-team / loop / opencode-bridge / deep-init / agent-manager（有自己的 `node_modules`）；其余无 `package.json`，从仓库根跑。

## 用法

```bash
npm run test:all                      # 默认 --jobs 2；逐套件计时 + 失败聚合（退出码 0/1/2）
node tools/test-all.mjs --jobs 1      # 全串行（对照基线）
node tools/test-all.mjs --jobs 4      # 更高并发
node tools/test-all.mjs --install     # 新 worktree：先并行 npm install（--prefer-offline）再跑
node tools/test-all.mjs --only pwr    # 过滤；--list 只列清单（标 serial/install）
```

退出码：0 全绿 / 1 有套件或安装失败 / 2 用法或注册表错误。输出含 node 版本、平台与 CPU 数，跨机可复算；失败套件附输出尾部 40 行，失败即收集、不中断其余套件。

## 实测对照（2026-09-15，node v22.23.1 / win32 / 32 逻辑核，工具自身计时）

| 场景 | 套件耗时合计 | 墙钟 |
| --- | --- | --- |
| 全串行 `--jobs 1` | 32.4s | **32.4s**（≈ 优化前手工串行基线） |
| 并发 2（默认） | 38.7s | **29.0s** |
| 并发 4 | 40.0s | **28.6s** |
| 并发 8 | 39.3s | **28.7s** |

- 并发收益有限（-10%，默认 2 已接近上限）的原因：`agent-team` 单套件 14–15s 是长尾，`pwr`/`agent-manager`/`root:todo` 三条 serial 又必须独占 ≈10s（设计如此）；并发吃掉的是 ≈15 条碎小套件（各 0.2–0.7s）的进程启动成本。逐套件：agent-team 14.4s > root:todo 4.9s > root:test-all 3.5s > pwr 2.8s > opencode-bridge 2.2s > agent-manager 1.9s，其余 ≤0.7s。
- 用例数前后一致（1902；未删测试/未跳用例）。

## 新 worktree：从零到可跑测试（依赖安装）

junction / 符号链接复用 `node_modules` 是明令禁止的（`git worktree remove` 会穿透深删主干，`docs/incidents.md` 两次事故），只能走 npm 侧：

| 方案 | 6 个目录安装阶段墙钟 | 备注 |
| --- | --- | --- |
| 逐目录串行 `npm install`（对照） | ≈52s | 单目录 1.0–13.9s |
| `node tools/test-all.mjs --install`（jobs 2） | **≈34s**（-35%） | 随后测试 29.0s；缓存温时 `--prefer-offline` 不碰网络 |

- **独立缓存目录实测无收益**（同一 `deep-init` 目录）：冷缓存 12.2s / 温缓存 9.7s / 默认用户级缓存 9.8s——npm 用户级缓存在 worktree 间本来就共享，独立目录只会把缓存再复制一份。**结论：复用默认用户缓存 + `--prefer-offline`，不设独立缓存目录。**
- 新 worktree 的推荐路径：`node tools/test-all.mjs --install`（装 + 跑一条命令），此后 `npm run test:all`。

## 不变量与坑

- 失败即收集不中断：某套件失败不影响其它套件跑完，退出码聚合非 0；失败套件尾部输出随汇总打印。
- serial 独占是硬语义（`test/test-all.test.ts` 用真实子进程 start/end 标记文件锁死顺序），不因 `--jobs` 放大而放松。
- 缺 `node_modules` 时默认只提示（`! 缺少 node_modules：…`），**不自动安装**——避免测试命令隐式联网。
- 单套件默认 600s 超时（`--timeout <ms>` 可调），超时杀进程并记为失败。
- 已知既有失败（非本工具引入）：`agent-team` 的 `failure-delivery.test.ts` 第 3 例依赖「`os.tmpdir()` 不在任何 git 仓库内」，本机 HOME 自带 `.git` 时必失败（基线同样失败）——登记 `agent-team-todo#69`；本工具照实报 fail，不掩盖。
- 改套件命令 / 新增扩展时必须同步 `DEFAULT_SUITES`，否则覆盖率测试会红。
