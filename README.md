# Pi Coding Agent Extensions

Pi 编码助手的扩展集，提供模型提供商、额度查询、运行计时和安全 Git 自动提交功能。

## 扩展列表

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

将扩展目录放置到 `~/.pi/agent/extensions/` 或项目 `.pi/extensions/` 下，然后在 Pi 中执行 `/reload` 即可生效。