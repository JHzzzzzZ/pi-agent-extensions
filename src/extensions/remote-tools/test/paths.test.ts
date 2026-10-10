/*
 * remote-tools — 路径空间换算的纯函数测试（含标记根的结构性断言）。
 *
 * 动机（真问题，不是纸面正确；每一条都是真机/实测逼出来的）：
 *   path.resolve("/srv")               → "C:\srv"            （进程盘符注入）
 *   path.resolve("//srv")              → "C:\srv"            （单段 UNC 退化，仍被注入）
 *   normalizeWindowsShellPath("/s/x")  → "S:\x"              （单字母首段被当盘符）
 *   realpath("\\\\pi-remote\\…")       → UNKNOWN（不是 ENOENT）⇒ write/edit 的本地文件变更队列直接抛错
 *   realpath("<ext>/index.ts/pi-remote/…") → ENOENT | ENOTDIR  ⇒ 队列容忍，且**本地建不出**这个目录
 *
 * 最后一条是本轮 #7 的关键：标记根锚在扩展目录里一个已存在的普通文件下面，于是
 * 「本地恰好不存在这个前缀」不再是约定——`mkdir -p` 这个目录会直接 ENOTDIR（见下方断言）。
 */

import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	HOST_PATH_MARKER,
	HOST_PATH_ROOT,
	assertMarkerRootUsable,
	assertModelPathInput,
	stripHostMarker,
	toHostPath,
	toRemotePath,
} from "../paths.ts";
import { ErrorCodes } from "../errors.ts";
import { validateRemotePath } from "../ssh.ts";

/** 标记根锚定的那个普通文件（标记根 = 锚文件 + 标记段）。 */
const ANCHOR_FILE = path.dirname(HOST_PATH_ROOT);

test("往返不失真：绝对远端路径经宿主 path.resolve 后还原成原路径（含单字母首段、根目录、与标记段无关的真实目录）", () => {
	for (const remotePath of ["/home/deploy/src/x.ts", "/srv", "/srv/app", "/s/x", "/D/x", "/a/b/c", "/", "/__root__/x", "/pi-remote/x"]) {
		const host = toHostPath(remotePath);
		const resolved = path.resolve(host);
		assert.equal(toRemotePath(resolved), remotePath, `往返失败：${remotePath}（宿主形态 ${JSON.stringify(resolved)}）`);
	}
});

test("相对 path 经远端 cwd 解析后仍能还原成远端绝对路径", () => {
	const base = toHostPath("/home/deploy");
	assert.equal(toRemotePath(path.resolve(base, "src/a.ts")), "/home/deploy/src/a.ts");
});

test("标记根锚在扩展自带普通文件下：锚文件是普通文件，宿主形态是它的子路径", () => {
	assert.equal(statSync(ANCHOR_FILE).isFile(), true, `锚文件必须是普通文件：${ANCHOR_FILE}`);
	assert.equal(path.isAbsolute(HOST_PATH_ROOT), true);
	assert.equal(path.basename(HOST_PATH_ROOT), HOST_PATH_MARKER);
	assert.equal(path.dirname(HOST_PATH_ROOT), ANCHOR_FILE);

	const host = toHostPath("/srv");
	assert.equal(host.startsWith(HOST_PATH_ROOT) && host.slice(HOST_PATH_ROOT.length) === path.sep + "srv", true, host);
});

test("标记根结构性不可占用：本地 realpath 必须是 missing-path 错误（ENOENT/ENOTDIR），绝不是 UNKNOWN", async () => {
	const samples = ["/home/user/src/a.ts", "/srv", "/", "/home/user/a/it’s.txt", `/${"deep/".repeat(40)}x.ts`, `/${"长".repeat(60)}.ts`];
	for (const remotePath of samples) {
		const host = toHostPath(remotePath);
		await assert.rejects(
			() => realpath(host),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ENOTDIR",
			`${JSON.stringify(host)} 的本地 realpath 错误码不在容忍集内（write/edit 的本地文件变更队列只容忍 ENOENT/ENOTDIR）`,
		);
	}
});

test("标记根结构性不可占用：本地 mkdir -p 标记根必须失败（锚文件还是普通文件 ⇒ 这个目录建不出来）", async () => {
	await assert.rejects(
		() => mkdir(HOST_PATH_ROOT, { recursive: true }),
		(error: NodeJS.ErrnoException) => error.code === "ENOTDIR" || error.code === "ENOENT",
		"标记根竟然能被本地建出来——锚文件已经不是普通文件了",
	);
	await assert.rejects(() => realpath(HOST_PATH_ROOT), (error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ENOTDIR");
});

test("运行时守卫：锚文件是普通文件时放行；缺失/被换成目录时报专码（远端调用前的 fail-closed）", () => {
	assert.doesNotThrow(() => assertMarkerRootUsable());
	assert.throws(() => assertMarkerRootUsable(path.join(tmpdir(), `pi-remote-missing-anchor-${Date.now()}`, "index.ts")), new RegExp(ErrorCodes.HOST_MARKER_CONFLICT));
	assert.throws(() => assertMarkerRootUsable(tmpdir()), new RegExp(ErrorCodes.HOST_MARKER_CONFLICT), "目录不是普通文件");
});

test("非宿主标记形态原样返回：模型给的盘符路径/相对路径都被拒绝", () => {
	const suspicious = {
		"C:\\Users\\me\\x.ts": "C:/Users/me/x.ts",
		"C:/Users/me/x.ts": "C:/Users/me/x.ts",
		"src/a.ts": "src/a.ts",
		"": "",
	};
	for (const [input, expected] of Object.entries(suspicious)) {
		const remote = toRemotePath(input);
		assert.equal(remote, expected, `原样返回：${input}`);
		assert.equal(validateRemotePath(remote).ok, false, `应拒绝 ${input}`);
	}
});

test("assertModelPathInput：宿主标记首段与 ~ 开头都拒，普通路径放行", () => {
	for (const bad of [`/${HOST_PATH_MARKER}/x`, `//${HOST_PATH_MARKER}/x`, `C:/${HOST_PATH_MARKER}/x`, `C:\\${HOST_PATH_MARKER}\\x`, `/${HOST_PATH_MARKER}`, "~/x", "~", "~/"]) {
		assert.throws(() => assertModelPathInput(bad), /REMOTE_PATH_NOT_ABSOLUTE/, bad);
	}
	for (const good of ["/srv/app", "/pi-remotes/x", "/srv/pi-remote/x", "/home/deploy"]) {
		assert.doesNotThrow(() => assertModelPathInput(good), good);
	}
});

test("stripHostMarker：只剥标记根前缀（两种分隔符都认），其它形态原样归一", () => {
	assert.equal(stripHostMarker(toHostPath("/srv/app")), "/srv/app");
	assert.equal(stripHostMarker(toHostPath("/")), "/");
	assert.equal(stripHostMarker(toHostPath("/srv/app").replace(/[\\/]/g, "/")), "/srv/app");
	assert.equal(stripHostMarker(HOST_PATH_ROOT), "/");
	// 没有标记根的形态原样返回（模型回灌的 `//pi-remote/…` 由 assertModelPathInput 在更早一层拒绝）
	assert.equal(stripHostMarker("/srv/app"), "/srv/app");
	assert.equal(stripHostMarker("//pi-remote/srv/app"), "/pi-remote/srv/app");
	assert.equal(toRemotePath(toHostPath("/srv")), "/srv");
	assert.equal(toRemotePath(toHostPath("/")), "/");
});

test("toRemotePath 折叠冗余斜杠与尾斜杠，但保留根目录", () => {
	assert.equal(toRemotePath("/a//b/c/"), "/a/b/c");
	assert.equal(toRemotePath("\\a\\b\\c\\"), "/a/b/c");
	assert.equal(toRemotePath("/"), "/");
});
