/*
 * remote-tools — 路径空间换算的纯函数测试。
 *
 * 动机（真问题，不是纸面正确）：Windows 上内置工具用 node:path 解析路径，实测
 *   path.resolve("/srv")               → "C:\srv"          （进程盘符注入）
 *   path.resolve("//srv")              → "C:\srv"          （单段 UNC 退化，仍被注入）
 *   path.resolve("//pi-remote/srv")    → "\\pi-remote\srv\"（多段 UNC，原样保留）
 *   normalizeWindowsShellPath("/s/x")  → "S:\x"            （单字母首段被当盘符）
 * 这里锁住「宿主标记路径往返不失真」与「非标记形态原样返回、交给 validateRemotePath 拒绝」。
 */

import assert from "node:assert/strict";
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

test("宿主标记形态在 Windows 上不会退化成盘符注入", () => {
	const host = toHostPath("/srv");
	assert.equal(host, "//pi-remote/srv");
	assert.equal(path.resolve(host).endsWith("pi-remote\\srv\\") || path.resolve(host).endsWith("pi-remote/srv/"), true, path.resolve(host));
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
	assert.equal(stripHostMarker("/srv/app"), "/srv/app");
	// 只有标记没有路径的形态会被当成「名字就叫 pi-remote 的远端目录」；toHostPath 永远不会生产它（根目录走 __root__ 占位）。
	assert.equal(toRemotePath(HOST_PATH_MARKER), "/pi-remote");
	assert.equal(toRemotePath(toHostPath("/srv")), "/srv");
	assert.equal(toRemotePath(toHostPath("/")), "/");
});

test("toRemotePath 折叠冗余斜杠与尾斜杠，但保留根目录", () => {
	assert.equal(toRemotePath("/a//b/c/"), "/a/b/c");
	assert.equal(toRemotePath("\\a\\b\\c\\"), "/a/b/c");
	assert.equal(toRemotePath("/"), "/");
});
