/**
 * PWR - script digest
 *
 * SHA-256 over the normalized source. Normalization keeps the digest stable
 * across CRLF/LF differences so that only real content changes invalidate
 * approvals and agent caches.
 */

import { createHash } from "node:crypto";

export function normalizeSource(source: string): string {
	return source.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
}

export function computeDigest(source: string): string {
	return createHash("sha256").update(normalizeSource(source), "utf8").digest("hex");
}
