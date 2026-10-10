# dir-context

模型触碰某个目录时，自动把它上方（到 cwd 为止）的 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` 注入当次工具结果。

pi 原生只加载 **cwd 及其祖先链** 的上下文文件，**子树一概不读**；本扩展补上这一格，语义对齐 Claude Code 的 on-demand nested `CLAUDE.md`。

## 装与用

```bash
# 全局（所有项目）
mkdir -p ~/.pi/agent/extensions && cp -r src/extensions/dir-context ~/.pi/agent/extensions/
# 或项目级
mkdir -p .pi/extensions && cp -r src/extensions/dir-context .pi/extensions/
# 然后在 Pi 里 /reload
```

装上即生效，无需配置。命令：

```
/dir-context            # 列出本会话已注入的上下文文件
/dir-context:status     # 同上（冒号形式）
```

## 触发面

| 触碰方式 | 触发 |
| --- | --- |
| `read` / `write` / `edit` 的 `path`（含 `write` 新建文件） | 是，锚点 = 文件所在目录 |
| `ls` 的 `path`（省略 = 当前目录） | 是，锚点 = 该目录（指向文件时退到父目录） |
| `bash` 里**恰好一个**单文件读（`cat` / `head` / `tail`） | 是，锚点 = 该文件所在目录 |
| codemode 脚本里的 `tools.read` / `write` / `edit` / `ls` / bash 单文件读 | 是（v1.1），按 codemode **顶层**结果的 `details.calls` 提取，多个触碰取并集 |
| `grep` / `find` / 其它工具 | 否 |
| bash 带重定向、变量展开、命令替换、多文件 | 否（拿不准就不认） |

## 行为约定

- **发现**：从锚点目录逐级向上到 cwd（不含 cwd），同目录取一个（`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`），顺序由外向内。
- **作用域**：`realpath` 后必须落在 cwd 之内，否则零注入（符号链接逃逸、`../` 越界、`repo` vs `repo-evil` 都拦住）。
- **去重**：会话内每文件一次；`/compact` 后清空缓存，再触碰会重新注入。
- **预算**：单文件 32 KiB / 单次 128 KiB，按 UTF-8 码点边界截断并留标记。
- **降级**：失败的结果、纯图片结果、嵌套工具调用本身不注入；读不出上下文文件时只跳过（不标记已注入，下次还能重试）。
- **codemode（v1.1）**：脚本里的 `tools.read/write/edit/ls/bash` 是嵌套调用（结果只回到脚本、不进 transcript），本扩展改在读 codemode **顶层**结果的 `details.calls`（宿主记好的嵌套调用明细）并注入一次——与顶层共用同一份去重/预算。脚本失败（`isError`）、`args` 被宿主截断（超过 200 字符的调用，如带 `content` 的 `write`）或解析失败一律跳过（少注入，不误注入）。
- **结构化结果**：原样回传 `structuredContent`（宿主契约：替换 `content` 而不回传它就等于丢掉结构化结果）。
- **链接**：指向 cwd 之外的上下文文件整个跳过（fail-closed，既不注入外部内容也不把外部路径展示出来）。

## 不要与同类扩展同装

[`pi-subdir-context`](https://github.com/ruttybob/pi-subdir-context) 与 [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) 也在 `read` 路径注入，同装会让同一份 AGENTS.md 进两次上下文（功能不冲突，只是浪费 token）。

## 开发

```bash
npm install && npm test && npm run typecheck   # 63 个测试（含 2 个平台条件跳过：创建文件符号链接需权限）
```

设计决策与不变量见仓库 `docs/extensions/dir-context.md`、`docs/adr/0011-dir-context-scoped-injection.md` 与 `docs/adr/0012-dir-context-codemode.md`。
