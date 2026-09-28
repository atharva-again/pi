import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RefreshCommandContext = {
	session: { isStreaming: boolean; isBashRunning: boolean; isCompacting: boolean };
	sessionManager: { isPersisted(): boolean; getSessionFile(): string | undefined };
	showWarning(message: string): void;
	handleResumeSession(sessionPath: string, options?: unknown, successStatus?: string): Promise<{ cancelled: boolean }>;
};

type InteractiveModePrototype = {
	handleRefreshCommand(this: RefreshCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const testDirectories: string[] = [];

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-refresh-test-"));
	testDirectories.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, "session fixture\n");
	return sessionFile;
}

afterEach(() => {
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("InteractiveMode /refresh", () => {
	it("reopens the current saved session from disk", async () => {
		const sessionFile = createSessionFile();
		const handleResumeSession = vi.fn(async () => ({ cancelled: false }));
		const context: RefreshCommandContext = {
			session: { isStreaming: false, isBashRunning: false, isCompacting: false },
			sessionManager: { isPersisted: () => true, getSessionFile: () => sessionFile },
			showWarning: vi.fn(),
			handleResumeSession,
		};

		await interactiveModePrototype.handleRefreshCommand.call(context);

		expect(handleResumeSession).toHaveBeenCalledWith(sessionFile, undefined, "Refreshed session from disk");
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it.each(["streaming", "bash", "compacting"] as const)("refuses to refresh while %s", async (busyState) => {
		const sessionFile = createSessionFile();
		const handleResumeSession = vi.fn(async () => ({ cancelled: false }));
		const context: RefreshCommandContext = {
			session: {
				isStreaming: busyState === "streaming",
				isBashRunning: busyState === "bash",
				isCompacting: busyState === "compacting",
			},
			sessionManager: { isPersisted: () => true, getSessionFile: () => sessionFile },
			showWarning: vi.fn(),
			handleResumeSession,
		};

		await interactiveModePrototype.handleRefreshCommand.call(context);

		expect(handleResumeSession).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledOnce();
	});

	it("refuses to refresh when there is no saved session file", async () => {
		const handleResumeSession = vi.fn(async () => ({ cancelled: false }));
		const context: RefreshCommandContext = {
			session: { isStreaming: false, isBashRunning: false, isCompacting: false },
			sessionManager: { isPersisted: () => false, getSessionFile: () => undefined },
			showWarning: vi.fn(),
			handleResumeSession,
		};

		await interactiveModePrototype.handleRefreshCommand.call(context);

		expect(handleResumeSession).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith("No saved session file to refresh.");
	});
});
