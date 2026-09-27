import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("HTML export default filenames", () => {
	let tempDir: string;
	let originalCwd: string | undefined;

	afterEach(() => {
		if (originalCwd) {
			process.chdir(originalCwd);
			originalCwd = undefined;
		}
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects imported session IDs that are unsafe as output path components", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-session-id-"));
		const archivePath = join(tempDir, "legacy.jsonl");
		writeFileSync(
			archivePath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "../../outside",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
		);
		const session = SessionManager.open(archivePath, tempDir);

		await expect(exportSessionToHtml(session)).rejects.toThrow("Session id must be non-empty");
		await expect(exportFromFile(archivePath)).rejects.toThrow("Session id must be non-empty");
	});

	it("disambiguates default filenames for matching IDs in different projects", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-session-collision-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);
		const storeDir = join(tempDir, "store");
		const sessions = ["project-a", "project-b"].map((project) =>
			SessionManager.create(join(tempDir, project), storeDir, { id: "shared-export-id" }),
		);
		for (const session of sessions) {
			session.appendMessage({ role: "user", content: "export this", timestamp: Date.now() });
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "exported" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}

		const [firstExport, secondExport] = await Promise.all(sessions.map((session) => exportSessionToHtml(session)));

		expect(firstExport).not.toBe(secondExport);
		expect(existsSync(firstExport!)).toBe(true);
		expect(existsSync(secondExport!)).toBe(true);
	});
});
