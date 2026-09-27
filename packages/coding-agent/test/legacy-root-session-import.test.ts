import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionPinStore } from "../src/core/session-pin-store.ts";

describe("legacy root session import", () => {
	let tempDir: string;

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports archives in place and resolves legacy parent links", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-legacy-root-session-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);

		const parentPath = join(agentDir, "parent.jsonl");
		const childPath = join(agentDir, "child.jsonl");
		const timestamp = "2026-01-01T00:00:00.000Z";
		const parentArchive = `${JSON.stringify({ type: "session", version: 3, id: "root-parent", timestamp, cwd })}\n`;
		const childArchive = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "root-child",
			timestamp,
			cwd,
			parentSession: parentPath,
		})}\n`;
		writeFileSync(parentPath, parentArchive);
		writeFileSync(childPath, childArchive);
		const pinsPath = join(agentDir, "session-pins.json");
		writeFileSync(pinsPath, JSON.stringify({ [realpathSync(parentPath)]: true }));

		const sessions = await SessionManager.list(cwd);
		const parent = sessions.find((session) => session.id === "root-parent");
		const child = sessions.find((session) => session.id === "root-child");

		expect(parent).toBeDefined();
		expect(child?.parentSessionPath).toBe(parent?.path);
		expect(parent?.legacyPath).toBe(parentPath);
		expect(existsSync(parentPath)).toBe(true);
		expect(existsSync(childPath)).toBe(true);
		expect(readFileSync(parentPath, "utf8")).toBe(parentArchive);
		expect(readFileSync(childPath, "utf8")).toBe(childArchive);
		expect(new SessionPinStore(pinsPath).getPinnedSessionPaths()).toEqual(new Set([realpathSync(parentPath)]));
	});
});
