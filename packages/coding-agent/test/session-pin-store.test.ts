import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMostRecentSession } from "../src/core/session-manager.ts";
import { SessionPinStore } from "../src/core/session-pin-store.ts";

function writeSession(path: string, id: string, timestamp: string): void {
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp/project" })}\n`);
}

describe("SessionPinStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads a missing pin store without writing to the agent directory", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-readonly-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const pinStore = new SessionPinStore(join(agentDir, "session-pins.json"));

		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set());
		expect(existsSync(agentDir)).toBe(false);
	});

	it("propagates pin-store read errors other than a missing file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-read-error-"));
		tempDirs.push(tempDir);
		const pinStorePath = join(tempDir, "session-pins.json");
		mkdirSync(pinStorePath);
		const pinStore = new SessionPinStore(pinStorePath);

		expect(() => pinStore.getPinnedSessionPaths()).toThrow(`Failed to read session pins ${pinStorePath}`);
	});

	it("stores pins separately without changing recent-session selection", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir);
		const olderPath = join(sessionDir, "older.jsonl");
		const newerPath = join(sessionDir, "newer.jsonl");
		writeSession(olderPath, "older", "2026-01-01T00:00:00.000Z");
		writeSession(newerPath, "newer", "2026-01-02T00:00:00.000Z");
		utimesSync(olderPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
		utimesSync(newerPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
		const olderMtime = statSync(olderPath).mtimeMs;
		const pinStore = new SessionPinStore(join(tempDir, "session-pins.json"));

		pinStore.setPinned(olderPath, true);

		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set([realpathSync(olderPath)]));
		expect(statSync(olderPath).mtimeMs).toBe(olderMtime);
		expect(findMostRecentSession(sessionDir)).toBe(newerPath);
	});

	it("fails instead of pinning a session file that no longer exists", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-missing-"));
		tempDirs.push(tempDir);
		const sessionPath = join(tempDir, "missing.jsonl");
		writeSession(sessionPath, "missing", "2026-01-01T00:00:00.000Z");
		rmSync(sessionPath);
		const pinStore = new SessionPinStore(join(tempDir, "session-pins.json"));

		expect(() => pinStore.setPinned(sessionPath, true)).toThrow(`Session file no longer exists: ${sessionPath}`);
		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set());
	});
});
