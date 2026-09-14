#!/usr/bin/env sh
# todo-cli 包装器：定位本 skill 目录里的内层工具。
# 旧版曾指向仓库根 tools/ 下的薄壳入口（该目录已随本变更删除），现改为内层工具同目录。
# 仓库根由工具自己解析：--root <dir> 优先，否则从当前 cwd 走 git rev-parse --show-toplevel。
# 用法：scripts/todo.sh <子命令> [参数]
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/../todo-cli/todo.mjs" "$@"
