# btw

主对话跑长任务时，想随时问「现在在干啥 / 为什么这么改 / 进度如何」——`/btw` 开一条**只读主会话、零写入**的侧对话。

```text
你: /btw 现在在干啥                      （主 agent 正在流式跑工具，不受影响）
→ 面板：btw 旁路对话 · 已完成
        ❯ 现在在干啥
        它在读 src/extensions/btw/panel.ts，刚跑完 btw 套件（59 通过），
        下一步准备改 README 的扩展清单。
（Esc 关闭，主对话照常继续；任何侧问答都不会进主上下文）
```

## 用法

| 命令 | 作用 |
| --- | --- |
| `/btw <问题>` | 侧问答：读当前会话上下文作答，答案落只读面板（流式上屏，可滚动） |
| `/btw:clear` | 清空侧对话线（只动扩展内存，不碰主会话） |
| `/btw:model [provider/id\|default]` | 查看/切换侧模型；`default` 恢复跟随主会话 |

- 面板键位：`J`/`K`、`↑`/`↓` 逐行，`PgUp`/`PgDn` 翻页，`Esc`/`q`/`ctrl+c` 关闭（关闭即中止侧调用）。
- 同一会话内**保留追问**：再问时会带上最近的侧问答（最多 8 条消息 = 4 轮，超出丢最早的一对）。
- 默认跟随主会话模型；`/btw:model opencode-go/deepseek-v4.1-flash` 可切到便宜快档（会话内有效）。
- RPC 模式降级为通知（正文截断）；`print` / `json` 模式没有 UI：写一行 stderr 并返回，不静默。

## 不变量（改代码前必读）

1. **零写入主会话**：不 `pi.appendEntry`、不 `pi.sendMessage`、不碰主 run（无事件拦截、无上下文注入、无 steer/followUp 介入）。session 文件与下一轮主请求都不含侧对话内容；宿主路径测试用 `ExtensionActions` 计数器 + 源码结构守卫双锁。
2. **侧调用只走 `ctx.modelRegistry.streamSimple()`**：宿主负责路由 / 鉴权 / 虚拟模型 / `sessionId` 会话头（goal 评估器同款接缝，`todos/align/goal-todo#10.md` 有真机对照）。本扩展不直调 provider、不自己拼请求头。
3. **有界**：单飞（同一时刻一个侧调用）+ 120 秒看门狗；provider 挂住时与 abort 竞速强行结束（**不 await provider 的 cleanup**——它自己也可能永不落定，await 会把关闭路径重新挂住）。
4. **上下文只读快照**：`sessionManager.buildContextEntries()`（压缩感知的当前分支）→ 字符预算 30k、逐块截断（工具结果 800 / 助手文本 4000 / 参数预览 300）、由新到旧装填，丢多少条如实标注。**正在流式、尚未落盘的那一条看不到**（已知限制）。
5. **侧线程不落盘**：只在扩展内存里，`session_start` / `session_shutdown` 重置；重启即失。

## 文件地图

- `index.ts` — 接线：三条命令 + `session_start` / `session_shutdown` + `BtwDeps`（`nowMs` / `timeoutMs` 注入口）
- `context.ts` — 分支条目 → 侧上下文纯文本（预算 / 截断 / 省略标注）
- `side-call.ts` — `streamSimple` 封装：prompt 组装、流式增量、abort 竞速、失败归一
- `panel.ts` — 只读覆盖面板（帧渲染 / 键位 reducer / `ctx.ui.custom` presenter）
- `spec.ts` — 全部上限与静态文案（单一来源）；`errors.ts` — 错误码与 result union
- `test/` — context / side-call / panel 纯函数与组件单测 + index-unit（注入 deps 的边缘逻辑）+ index-host（真实发现加载 + 真实 `ExtensionRunner` + 真实命令上下文）

## 安装与测试

```bash
# 安装：整目录复制到 ~/.pi/agent/extensions/btw/ 或 <项目>/.pi/extensions/，Pi 内 /reload
cd src/extensions/btw && npm install && npm test && npm run typecheck   # 59 个测试
```

真机验收（需要真实模型）：主 agent 流式运行中执行 `/btw 现在在干啥` → 面板出答案、主 run 不中断、会话文件零新增条目。
