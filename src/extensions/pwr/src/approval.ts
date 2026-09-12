/**
 * PWR - approval store (JHL-16 goal 3)
 *
 * One-time start approval with two grant modes:
 *  - once:       applies to this run only, not remembered
 *  - remember:   valid for the same project + same script digest
 * Any digest change invalidates a remembered approval (APPROVAL_STALE).
 */

import { ErrorCode, PwrError } from "./errors.ts";
import type { ApprovalRecord } from "./types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ApprovalDecision {
	approved: boolean;
	remembered: boolean;
	/** Set when a remembered approval existed but the digest changed. */
	staleDigest?: string;
}

/**
 * Canonical project path (PRD §5.5 "project canonical path"): resolves
 * relative paths, follows symlinks and normalizes case on case-insensitive
 * platforms (win32). Used as the approval record key so the same project
 * opened via different spellings maps to the same record.
 */
export function canonicalProjectPath(raw: string): string {
	if (typeof raw !== "string" || raw.length === 0) return raw;
	let resolved = path.resolve(raw);
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		// Path may not exist (yet); path.resolve() is still canonical enough.
	}
	if (process.platform === "win32") resolved = resolved.toLowerCase();
	return resolved;
}

/**
 * In-memory approval store keyed by `canonicalProjectPath|digest`.
 * Persistence of the records themselves is delegated to the caller (session
 * entries) so this module stays pure and unit-testable. Records always store
 * the canonical project path.
 */
export class ApprovalStore {
	private records = new Map<string, ApprovalRecord>();

	key(projectPath: string, digest: string): string {
		return `${canonicalProjectPath(projectPath)}|${digest}`;
	}

	has(projectPath: string, digest: string): boolean {
		return this.records.has(this.key(projectPath, digest));
	}

	get(projectPath: string, digest: string): ApprovalRecord | undefined {
		return this.records.get(this.key(projectPath, digest));
	}

	/** Stores a remembered approval record (canonical project path). */
	remember(projectPath: string, digest: string, decidedAt: string): void {
		const canonical = canonicalProjectPath(projectPath);
		this.records.set(this.key(canonical, digest), {
			projectPath: canonical,
			digest,
			decision: "approved",
			remembered: true,
			decidedAt,
		});
	}

	/** Removes an approval record (e.g. after a script change). */
	clear(projectPath: string, digest: string): void {
		this.records.delete(this.key(projectPath, digest));
	}

/**
 * Core approval check (read-only). Granting happens through `remember()`,
 * which is called only by a user decision at the approval card.
 */
decide(projectPath: string, digest: string): ApprovalDecision {
	const canonical = canonicalProjectPath(projectPath);
	const remembered = this.records.get(this.key(canonical, digest));
	if (remembered) {
		if (remembered.digest === digest) {
			return { approved: true, remembered: true };
		}
		return { approved: false, remembered: false, staleDigest: remembered.digest };
	}

	// No record for this digest: if a remembered approval exists for the same
	// project with a different digest, the approval is stale.
	for (const record of this.records.values()) {
		if (record.projectPath === canonical && record.remembered) {
			return { approved: false, remembered: false, staleDigest: record.digest };
		}
	}
	return { approved: false, remembered: false };
}

	/**
	 * Throws APPROVAL_STALE when a remembered approval exists for the
	 * project with a *different* digest and the current digest has no
	 * remembered approval of its own yet.
	 */
	assertFresh(projectPath: string, digest: string): void {
		const canonical = canonicalProjectPath(projectPath);
		if (this.records.has(this.key(canonical, digest))) return;
		for (const record of this.records.values()) {
			if (record.projectPath === canonical && record.digest !== digest && record.remembered) {
				throw new PwrError(ErrorCode.APPROVAL_STALE, undefined, `(project-scoped approval is for digest ${record.digest.slice(0, 12)}...)`);
			}
		}
	}

	toJSON(): ApprovalRecord[] {
		return [...this.records.values()];
	}

	hydrate(records: ApprovalRecord[]): void {
		for (const record of records) {
			if (record?.remembered && record.digest) {
				this.records.set(this.key(record.projectPath, record.digest), record);
			}
		}
	}
}
