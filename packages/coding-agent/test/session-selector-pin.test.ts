import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionPinStore } from "../src/core/session-pin-store.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function writeSession(path: string, id: string, cwd: string, timestamp: string, name: string): void {
	const header = { type: "session", version: 3, id, timestamp, cwd };
	const nameEntry = {
		type: "session_info",
		id: `${id}-name`,
		parentId: null,
		timestamp,
		name,
	};
	writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(nameEntry)}\n`);
}

const CTRL_D = "\x04";
const CTRL_P = "\x10";

describe("session selector pins", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("toggles the selected session with Ctrl+P and pins its thread", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-selector-pins-"));
		tempDirs.push(tempDir);
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir);
		const pinStorePath = join(tempDir, "session-pins.json");
		const olderPath = join(sessionDir, "older.jsonl");
		const newerPath = join(sessionDir, "newer.jsonl");
		writeSession(olderPath, "older", cwd, "2026-01-01T00:00:00.000Z", "Older pinned");
		writeSession(newerPath, "newer", cwd, "2026-01-02T00:00:00.000Z", "Newer regular");
		const pinStore = new SessionPinStore(pinStorePath);
		pinStore.setPinned(olderPath, true);

		const loadSessions = () => SessionManager.list(cwd, sessionDir);
		const initialSessions = await loadSessions();
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => initialSessions,
			async () => initialSessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, pinStorePath },
		);
		await flushPromises();

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("ctrl+p pin");
		expect(output).not.toContain("path (on)");
		expect(output).not.toContain("path (off)");
		expect(output.indexOf("Older pinned")).toBeLessThan(output.indexOf("Newer regular"));
		expect(output).toContain("◆ Older pinned");
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(olderPath);

		selector.getSessionList().handleInput(CTRL_P);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(olderPath);
		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set());
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output.indexOf("Newer regular")).toBeLessThan(output.indexOf("Older pinned"));

		selector.getSessionList().handleInput(CTRL_P);
		expect(pinStore.getPinnedSessionPaths().size).toBe(1);
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output.indexOf("Older pinned")).toBeLessThan(output.indexOf("Newer regular"));
	});

	it("removes the persisted pin after deleting a pinned session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-selector-pin-delete-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir);
		const sessionPath = join(sessionDir, "session.jsonl");
		const pinStorePath = join(tempDir, "session-pins.json");
		writeSession(sessionPath, "session", tempDir, "2026-01-01T00:00:00.000Z", "Pinned session");
		const pinStore = new SessionPinStore(pinStorePath);
		pinStore.setPinned(sessionPath, true);
		const sessions = await SessionManager.list(tempDir, sessionDir);
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, pinStorePath },
		);
		await flushPromises();

		expect(selector.getSessionList().getSelectedSessionPath()).toBe(sessionPath);
		selector.getSessionList().handleInput(CTRL_D);
		selector.getSessionList().handleInput("\r");
		for (let attempt = 0; attempt < 20 && pinStore.getPinnedSessionPaths().size > 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(pinStore.getPinnedSessionPaths()).toEqual(new Set());
	});

	it("shows an error when the selected session disappears before pinning", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-selector-pin-missing-"));
		tempDirs.push(tempDir);
		const sessionPath = join(tempDir, "session.jsonl");
		const pinStorePath = join(tempDir, "session-pins.json");
		writeSession(sessionPath, "session", tempDir, "2026-01-01T00:00:00.000Z", "Missing session");
		const sessions = await SessionManager.list(tempDir, tempDir);
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, pinStorePath },
		);
		await flushPromises();
		rmSync(sessionPath);

		selector.getSessionList().handleInput(CTRL_P);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Failed to update pin: Session file no longer exists");
		expect(new SessionPinStore(pinStorePath).getPinnedSessionPaths()).toEqual(new Set());
	});
});
