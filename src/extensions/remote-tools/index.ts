/**
 * remote-tools — 内置工具的 SSH 远程后端（remote-tools-todo#1）
 *
 * 给 read/write/edit/bash/grep/find/ls 七个内置工具加三个可选参数：
 *
 *   remote      远端 SSH 目标 "[user@]host"（省略或留空 = 在本机执行，行为与内置完全一致）
 *   remotePort  远端 SSH 端口（1-65535，省略用 ssh 默认或 ~/.ssh/config）
 *   remoteCwd   bash 的远端工作目录（省略 = 远端 $HOME）
 *
 * 另外把远端 bash 能力放上 `pi.events` 的收集频道，供 shell 工具 owner（timeout-bg）组合
 * （契约见 docs/cross/shell-tool-capability.md；两个扩展不互相 import）。
 *
 * 做法是把内置工具的 **公开 Operations 接缝**换成远端实现（官方 Gondolin 扩展同思路），
 * 而不是自己复刻内置行为：read/write/edit/ls/find/bash 全都复用宿主的定义（截断、限流、
 * 渲染器、提示词片段一致），只有 grep 必须整份重写（宿主的 GrepOperations 覆盖不到真正的
 * ripgrep 搜索）。远端路径由模型每次显式给出（绝对 POSIX 路径直接用；相对路径/省略按远端 $HOME 解析），不做本地↔远端映射。
 *
 * 边界与不变量：
 *   - 零运行时 npm 依赖，只调系统 `ssh`；不存凭据（复用密钥 / ssh-agent）；
 *   - 非交互（BatchMode）且 TOFU 指纹策略（StrictHostKeyChecking=accept-new）⇒ 新主机首次连接自动把指纹
 *     写进 known_hosts（零人工前置），已收录主机的指纹变更仍然 fail-closed（remote-tools#15）；
 *   - 远端分支的结果/错误文案把宿主标记形态路径换回远端真实路径（宿主的成功文案与补丁头会原样插值入参
 *     path，不换就会被读成「写到了本机」，remote-tools#16）；本地分支逐字不动；
 *   - remote 为空时直接调宿主本地实现，不触网、不产生任何 SSH 进程；
 *   - 路径在**发 ssh 之前**校验：Windows 盘符形态、`~` 开头与宿主标记首段直接 fail-closed；
 *     省略/相对路径按**远端 $HOME** 解析（同目标只解析一次）；
 *   - 不做整树同步、不覆盖 powershell、不做主机白名单（v1，见对齐文档 todos/align/remote-tools-todo#1.md）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSpawnExec } from "./ssh.ts";
import { registerRemoteTools } from "./tools.ts";

export default function remoteToolsExtension(pi: ExtensionAPI): void {
	registerRemoteTools(pi, { exec: createSpawnExec(), cwd: process.cwd() });
}
