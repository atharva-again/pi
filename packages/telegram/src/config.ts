import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
	command: "start" | "setup" | "doctor" | "help" | "version";
	config?: TelegramBotConfig;
	errors: string[];
}

export interface TelegramConfigFile {
	token?: string;
	allowedUsers?: string[];
	allowedChats?: string[];
	allowAllUsers?: boolean;
	defaultCwd?: string;
	streaming?: TelegramStreamingMode;
	pollTimeoutSeconds?: number;
	projectTrust?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string.`);
	}
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean.`);
	}
	return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number") {
		throw new Error(`${field} must be a number.`);
	}
	return value;
}

function stringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${field} must be an array of strings.`);
	}
	return value;
}

function asTelegramConfigFile(value: unknown): TelegramConfigFile {
	if (!isRecord(value)) {
		throw new Error("Config file must contain a JSON object.");
	}
	if (value.streaming !== undefined && typeof value.streaming !== "string") {
		throw new Error("streaming must be a string.");
	}
	const streaming = value.streaming === undefined ? undefined : parseStreamingMode(value.streaming);
	if (value.streaming !== undefined && !streaming) {
		throw new Error("Invalid streaming mode in config file. Use auto, draft, edit, or off.");
	}
	return {
		token: optionalString(value.token, "token"),
		allowedUsers: stringArray(value.allowedUsers, "allowedUsers"),
		allowedChats: stringArray(value.allowedChats, "allowedChats"),
		allowAllUsers: optionalBoolean(value.allowAllUsers, "allowAllUsers"),
		defaultCwd: optionalString(value.defaultCwd, "defaultCwd"),
		streaming,
		pollTimeoutSeconds: optionalNumber(value.pollTimeoutSeconds, "pollTimeoutSeconds"),
		projectTrust: optionalBoolean(value.projectTrust, "projectTrust"),
	};
}

export function getTelegramConfigPath(): string {
	return join(getAgentDir(), "telegram", "config.json");
}

export function readTelegramConfigFile(path = getTelegramConfigPath()): TelegramConfigFile | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return asTelegramConfigFile(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeTelegramConfigFile(config: TelegramConfigFile, path = getTelegramConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
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

function arraySet(value: string[] | undefined): Set<string> {
	return new Set(value ?? []);
}

function configSet(flagOrEnvValue: string | undefined, configValue: string[] | undefined): Set<string> {
	return flagOrEnvValue === undefined ? arraySet(configValue) : parseCsvSet(flagOrEnvValue);
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

function readConfigForCli(errors: string[]): TelegramConfigFile {
	try {
		return readTelegramConfigFile() ?? {};
	} catch (error) {
		errors.push(
			`Failed to read ${getTelegramConfigPath()}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
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

	const command = commandArg === "doctor" ? "doctor" : "start";
	const startArgs = commandArg === "start" || commandArg === "doctor" ? args.slice(1) : args;
	const errors: string[] = [];
	const fileConfig = readConfigForCli(errors);
	const token = getFlagValue(startArgs, "--token") ?? process.env.PI_TELEGRAM_BOT_TOKEN ?? fileConfig.token ?? "";
	const allowedUsersValue = getFlagValue(startArgs, "--allowed-users") ?? process.env.PI_TELEGRAM_ALLOWED_USERS;
	const allowedChatsValue = getFlagValue(startArgs, "--allowed-chats") ?? process.env.PI_TELEGRAM_ALLOWED_CHATS;
	const allowedUsers = configSet(allowedUsersValue, fileConfig.allowedUsers);
	const allowedChats = configSet(allowedChatsValue, fileConfig.allowedChats);
	const hasAllowlistOverride = allowedUsersValue !== undefined || allowedChatsValue !== undefined;
	const allowAllEnv = process.env.PI_TELEGRAM_ALLOW_ALL_USERS;
	const allowAllUsers = hasFlag(startArgs, "--allow-all-users")
		? true
		: allowAllEnv !== undefined
			? allowAllEnv === "1"
			: hasAllowlistOverride
				? false
				: (fileConfig.allowAllUsers ?? false);
	const defaultCwd = resolveCwd(
		getFlagValue(startArgs, "--cwd") ?? process.env.PI_TELEGRAM_CWD ?? fileConfig.defaultCwd,
	);
	const streaming = parseStreamingMode(
		getFlagValue(startArgs, "--streaming") ?? process.env.PI_TELEGRAM_STREAMING ?? fileConfig.streaming,
	);
	const pollTimeoutSeconds = parsePollTimeout(
		getFlagValue(startArgs, "--poll-timeout") ??
			process.env.PI_TELEGRAM_POLL_TIMEOUT_SECONDS ??
			(fileConfig.pollTimeoutSeconds === undefined ? undefined : String(fileConfig.pollTimeoutSeconds)),
	);
	const projectTrust = hasFlag(startArgs, "--no-approve-project")
		? false
		: process.env.PI_TELEGRAM_NO_APPROVE_PROJECT === "1"
			? false
			: (fileConfig.projectTrust ?? true);
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
		return { command, errors };
	}

	return {
		command,
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
	return `pi-tg v${version}\n\nUsage:\n  pi-tg                 Start using saved config\n  pi-tg setup           Create ${getTelegramConfigPath()}\n  pi-tg doctor          Validate config and bot token\n  pi-tg start [options] Start with flags/env overriding saved config\n  pi-tg --help\n  pi-tg --version\n\nInstall:\n  npm install -g pi-tg\n  pi-tg setup\n  pi-tg doctor\n  pi-tg\n\nOptions:\n  --token <token>             Telegram bot token (or PI_TELEGRAM_BOT_TOKEN)\n  --allowed-users <ids>       Comma-separated Telegram user IDs\n  --allowed-chats <ids>       Comma-separated chat IDs for group/topic use\n  --allow-all-users           Disable user allowlist (not recommended)\n  --cwd <path>                Default workspace for new chats/topics\n  --streaming <mode>          auto, draft, edit, or off (default: auto)\n  --poll-timeout <seconds>    Long-poll timeout, 1-50 seconds (default: 25)\n  --no-approve-project        Do not pass --approve to spawned pi RPC runtimes\n\nEnvironment overrides:\n  PI_TELEGRAM_BOT_TOKEN\n  PI_TELEGRAM_ALLOWED_USERS\n  PI_TELEGRAM_ALLOWED_CHATS\n  PI_TELEGRAM_ALLOW_ALL_USERS=1\n  PI_TELEGRAM_CWD\n  PI_TELEGRAM_STREAMING=auto|draft|edit|off\n`;
}

export function formatTelegramSetup(): string {
	return `Telegram setup\n\nRun:\n\n  pi-tg setup\n\nYou will need:\n  1. A bot token from @BotFather.\n  2. Your numeric Telegram user ID from @userinfobot.\n\nAfter setup:\n\n  pi-tg doctor\n  pi-tg\n`;
}
