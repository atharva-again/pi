import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionPinStore } from "../src/core/session-pin-store.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SessionSelectorFactory = (done: () => void) => { component: Component; focus: Component };

type SessionSelectorContext = {
	showSelector: (create: SessionSelectorFactory) => void;
	sessionManager: {
		getCwd: () => string;
		getSessionDir: () => string;
		usesDefaultSessionDir: () => boolean;
		getSessionFile: () => string | undefined;
	};
	runtimeHost: { services: { agentDir: string } };
	keybindings: KeybindingsManager;
	ui: { requestRender: () => void };
	handleResumeSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	shutdown: () => Promise<void>;
};

type InteractiveModePrototype = {
	showSessionSelector(this: SessionSelectorContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const CTRL_P = "\x10";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

describe("InteractiveMode session pins", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores pins under the runtime-specific agent directory", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-interactive-session-pin-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "custom-agent");
		const sessionDir = join(tempDir, "sessions");
		const cwd = join(tempDir, "project");
		mkdirSync(sessionDir);
		const sessionPath = join(sessionDir, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		vi.spyOn(SessionManager, "list").mockResolvedValue([
			{
				path: sessionPath,
				id: "session",
				cwd,
				created: new Date("2026-01-01T00:00:00.000Z"),
				modified: new Date("2026-01-01T00:00:00.000Z"),
				messageCount: 0,
				firstMessage: "(no messages)",
				allMessagesText: "",
			},
		]);
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		let selector:
			| (Component & { getSessionList: () => Component & { getSelectedSessionPath: () => string | undefined } })
			| undefined;
		const context: SessionSelectorContext = {
			showSelector: (create) => {
				selector = create(() => {}).component as Component & {
					getSessionList: () => Component & { getSelectedSessionPath: () => string | undefined };
				};
			},
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => sessionDir,
				usesDefaultSessionDir: () => false,
				getSessionFile: () => undefined,
			},
			runtimeHost: { services: { agentDir } },
			keybindings,
			ui: { requestRender: vi.fn() },
			handleResumeSession: async () => ({ cancelled: false }),
			shutdown: async () => {},
		};

		interactiveModePrototype.showSessionSelector.call(context);
		for (let attempt = 0; attempt < 20 && !selector?.getSessionList().getSelectedSessionPath(); attempt++) {
			await flushPromises();
		}
		expect(selector?.getSessionList().getSelectedSessionPath()).toBe(sessionPath);
		selector?.handleInput?.(CTRL_P);

		const pinStorePath = join(agentDir, "session-pins.json");
		expect(existsSync(pinStorePath)).toBe(true);
		expect(new SessionPinStore(pinStorePath).getPinnedSessionPaths().size).toBe(1);
	});
});
