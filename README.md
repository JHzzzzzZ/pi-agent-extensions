# Pi Coding Agent Extensions

Pi 编码助手的扩展集：本地工作流编排（PWR）、模型提供商、额度查询、流式回复计量、运行计时和安全 Git 自动提交。

## 扩展列表

### pwr — PWR（Pi Workflow Runtime，主项目）

本地工作流编排扩展（v2.2.0）。用户编写受约束的 ECMAScript 工作流脚本，PWR 校验后弹出批准卡，再由子 `pi` 进程作为 subagent 执行：

- **脚本引擎**（`engine/`）— acorn 解析 + 白名单校验 + AST 解释器，零运行时依赖；单次快照安全边界
- **运行编排**（`runtime/` + `runner/`）— FIFO 调度、运行缓存、child pi 适配器（结果 50KB / 摘要 8KB 截断、SIGTERM → SIGKILL 中止）
- **结果回传** — 运行成功或失败后自动唤起主 agent 汇报结果；用户主动取消不打扰
- **保存/复用**（`workflow_save` + `/workflow:<name>`）— 自动补齐 meta、强制重新校验、参数 JSON-schema 校验
- **观察与控制**（`/workflows`）— 运行列表/详情/批准卡 UI，暂停/恢复/停止/重启

```bash
cd pwr
npm install        # 仅开发依赖（运行零依赖）
npm test           # 346 个单测
npm run typecheck  # tsc --noEmit（strict）
```

详细文档见 `pwr/README.md` 与 `pwr/DELIVERY.md`。

### stream-token-speed

实时统计流式回复的 TTFT 与 tokens/s，并在终端状态行显示。

### chatanywhere-provider

通过 [ChatAnywhere](https://docs.chatanywhere.tech) 的 OpenAI 兼容 API 和 Anthropic Messages API 接入多种模型，包括 GPT-5 系列、Claude、DeepSeek、Qwen、Kimi、GLM、Gemini、MiniMax 等。

```bash
# 设置 API Key
export CHATANYWHERE_API_KEY=sk-xxx

# 启动 Pi 时加载
pi -e ./extensions/chatanywhere-provider
```

### provider-quota

查询当前 provider 的账户额度/余额并在终端底部状态行显示。支持 OpenRouter、DeepSeek、ChatAnywhere、智谱 GLM。每 5 分钟自动刷新，切换模型时立即刷新。

```bash
# 手动刷新
/quota
```

### run-timer

在终端底部显示任务运行时间，包括当前任务耗时、本轮对话耗时和会话总耗时。

### safe-git-autocommit

双层安全 Git 自动提交扩展：
- **Layer 1** — 只读诊断基线，自动采集变更并安全过滤
- **Layer 2** — 显式提交工具 `safe_git_commit`，Agent 可调用提交代码

```bash
# 诊断命令
/safe-git
# 手动触发自动提交（调试用）
/auto-commit-now
```

## 安装

将扩展目录放置到 `~/.pi/agent/extensions/` 或项目 `.pi/extensions/` 下，然后在 Pi 中执行 `/reload` 即可生效。PWR 要求 Node.js ≥ 22.18（原生 TS type-stripping，无构建步骤）。
