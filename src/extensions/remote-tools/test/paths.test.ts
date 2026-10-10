/*
 * remote-tools — 路径空间换算的纯函数测试。
 *
 * 动机（真问题，不是纸面正确；后两条都是真机/实测逼出来的）：
 *   path.resolve("/srv")               → "C:\srv"            （进程盘符注入）
 *   path.resolve("//srv")              → "C:\srv"            （单段 UNC 退化，仍被注入）
 *   normalizeWindowsShellPath("/s/x")  → "S:\x"              （单字母首段被当盘符）
 *   realpath("\\\\pi-remote\\…")       → UNKNOWN（不是 ENOENT）⇒ write/edit 的本地文件变更队列直接抛错
 *   realpath("C:\pi-remote\…")         → ENOENT ⇒ 被队列容忍，远端 write/edit 才能工作
 */

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { HOST_PATH_MARKER, stripHostMarker, toHostPath, toRemotePath } from "../paths.ts";
import { validateRemotePath } from "../ssh.ts";

test("往返不失真：绝对远端路径经宿主 path.resolve 后还原成原路径（含单字母首段与根目录）", () => {
	for (const remotePath of ["/home/deploy/src/x.ts", "/srv", "/srv/app", "/s/x", "/D/x", "/a/b/c", "/"]) {
		const host = toHostPath(remotePath);
		const resolved = path.resolve(host);
		assert.equal(toRemotePath(resolved), remotePath, `往返失败：${remotePath}（宿主形态 ${JSON.stringify(resolved)}）`);
	}
});

test("相对 path 经远端 cwd 解析后仍能还原成远端绝对路径", () => {
	const base = toHostPath("/home/deploy");
	assert.equal(toRemotePath(path.resolve(base, "src/a.ts")), "/home/deploy/src/a.ts");
});

test("Windows 上用盘符形态（UNC 会让 realpath 抛 UNKNOWN，POSIX 上用 // 形态）", () => {
	const host = toHostPath("/srv");
	if (process.platform === "win32") {
		assert.match(host, new RegExp(`^[A-Za-z]:\\\\${HOST_PATH_MARKER}\\\\srv$`));
	} else {
		assert.equal(host, `//${HOST_PATH_MARKER}/srv`);
	}
});

test("宿主形态的本地 realpath 必须是 ENOENT（不是 UNKNOWN）：write/edit 的本地文件变更队列只容忍 ENOENT/ENOTDIR", async () => {
	for (const remotePath of ["/home/user/src/a.ts", "/srv", "/"]) {
		const host = toHostPath(remotePath);
		await assert.rejects(
			() => realpath(host),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
			`${remotePath} 的宿主形态 ${JSON.stringify(host)} 未被本地 fs 视为「不存在」`,
		);
	}
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

test("stripHostMarker 幂等：模型把宿主标记形态回灌也能归一", () => {
	assert.equal(stripHostMarker("//pi-remote/srv/app"), "/srv/app");
	assert.equal(stripHostMarker("\\pi-remote\\srv\\app"), "/srv/app");
	assert.equal(stripHostMarker("C:/pi-remote/srv/app"), "/srv/app");
	assert.equal(stripHostMarker("D:\\pi-remote\\srv"), "/srv");
	assert.equal(stripHostMarker("//pi-remote"), "/");
	assert.equal(stripHostMarker("/srv/app"), "/srv/app");
	assert.equal(toRemotePath(toHostPath("/srv")), "/srv");
	assert.equal(toRemotePath(toHostPath("/")), "/");
});

test("toRemotePath 折叠冗余斜杠与尾斜杠，但保留根目录", () => {
	assert.equal(toRemotePath("/a//b/c/"), "/a/b/c");
	assert.equal(toRemotePath("\\a\\b\\c\\"), "/a/b/c");
	assert.equal(toRemotePath("/"), "/");
});
