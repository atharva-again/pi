import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
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

	it("stores pins without modifying the legacy archive", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-"));
		tempDirs.push(tempDir);
		const legacyPath = join(tempDir, "legacy.jsonl");
		writeSession(legacyPath, "legacy", "2026-01-01T00:00:00.000Z");
		const originalMtime = statSync(legacyPath).mtimeMs;
		const pinStore = new SessionPinStore(join(tempDir, "session-pins.json"));

		pinStore.setPinned(legacyPath, true);

		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set([realpathSync(legacyPath)]));
		expect(statSync(legacyPath).mtimeMs).toBe(originalMtime);
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

	it("migrates legacy JSONL pins to a stored session locator", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-pins-legacy-"));
		tempDirs.push(tempDir);
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir);
		const legacyPath = join(sessionDir, "legacy.jsonl");
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy-pin", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
		);
		const [session] = await SessionManager.list(cwd, sessionDir);
		expect(session?.legacyPath).toBe(legacyPath);
		const pinStore = new SessionPinStore(join(tempDir, "session-pins.json"));

		pinStore.setPinned(legacyPath, true);
		pinStore.migratePinnedPath(realpathSync(legacyPath), session!.path);
		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set([session!.path]));

		pinStore.setPinned(session!.path, false);
		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set());
	});
});
