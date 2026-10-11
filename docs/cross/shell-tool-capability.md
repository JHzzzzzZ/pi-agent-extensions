# 跨扩展横切契约：shell 工具能力协商（bash）

> last verified @ 846213e
>
> 背景：`bash` 是两个扩展共享的名字——timeout-bg 在 `session_start` 重注册它（默认超时 + 超时转后台），
> remote-tools 在加载期重注册它（远端 ssh 后端）。宿主 `pi.registerTool` 对同名工具是
> **按扩展加载顺序 first-wins**（`ExtensionRunner.getAllRegisteredTools()` 遍历扩展先到先得，
> agent-session 的 `_refreshToolRegistry` 再用它覆盖内置），且没有「取回下层定义再包裹」的 API
> （`getAllTools()` 只给 name/description/parameters/promptGuidelines/sourceInfo，**没有 execute**）。
> 所以两个扩展靠覆盖不可能共存，任一方会静默消失（2026-10-10 用户实测：带 `remote` 的 bash 跑在本机）。
>
> 上游根治诉求：`todos/general-todo#30`（请 `registerTool` 对齐自家 `registerMcpServer` 的冲突报错与
> `registerToolRenderer` 的链式 `(name, next) => …` 组合）。本契约是**仓库内的组合方案 B′**：
> 用宿主官方 `pi.events`（`dist/core/event-bus.js`，`emit` 同步派发、无返回值）做一次能力协商。

## 频道与盒子

| 项 | 值 |
| --- | --- |
| 频道名 | `pi-extensions:shell-capability:v1`（形状升级开新频道 `…:v2`，不做版本字段） |
| 收集时机 | owner（timeout-bg）**注册 bash 之前**（`session_start`），每次会话一次 |
| 盒子 | owner 新建的可变对象 `{ bash?: ShellCapability }`，`emit` 出去后同步读回 |
| 填充规则 | 订阅方（remote-tools）在**同步**回调里写 `box.bash`：宿主 `emit` 同步派发订阅回调，**emit 返回时盒子已就绪**是契约成立的前提；槽位已有值不覆盖（先到先得） |
| 缺席语义 | 没有提供方 / 宿主没有 `pi.events` ⇒ owner 按原行为注册，不报错、不阻塞 |

## 载荷（`box.bash`）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `parameters` | `Record<string, unknown>` | 参数片段（属性名 → TypeBox schema）。owner 合并进自己的 `properties`：**只能新增**；与 owner 既有参数重名 ⇒ 整份载荷判畸形并忽略（防止偷偷覆盖 `command`/`timeout`） |
| `isRemoteCall(params)` | `(unknown) => boolean` | 这次调用是否意图走远端。**目标形态非法也算 `true`**：交给远端分支报结构化错误，绝不因为解析失败就静默在本机执行 |
| `executeRemote(id, params, signal, onUpdate, ctx)` | 与工具 `execute` 同签名 | 远端分支的实现（提供方内部**单一实现**，不允许与自己的 bash 注册各写一份） |
| `guideline` | `string?` | 追加到 owner 的 `promptGuidelines`（非空字符串才生效） |

## 双方义务

- **形状守卫各自实现**（不共享代码、不跨扩展 import）：盒子里的东西来自别的扩展，一律当不可信；
  畸形载荷 ⇒ 当作「没有能力」并按原路径注册 + `notify` 一次，不抛异常。
- **owner 分派的安全口径**：`isRemoteCall` 抛错 ⇒ **fail-closed 报错**（不能确认意图时不猜：
  `local` 常是 `~/.ssh/config` 别名，跑错机器比报错贵）；`executeRemote` 抛错 ⇒ 原样抛（tool call
  以错误结束）+ `notify` 一次，**绝不回退到本机执行**。
- **归属可见性（owner 侧）**：注册**前**若 `bash` 不是内置实现（`getAllTools()` 的 `sourceInfo.path`
  不是 `builtin:bash`）且**确定没有提供方**（盒子空且无协商异常）⇒ `notify` 一次；
  注册**后**自检生效版本（与刚注册的 `description` 比对）不是自己那份 ⇒ `notify` 一次。
  两条共用一个「本会话已提示」标志，绝不静默。
- **扩展加载顺序**：合并生效的前提是 **timeout-bg 先于 remote-tools 加载**（本仓库根 `package.json`
  的 `pi.extensions` 顺序即如此：`timeout-bg` 在 `remote-tools` 之前）。顺序相反时 remote-tools 的
  bash 生效、timeout-bg 语义不生效——此时注册后自检会提示。这是有意接受的上游限制（`general-todo#30`），
  不是本契约要求用户手工保证的隐式前提：**错了会响**。

## 谁在哪实现（改任一侧先读本卡）

- 提供方：`src/extensions/remote-tools/capability.ts` — `SHELL_CAPABILITY_CHANNEL` / `RemoteBashCapability` /
  `isRemoteBashCall` / `offerBashCapability`
- owner：`src/extensions/timeout-bg/shell-capability.ts` — `collectBashCapability` / `mergeBashParameters` /
  `createBashDispatch` / `describeForeignBash` / `describeLostBashRegistration`
- 测试：`src/extensions/remote-tools/test/capability.test.ts`（载荷与订阅，真 event bus）、
  `src/extensions/timeout-bg/test/shell-capability.test.ts`（收集/守卫/合并/冲突描述）、
  `src/extensions/timeout-bg/test/index.test.ts`（真实注册的 bash：合并 schema、分派、回退与可见性）、
  `src/extensions/remote-tools/test/shell-composition.test.ts`（**真实加载两个扩展 + 真实 event bus +
  真实 ExtensionRunner**，覆盖正常顺序与反向顺序两种加载）
