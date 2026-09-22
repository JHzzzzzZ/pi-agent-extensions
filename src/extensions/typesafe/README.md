# typesafe — TypeSafe/Jev 接入（登录 + 调用通道）

把 [TypeSafe](https://docs.typesafe.ai) 的 **Jev（System One）** 接进 Pi。Jev 不是聊天模型：它不吃会话上下文、不生成文本，只接受一段 `state` 加一组类型化问题，返回带概率的结构化答案。

| 原语 | 问什么 | 答案字段 |
| --- | --- | --- |
| `choice` | 从给定选项里选一个 | `choice` + `probabilities` + `confidence` |
| `score` | 按给定的有序档位打分 | `score` + `legend` + `probabilities` + `confidence` |
| `noul` | 一个命题为真的概率 | `noul`（0~1，无独立 confidence） |

## 登录（唯一会碰到明文 key 的地方）

```text
/login typesafe
```

从菜单选中 **TypeSafe** → 遮罩输入框粘贴 key → Pi 把 `{"type":"api_key","key":"…"}` 写进 `~/.pi/agent/auth.json` 的 `typesafe` 条目（与其它 provider 同格式同位置，重启会话仍在）。`/logout typesafe` 清除。

也可以用环境变量 `TYPESAFE_API_KEY` 代替（优先于 auth.json）。

## 用法一：`typesafe_ask` 工具

```text
用 typesafe_ask 判断这条工单该派给 billing 还是 technical，顺便给紧迫度打分
```

工具参数：`state`（要判断的材料）、`questions`（问题表）、可选 `model`（默认 `jev-latest`）。

```json
{
  "state": "客户说 Stripe 连了三天都失败，快要丢单了。",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "哪个团队应当处理",
      "criteria": { "billing": "付款或订阅问题", "technical": "故障或集成问题" }
    },
    "frustration": {
      "type": "score",
      "instructions": "客户的不满程度",
      "criteria": ["平静陈述", "不满但克制", "非常愤怒"]
    },
    "urgency": { "type": "noul", "instructions": "这条消息是否传达紧迫性" }
  }
}
```

## 用法二：CLI（bash / 子 agent / 团队 run）

```bash
node cli.ts --state "<文本>" --questions '<JSON>' [--model <id>]
node cli.ts --state-file <路径> --questions-file <路径> [--model <id>]
node cli.ts --help
```

stdout **只有 answers 的 JSON**；错误走 stderr，形如 `CODE: <静态消息>`，退出码 0 成功 / 1 调用失败 / 2 用法错误。工具与 CLI 共用同一个 `client.ts`，请求体字节级一致（`test/parity.test.ts` 断言）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `TYPESAFE_API_KEY` | API key（优先于 `auth.json`） |
| `TYPESAFE_BASE_URL` | 覆盖端点（默认 `https://api.typesafe.ai`），自建网关/测试用 |
| `PI_CODING_AGENT_DIR` | 覆盖 agent 配置目录（`auth.json` 随之移动），与 Pi 同口径 |

## 安全不变量

- 明文 key 只在扩展内部拼 `Authorization` 头时短暂存在：**不进 agent 上下文、不进工具结果、不进 CLI 输出、不进日志与错误消息**。
- 错误消息是静态模板 + HTTP 状态码，不回显响应体、请求头或底层异常文本。
- 没有 `--key` / `--show-key` / `--verbose-headers` 之类的开关；扩展不提供任何读取或打印凭据的工具。
- `test/sentinel.test.ts` 用哨兵 key 扫成功路径与三种失败路径的全部可见产物。

## 开发

```bash
npm install
npm test          # 33 个测试（含真实 HTTP server + 真实 cli.ts 子进程的 parity/sentinel 用例）
npm run typecheck # tsc -p tsconfig.json --noEmit
```

设计背景（为什么注册 provider 就能拿到登录界面、错误码与不变量清单）见 [`docs/extensions/typesafe.md`](../../../docs/extensions/typesafe.md)；规格见 [`docs/specs/typesafe-login.md`](../../../docs/specs/typesafe-login.md)。
