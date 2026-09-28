import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPiBot } from "../src/bot.ts";
import type { ConversationRef } from "../src/pi-manager.ts";

type RefreshState = Pick<RpcSessionState, "sessionFile" | "isStreaming" | "isCompacting">;

type RefreshBotContext = {
	manager: {
		getState(conversation: ConversationRef): Promise<RefreshState | undefined>;
		restoreSession(conversation: ConversationRef, sessionPath: string): Promise<RpcResponse>;
	};
	refreshChatCommandMenu(conversation: ConversationRef, force?: boolean): Promise<void>;
	sendText(conversation: ConversationRef, text: string, disableNotification: boolean): Promise<void>;
};

type TelegramPiBotPrototype = {
	handleRefresh(this: RefreshBotContext, conversation: ConversationRef): Promise<void>;
};

const botPrototype = TelegramPiBot.prototype as unknown as TelegramPiBotPrototype;
const conversation: ConversationRef = { key: "-123:7", chatId: "-123", threadId: "7", chatType: "supergroup" };
const testDirectories: string[] = [];

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-tg-refresh-test-"));
	testDirectories.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, "session fixture\n");
	return sessionFile;
}

function switchSessionResponse(cancelled = false): RpcResponse {
	return {
		type: "response",
		command: "switch_session",
		success: true,
		data: { cancelled },
	};
}

function createContext(state: RefreshState | undefined, response = switchSessionResponse()) {
	return {
		manager: {
			getState: vi.fn(async () => state),
			restoreSession: vi.fn(async () => response),
		},
		refreshChatCommandMenu: vi.fn(async () => {}),
		sendText: vi.fn(async () => {}),
	};
}

afterEach(() => {
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Telegram /refresh", () => {
	it("reloads the current topic's saved session from disk", async () => {
		const sessionFile = createSessionFile();
		const context = createContext({ sessionFile, isStreaming: false, isCompacting: false });

		await botPrototype.handleRefresh.call(context, conversation);

		expect(context.manager.getState).toHaveBeenCalledWith(conversation);
		expect(context.manager.restoreSession).toHaveBeenCalledWith(conversation, sessionFile);
		expect(context.refreshChatCommandMenu).toHaveBeenCalledWith(conversation, true);
		expect(context.sendText).toHaveBeenCalledWith(conversation, "Refreshed session from disk.", true);
	});

	it("refuses to refresh a busy or unsaved session", async () => {
		const busyContext = createContext({ sessionFile: createSessionFile(), isStreaming: true, isCompacting: false });
		await botPrototype.handleRefresh.call(busyContext, conversation);
		expect(busyContext.manager.restoreSession).not.toHaveBeenCalled();
		expect(busyContext.sendText).toHaveBeenCalledWith(
			conversation,
			"Pi is busy. Wait for the current response or compaction to finish, then refresh.",
			true,
		);

		const compactingContext = createContext({
			sessionFile: createSessionFile(),
			isStreaming: false,
			isCompacting: true,
		});
		await botPrototype.handleRefresh.call(compactingContext, conversation);
		expect(compactingContext.manager.restoreSession).not.toHaveBeenCalled();
		expect(compactingContext.sendText).toHaveBeenCalledWith(
			conversation,
			"Pi is busy. Wait for the current response or compaction to finish, then refresh.",
			true,
		);

		const unsavedContext = createContext({ isStreaming: false, isCompacting: false });
		await botPrototype.handleRefresh.call(unsavedContext, conversation);
		expect(unsavedContext.manager.restoreSession).not.toHaveBeenCalled();
		expect(unsavedContext.sendText).toHaveBeenCalledWith(conversation, "No saved session file to refresh.", true);
	});

	it("reports when the session status could not be checked", async () => {
		const context = createContext(undefined);

		await botPrototype.handleRefresh.call(context, conversation);

		expect(context.manager.restoreSession).not.toHaveBeenCalled();
		expect(context.sendText).toHaveBeenCalledWith(
			conversation,
			"Error: Could not check the current session status.",
			true,
		);
	});

	it("does not report success when an extension cancels the refresh", async () => {
		const sessionFile = createSessionFile();
		const context = createContext(
			{ sessionFile, isStreaming: false, isCompacting: false },
			switchSessionResponse(true),
		);

		await botPrototype.handleRefresh.call(context, conversation);

		expect(context.refreshChatCommandMenu).not.toHaveBeenCalled();
		expect(context.sendText).toHaveBeenCalledWith(conversation, "Refresh cancelled.", true);
	});

	it("requires the bound session file to exist", async () => {
		const sessionFile = join(tmpdir(), `pi-tg-missing-${Date.now()}.jsonl`);
		expect(existsSync(sessionFile)).toBe(false);
		const context = createContext({ sessionFile, isStreaming: false, isCompacting: false });

		await botPrototype.handleRefresh.call(context, conversation);

		expect(context.manager.restoreSession).not.toHaveBeenCalled();
		expect(context.sendText).toHaveBeenCalledWith(conversation, "No saved session file to refresh.", true);
	});
});
