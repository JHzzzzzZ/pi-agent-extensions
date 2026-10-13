/*
 * remote-tools — 测试样本（图片嗅探用）。
 *
 * 为什么要真的造文件内容而不是随便几个字节：远端的图片识别走的是**宿主同一份**检测实现
 * （包根导出的 detectSupportedImageMimeTypeFromFile），它的规则里有几处只有真样本才碰得到——
 * 动图 PNG（`acTL` 早于 `IDAT`）不算、`0xFF 0xD8 0xFF 0xF7`（有损 DC 帧）不算、BMP 要校验头。
 * 用真样本断言，才不会「测了个假的绿」。
 */

import { deflateSync } from "node:zlib";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { RemoteToolsFailure } from "../errors.ts";
import type { RemoteTargetsFile, TargetsStore } from "../targets.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(type: string, data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of Buffer.concat([Buffer.from(type, "ascii"), data])) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) | 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.alloc(8 + data.length + 4);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, "ascii");
	data.copy(chunk, 8);
	chunk.writeInt32BE(crc32(type, data), 8 + data.length);
	return chunk;
}

/** 一张**真正合法**的 1×1 RGBA PNG（CRC 正确）⇒ 宿主的 processImage 也能处理它。 */
export function png1x1(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA
	const raw = Buffer.from([0, 0x00, 0x00, 0x00, 0x00]); // 一行：filter 0 + 一个像素
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 动图 PNG：`acTL` 出现在 `IDAT` 之前 ⇒ 宿主规则判为「不是受支持的静态图片」。 */
export function animatedPngSample(): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const actl = Buffer.alloc(8);
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("acTL", actl)]);
}

/** JFIF JPEG 头（`FF D8 FF E0`）。 */
export function jpegSample(): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
}

/** 有损 DC 帧（`FF D8 FF F7`）：宿主的检测实现明确把它排除在外。 */
export function losslessJpegSample(): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xf7]), Buffer.alloc(64)]);
}

export function gifSample(): Buffer {
	return Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(32)]);
}

export function webpSample(): Buffer {
	const body = Buffer.alloc(32);
	body.write("RIFF", 0, "ascii");
	body.write("WEBP", 8, "ascii");
	return body;
}

export function bmpSample(): Buffer {
	const bmp = Buffer.alloc(64);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(64, 2); // 声明文件大小
	bmp.writeUInt32LE(54, 10); // 像素数据偏移 ≥ 14 + DIB 头大小
	bmp.writeUInt32LE(40, 14); // DIB 头大小
	bmp.writeUInt16LE(1, 26); // color planes
	bmp.writeUInt16LE(24, 28); // bits per pixel
	return bmp;
}

export function textSample(): Buffer {
	return Buffer.from("hello remote\n", "utf8");
}

/**
 * 老用例的默认登记表：**strict 关 + 空表**（= v1 的自由填写语义）。
 *
 * 为什么不是 `createMemoryTargetsStore()`（= 无文件）：无文件的生效语义是「strict 开 + 零目标」
 * （Q1「strict 默认开」在解析路径也成立），那会让所有用字面 host 的既有用例集体变红。
 */
export function looseTargets(): MemoryTargetsStore {
	return createMemoryTargetsStore({ version: 1, strict: false, targets: [] });
}

/**
 * 目标登记表端口的手写 fake（进程边界替身，remote-tools#2）。
 *
 * 为什么要显式注入而不是让生产 store 去读真实 `~/.pi/agent/remote-targets.json`：
 * 开发机上一旦有登记表（strict 默认开），所有用字面 host 的老用例会集体变红——
 * 测试必须与用户配置隔离。默认 `null`（= 文件不存在）在用例里显式配 `strict: false`
 * 的假文件，这样「strict 开着会拒绝」与「strict 关着照旧自由填写」两条路径都能测。
 *
 * `readAtLoad` 返回的是**构造时的快照**——与生产一致（工具描述里的别名提示行是加载期读的）。
 */
export interface MemoryTargetsStore extends TargetsStore {
	/** read() 被调用次数（本地调用绝不读表的不变量靠它锁住）。 */
	reads: number;
	/** write() 被调用次数。 */
	writes: number;
	current(): RemoteTargetsFile | null;
	set(file: RemoteTargetsFile | null): void;
}

export function createMemoryTargetsStore(
	initial: RemoteTargetsFile | null = null,
	options: { readFailure?: RemoteToolsFailure; writeFailure?: RemoteToolsFailure; path?: string } = {},
): MemoryTargetsStore {
	let file = initial;
	const store: MemoryTargetsStore = {
		path: options.path ?? "C:\\fake\\remote-targets.json",
		reads: 0,
		writes: 0,
		async read() {
			store.reads += 1;
			if (options.readFailure !== undefined) return options.readFailure;
			return { ok: true, value: file };
		},
		async write(next) {
			store.writes += 1;
			if (options.writeFailure !== undefined) return options.writeFailure;
			file = next;
			return { ok: true };
		},
		readAtLoad: () => initial,
		current: () => file,
		set: (next) => {
			file = next;
		},
	};
	return store;
}

/**
 * 命令注册面的最小形状（宿主交互本身不在测试范围）。
 * 测试直接拿 `commands.get("remote:add")!.handler(args, ctx)` 驱动命令，ctx 用结构 fake。
 */
export interface CommandRegistration {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
