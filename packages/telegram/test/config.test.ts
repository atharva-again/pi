import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../coding-agent/src/core/slash-commands.ts";
import {
	PI_BUILTIN_SLASH_COMMANDS,
	TELEGRAM_BOT_COMMANDS,
	TELEGRAM_GROUP_COMMANDS,
	TELEGRAM_NATIVE_COMMANDS,
	TELEGRAM_PI_COMMANDS,
} from "../src/bot.ts";
import { parseTelegramCliArgs, type TelegramStreamingMode, writeTelegramConfigFile } from "../src/config.ts";
import { conversationKey } from "../src/store.ts";
import {
	formatTelegramMarkdown,
	splitTelegramText,
	truncateTelegramButtonText,
	truncateTelegramText,
} from "../src/text.ts";

const TELEGRAM_CONFIG_ENV_VARS = [
	"PI_TELEGRAM_BOT_TOKEN",
	"PI_TELEGRAM_ALLOWED_USERS",
	"PI_TELEGRAM_ALLOWED_CHATS",
	"PI_TELEGRAM_ALLOW_ALL_USERS",
	"PI_TELEGRAM_CWD",
	"PI_TELEGRAM_STREAMING",
	"PI_TELEGRAM_POLL_TIMEOUT_SECONDS",
	"PI_TELEGRAM_NO_APPROVE_PROJECT",
	"PI_CODING_AGENT_DIR",
] as const;

function withIsolatedConfig(fn: () => void): void {
	const previousEnv = new Map<string, string | undefined>();
	for (const name of TELEGRAM_CONFIG_ENV_VARS) {
		previousEnv.set(name, process.env[name]);
		delete process.env[name];
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		fn();
	} finally {
		for (const name of TELEGRAM_CONFIG_ENV_VARS) {
			const previousValue = previousEnv.get(name);
			if (previousValue === undefined) delete process.env[name];
			else process.env[name] = previousValue;
		}
		rmSync(agentDir, { force: true, recursive: true });
	}
}

describe("telegram config", () => {
	it("requires token and authorization", () => {
		withIsolatedConfig(() => {
			const parsed = parseTelegramCliArgs(["start"]);
			expect(parsed.errors).toContain("Missing Telegram bot token. Set PI_TELEGRAM_BOT_TOKEN or pass --token.");
			expect(parsed.errors).toContain(
				"Missing authorization allowlist. Set PI_TELEGRAM_ALLOWED_USERS, PI_TELEGRAM_ALLOWED_CHATS, or pass --allow-all-users.",
			);
		});
	});

	it("parses explicit startup options", () => {
		withIsolatedConfig(() => {
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

	it("loads saved setup config", () => {
		withIsolatedConfig(() => {
			writeTelegramConfigFile({
				token: "123:abc",
				allowedUsers: ["1"],
				defaultCwd: process.cwd(),
				streaming: "off",
				pollTimeoutSeconds: 10,
				projectTrust: false,
			});
			const parsed = parseTelegramCliArgs([]);
			expect(parsed.errors).toEqual([]);
			expect(parsed.config?.token).toBe("123:abc");
			expect(parsed.config?.allowedUsers.has("1")).toBe(true);
			expect(parsed.config?.streaming).toBe("off");
			expect(parsed.config?.pollTimeoutSeconds).toBe(10);
			expect(parsed.config?.projectTrust).toBe(false);
		});
	});

	it("lets explicit allowlists disable saved allow-all mode", () => {
		withIsolatedConfig(() => {
			writeTelegramConfigFile({
				token: "123:abc",
				allowAllUsers: true,
				defaultCwd: process.cwd(),
			});
			process.env.PI_TELEGRAM_ALLOWED_USERS = "1";
			const parsed = parseTelegramCliArgs([]);
			expect(parsed.errors).toEqual([]);
			expect(parsed.config?.allowAllUsers).toBe(false);
			expect(parsed.config?.allowedUsers.has("1")).toBe(true);
		});
	});

	it("rejects malformed saved config fields", () => {
		withIsolatedConfig(() => {
			writeTelegramConfigFile({
				token: "123:abc",
				allowedUsers: ["1"],
				defaultCwd: process.cwd(),
				streaming: false as unknown as TelegramStreamingMode,
			});
			const parsed = parseTelegramCliArgs([]);
			expect(parsed.errors.some((error) => error.startsWith("Failed to read"))).toBe(true);
			expect(parsed.errors.join("\n")).toContain("streaming must be a string.");
		});
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

	it("formats supported Telegram MarkdownV2", () => {
		expect(formatTelegramMarkdown("**Session** `/tmp/a_b` | ok.")).toBe("*Session* `/tmp/a_b` \\| ok\\.");
	});
});
