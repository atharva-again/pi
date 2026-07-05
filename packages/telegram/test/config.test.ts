import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../coding-agent/src/core/slash-commands.ts";
import {
	PI_BUILTIN_SLASH_COMMANDS,
	TELEGRAM_BOT_COMMANDS,
	TELEGRAM_GROUP_COMMANDS,
	TELEGRAM_NATIVE_COMMANDS,
	TELEGRAM_PI_COMMANDS,
} from "../src/bot.ts";
import { parseTelegramCliArgs } from "../src/config.ts";
import { conversationKey } from "../src/store.ts";
import { splitTelegramText, truncateTelegramButtonText, truncateTelegramText } from "../src/text.ts";

describe("telegram config", () => {
	it("requires token and authorization", () => {
		const previousToken = process.env.PI_TELEGRAM_BOT_TOKEN;
		const previousUsers = process.env.PI_TELEGRAM_ALLOWED_USERS;
		const previousChats = process.env.PI_TELEGRAM_ALLOWED_CHATS;
		delete process.env.PI_TELEGRAM_BOT_TOKEN;
		delete process.env.PI_TELEGRAM_ALLOWED_USERS;
		delete process.env.PI_TELEGRAM_ALLOWED_CHATS;
		try {
			const parsed = parseTelegramCliArgs(["start"]);
			expect(parsed.errors).toContain("Missing Telegram bot token. Set PI_TELEGRAM_BOT_TOKEN or pass --token.");
			expect(parsed.errors).toContain(
				"Missing authorization allowlist. Set PI_TELEGRAM_ALLOWED_USERS, PI_TELEGRAM_ALLOWED_CHATS, or pass --allow-all-users.",
			);
		} finally {
			if (previousToken === undefined) delete process.env.PI_TELEGRAM_BOT_TOKEN;
			else process.env.PI_TELEGRAM_BOT_TOKEN = previousToken;
			if (previousUsers === undefined) delete process.env.PI_TELEGRAM_ALLOWED_USERS;
			else process.env.PI_TELEGRAM_ALLOWED_USERS = previousUsers;
			if (previousChats === undefined) delete process.env.PI_TELEGRAM_ALLOWED_CHATS;
			else process.env.PI_TELEGRAM_ALLOWED_CHATS = previousChats;
		}
	});

	it("parses explicit startup options", () => {
		const parsed = parseTelegramCliArgs([
			"start",
			"--token",
			"123:abc",
			"--allowed-users",
			"1,2",
			"--streaming",
			"edit",
			"--cwd",
			process.cwd(),
		]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.config?.token).toBe("123:abc");
		expect(parsed.config?.allowedUsers.has("1")).toBe(true);
		expect(parsed.config?.streaming).toBe("edit");
	});
});

describe("telegram bot commands", () => {
	it("registers telegram-native commands plus the built-in pi commands", () => {
		expect(TELEGRAM_NATIVE_COMMANDS.map((command) => command.command)).toEqual(["start", "help"]);
		expect(TELEGRAM_PI_COMMANDS).toHaveLength(22);
		expect(TELEGRAM_BOT_COMMANDS).toHaveLength(24);
		expect(TELEGRAM_GROUP_COMMANDS.map((command) => command.command)).not.toContain("quit");
		expect(PI_BUILTIN_SLASH_COMMANDS).toEqual(BUILTIN_SLASH_COMMANDS);
		expect(TELEGRAM_PI_COMMANDS.map((command) => command.command)).toEqual(
			BUILTIN_SLASH_COMMANDS.map((command) => (command.name === "scoped-models" ? "scoped_models" : command.name)),
		);
	});
});

describe("telegram text helpers", () => {
	it("uses stable conversation keys", () => {
		expect(conversationKey("42")).toBe("42:root");
		expect(conversationKey("42", "7")).toBe("42:7");
	});

	it("truncates and splits long text", () => {
		const longText = "a".repeat(9000);
		expect(truncateTelegramText(longText, 20)).toBe("\n… truncated");
		expect(truncateTelegramButtonText("abcdef", 4)).toBe("abc…");
		expect(splitTelegramText(longText).length).toBeGreaterThan(1);
	});
});
