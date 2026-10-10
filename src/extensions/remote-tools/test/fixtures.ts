/*
 * remote-tools — 测试样本（图片嗅探用）。
 *
 * 为什么要真的造文件内容而不是随便几个字节：远端的图片识别走的是**宿主同一份**检测实现
 * （包根导出的 detectSupportedImageMimeTypeFromFile），它的规则里有几处只有真样本才碰得到——
 * 动图 PNG（`acTL` 早于 `IDAT`）不算、`0xFF 0xD8 0xFF 0xF7`（有损 DC 帧）不算、BMP 要校验头。
 * 用真样本断言，才不会「测了个假的绿」。
 */

import { deflateSync } from "node:zlib";

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
