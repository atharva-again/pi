import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";

type SessionPinsFile = Record<string, true>;

const SESSION_PINS_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

function readSessionPins(path: string): SessionPinsFile {
	let contents: string;
	try {
		contents = readFileSync(path, "utf-8");
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code === "ENOENT") return {};
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read session pins ${path}: ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read session pins ${path}: ${message}`, { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid session pins ${path}: expected an object`);
	}

	const pins: SessionPinsFile = {};
	for (const [sessionPath, pinned] of Object.entries(parsed)) {
		if (pinned !== true) {
			throw new Error(`Invalid session pins ${path}: value for ${JSON.stringify(sessionPath)} must be true`);
		}
		pins[sessionPath] = true;
	}
	return pins;
}

function writeSessionPins(path: string, pins: SessionPinsFile): void {
	const sortedPins: SessionPinsFile = {};
	for (const sessionPath of Object.keys(pins).sort()) {
		sortedPins[sessionPath] = true;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(sortedPins, null, 2)}\n`, SESSION_PINS_WRITE_OPTIONS);
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, path);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Failed to write session pins ${path} and remove temporary file`,
			);
		}
		throw error;
	}
}

function acquireSessionPinsLock(path: string): () => void {
	const pinsDir = dirname(path);
	mkdirSync(pinsDir, { recursive: true, mode: 0o700 });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(pinsDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing session selector callers to async.
			}
		}
	}

	throw (lastError as Error) ?? new Error("Failed to acquire session pins lock");
}

export class SessionPinStore {
	private pinsPath: string;

	constructor(pinsPath: string) {
		this.pinsPath = resolvePath(pinsPath);
	}

	getPinnedSessionPaths(): Set<string> {
		return new Set(Object.keys(readSessionPins(this.pinsPath)));
	}

	setPinned(sessionPath: string, pinned: boolean): void {
		const release = acquireSessionPinsLock(this.pinsPath);
		try {
			if (pinned && !existsSync(sessionPath)) {
				throw new Error(`Session file no longer exists: ${sessionPath}`);
			}
			const pins = readSessionPins(this.pinsPath);
			const normalizedPath = canonicalizePath(resolvePath(sessionPath));
			if (pinned) {
				if (pins[normalizedPath]) return;
				pins[normalizedPath] = true;
			} else {
				if (!Object.hasOwn(pins, normalizedPath)) return;
				delete pins[normalizedPath];
			}
			writeSessionPins(this.pinsPath, pins);
		} finally {
			release();
		}
	}
}
