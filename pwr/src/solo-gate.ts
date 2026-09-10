/**
 * PWR - solo 审批门读取（跨扩展契约 docs/cross/solo-approval-gate.md）
 *
 * solo-mode 扩展把"当前进程处于免审批模式"写进
 * `${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}`，内容 `{pid, activatedAt}`。
 * 本模块只读：仅当文件可读、JSON 合法且 `pid === process.pid` 才返回激活——
 * 损坏/缺失/异 pid（子 pi 进程、崩溃残留、并发实例）一律 fail-closed 为未激活，
 * 审批卡照常弹出。
 *
 * 三份同构实现（pwr / opencode-bridge / deep-init 各一份）是刻意重复：
 * 扩展部署时被复制为独立目录，无法跨目录 import；语义由契约卡锁死。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SOLO_STATE_FILE_ENV = "PI_SOLO_MODE_FILE";

/** 状态文件路径：`PI_SOLO_MODE_FILE` 优先，缺省 `~/.pi/agent/solo-mode.json` */
export function resolveSoloStatePath(env: Record<string, string | undefined> = process.env): string {
	const override = env?.[SOLO_STATE_FILE_ENV];
	if (typeof override === "string" && override.trim() !== "") return override;
	return path.join(os.homedir(), ".pi", "agent", "solo-mode.json");
}

/** 本进程是否处于 solo 模式（fail-closed；每次调用现读,不缓存） */
export function isSoloActive(options: { env?: Record<string, string | undefined>; pid?: number } = {}): boolean {
	const pid = options.pid ?? process.pid;
	try {
		const raw = fs.readFileSync(resolveSoloStatePath(options.env), "utf8");
		const parsed = JSON.parse(raw) as { pid?: unknown } | null;
		return parsed?.pid === pid;
	} catch {
		return false;
	}
}
