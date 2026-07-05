import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type TelegramStreamingMode = "auto" | "draft" | "edit" | "off";

export interface TelegramBotConfig {
	token: string;
	allowedUsers: Set<string>;
	allowedChats: Set<string>;
	allowAllUsers: boolean;
	defaultCwd: string;
	streaming: TelegramStreamingMode;
	pollTimeoutSeconds: number;
	projectTrust: boolean;
}

export interface CliParseResult {
	command: "start" | "setup" | "help" | "version";
	config?: TelegramBotConfig;
	errors: string[];
}

function getFlagValue(args: string[], name: string): string | undefined {
	const prefixed = `${name}=`;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === name) {
			return args[index + 1];
		}
		if (arg.startsWith(prefixed)) {
			return arg.slice(prefixed.length);
		}
	}
	return undefined;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function parseCsvSet(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
	);
}

function parseStreamingMode(value: string | undefined): TelegramStreamingMode | undefined {
	if (value === undefined || value === "") return "auto";
	if (value === "auto" || value === "draft" || value === "edit" || value === "off") {
		return value;
	}
	return undefined;
}

function parsePollTimeout(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return 25;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
		return undefined;
	}
	return parsed;
}

function resolveCwd(value: string | undefined): string {
	return resolve(value ?? process.cwd());
}

export function parseTelegramCliArgs(args: string[]): CliParseResult {
	const commandArg = args[0];
	if (commandArg === "--help" || commandArg === "-h" || commandArg === "help") {
		return { command: "help", errors: [] };
	}
	if (commandArg === "--version" || commandArg === "-v" || commandArg === "version") {
		return { command: "version", errors: [] };
	}
	if (commandArg === "setup") {
		return { command: "setup", errors: [] };
	}

	const startArgs = commandArg === "start" ? args.slice(1) : args;
	const token = getFlagValue(startArgs, "--token") ?? process.env.PI_TELEGRAM_BOT_TOKEN ?? "";
	const allowedUsers = parseCsvSet(
		getFlagValue(startArgs, "--allowed-users") ?? process.env.PI_TELEGRAM_ALLOWED_USERS,
	);
	const allowedChats = parseCsvSet(
		getFlagValue(startArgs, "--allowed-chats") ?? process.env.PI_TELEGRAM_ALLOWED_CHATS,
	);
	const allowAllUsers = hasFlag(startArgs, "--allow-all-users") || process.env.PI_TELEGRAM_ALLOW_ALL_USERS === "1";
	const defaultCwd = resolveCwd(getFlagValue(startArgs, "--cwd") ?? process.env.PI_TELEGRAM_CWD);
	const streaming = parseStreamingMode(getFlagValue(startArgs, "--streaming") ?? process.env.PI_TELEGRAM_STREAMING);
	const pollTimeoutSeconds = parsePollTimeout(
		getFlagValue(startArgs, "--poll-timeout") ?? process.env.PI_TELEGRAM_POLL_TIMEOUT_SECONDS,
	);
	const projectTrust =
		!hasFlag(startArgs, "--no-approve-project") && process.env.PI_TELEGRAM_NO_APPROVE_PROJECT !== "1";

	const errors: string[] = [];
	if (!token) {
		errors.push("Missing Telegram bot token. Set PI_TELEGRAM_BOT_TOKEN or pass --token.");
	}
	if (!allowAllUsers && allowedUsers.size === 0 && allowedChats.size === 0) {
		errors.push(
			"Missing authorization allowlist. Set PI_TELEGRAM_ALLOWED_USERS, PI_TELEGRAM_ALLOWED_CHATS, or pass --allow-all-users.",
		);
	}
	if (!existsSync(defaultCwd)) {
		errors.push(`Workspace does not exist: ${defaultCwd}`);
	}
	if (!streaming) {
		errors.push("Invalid streaming mode. Use auto, draft, edit, or off.");
	}
	if (pollTimeoutSeconds === undefined) {
		errors.push("Invalid poll timeout. Use a number from 1 to 50 seconds.");
	}

	if (errors.length > 0 || !streaming || pollTimeoutSeconds === undefined) {
		return { command: "start", errors };
	}

	return {
		command: "start",
		config: {
			token,
			allowedUsers,
			allowedChats,
			allowAllUsers,
			defaultCwd,
			streaming,
			pollTimeoutSeconds,
			projectTrust,
		},
		errors,
	};
}

export function formatTelegramHelp(version: string): string {
	return `pi-telegram v${version}\n\nUsage:\n  pi-telegram start [options]\n  pi-telegram setup\n  pi-telegram --help\n  pi-telegram --version\n\nOptions:\n  --token <token>             Telegram bot token (or PI_TELEGRAM_BOT_TOKEN)\n  --allowed-users <ids>       Comma-separated Telegram user IDs\n  --allowed-chats <ids>       Comma-separated chat IDs for group/topic use\n  --allow-all-users           Disable user allowlist (not recommended)\n  --cwd <path>                Default workspace for new chats/topics\n  --streaming <mode>          auto, draft, edit, or off (default: auto)\n  --poll-timeout <seconds>    Long-poll timeout, 1-50 seconds (default: 25)\n  --no-approve-project        Do not pass --approve to spawned pi RPC runtimes\n\nEnvironment:\n  PI_TELEGRAM_BOT_TOKEN\n  PI_TELEGRAM_ALLOWED_USERS\n  PI_TELEGRAM_ALLOWED_CHATS\n  PI_TELEGRAM_ALLOW_ALL_USERS=1\n  PI_TELEGRAM_CWD\n  PI_TELEGRAM_STREAMING=auto|draft|edit|off\n\nFirst run:\n  1. Create a bot with @BotFather.\n  2. Find your numeric Telegram user ID with @userinfobot.\n  3. Run:\n\n     PI_TELEGRAM_BOT_TOKEN=123:abc PI_TELEGRAM_ALLOWED_USERS=123456789 pi-telegram\n`;
}

export function formatTelegramSetup(): string {
	return `Telegram setup\n\n1. Open @BotFather and send /newbot.\n2. Copy the bot token.\n3. Open @userinfobot and copy your numeric Telegram user ID.\n4. Start pi-telegram:\n\n   PI_TELEGRAM_BOT_TOKEN=<token> \\\n   PI_TELEGRAM_ALLOWED_USERS=<your-user-id> \\\n   pi-telegram\n\nOptional topic mode:\n  In @BotFather, open your bot -> Bot Settings -> Threads Settings.\n  Enable Threaded Mode and allow users to create topics. Then send /topic to the bot.\n`;
}
