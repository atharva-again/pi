#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { TelegramPiBot } from "./bot.ts";
import {
	formatTelegramHelp,
	getTelegramConfigPath,
	parseTelegramCliArgs,
	readTelegramConfigFile,
	type TelegramBotConfig,
	type TelegramConfigFile,
	writeTelegramConfigFile,
} from "./config.ts";
import { TelegramApi } from "./telegram-api.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

interface KeypressKey {
	name?: string;
	ctrl?: boolean;
	sequence?: string;
}

function csv(values: Set<string>): string {
	return [...values].join(",");
}

function parseCsv(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

let nonTtyLines: string[] | undefined;

function readNonTtyLine(defaultValue?: string): string {
	if (!nonTtyLines) {
		nonTtyLines = readFileSync(0, "utf-8").split(/\r?\n/);
	}
	return (nonTtyLines.shift() ?? "").trim() || defaultValue || "";
}

async function promptText(question: string, defaultValue?: string): Promise<string> {
	if (!input.isTTY) {
		return readNonTtyLine(defaultValue);
	}
	const rl = createInterface({ input, output });
	try {
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		const answer = await rl.question(`${question}${suffix}: `);
		return answer.trim() || defaultValue || "";
	} finally {
		rl.close();
	}
}

async function promptSecret(question: string, defaultValue?: string): Promise<string> {
	if (!input.isTTY) {
		return promptText(question, defaultValue);
	}
	const suffix = defaultValue ? " [saved]" : "";
	output.write(`${question}${suffix}: `);
	emitKeypressEvents(input);
	const wasRaw = input.isRaw;
	input.setRawMode(true);
	input.resume();
	return new Promise<string>((resolvePromise, reject) => {
		let buffer = "";
		const cleanup = (): void => {
			input.off("keypress", onKeypress);
			input.setRawMode(wasRaw);
		};
		const onKeypress = (text: string, key: KeypressKey): void => {
			if (key.ctrl && key.name === "c") {
				cleanup();
				output.write("\n");
				reject(new Error("Setup cancelled."));
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				cleanup();
				output.write("\n");
				resolvePromise(buffer.trim() || defaultValue || "");
				return;
			}
			if (key.name === "backspace" || key.sequence === "\u007f") {
				if (buffer.length > 0) {
					buffer = buffer.slice(0, -1);
					output.write("\b \b");
				}
				return;
			}
			if (text && !key.ctrl) {
				buffer += text;
				output.write("*");
			}
		};
		input.on("keypress", onKeypress);
	});
}

async function promptBoolean(question: string, defaultValue: boolean): Promise<boolean> {
	while (true) {
		const answer = (await promptText(question, yesNo(defaultValue))).toLowerCase();
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		console.error("Please answer yes or no.");
	}
}

async function runSetup(): Promise<void> {
	const existing = readTelegramConfigFile() ?? {};
	console.log("pi-tg setup\n");
	console.log("Create a bot with @BotFather, then paste the bot token here.");
	const token = await promptSecret("Bot token", existing.token);
	if (!token) {
		throw new Error("Bot token is required.");
	}
	const defaultAllowedUsers = existing.allowedUsers?.join(",") ?? "";
	const allowedUsers = parseCsv(await promptText("Allowed Telegram user IDs", defaultAllowedUsers));
	const defaultAllowedChats = existing.allowedChats?.join(",") ?? "";
	const allowedChats = parseCsv(await promptText("Allowed chat IDs (optional)", defaultAllowedChats));
	const allowAllUsers =
		allowedUsers.length === 0 && allowedChats.length === 0
			? await promptBoolean("No allowlist entered. Allow all Telegram users", existing.allowAllUsers ?? false)
			: false;
	if (!allowAllUsers && allowedUsers.length === 0 && allowedChats.length === 0) {
		throw new Error("Allowed user/chat is required unless you allow all Telegram users.");
	}
	const defaultCwd = resolve(await promptText("Default workspace", existing.defaultCwd ?? process.cwd()));
	if (!existsSync(defaultCwd)) {
		throw new Error(`Workspace does not exist: ${defaultCwd}`);
	}
	const projectTrust = await promptBoolean(
		"Auto-approve project-local files for spawned Pi runtimes",
		existing.projectTrust ?? true,
	);
	const config: TelegramConfigFile = {
		token,
		allowedUsers,
		allowedChats,
		allowAllUsers,
		defaultCwd,
		streaming: existing.streaming ?? "auto",
		pollTimeoutSeconds: existing.pollTimeoutSeconds ?? 25,
		projectTrust,
	};
	writeTelegramConfigFile(config);
	console.log(`\nSaved ${getTelegramConfigPath()}`);
	console.log("\nNext:");
	console.log("  pi-tg doctor");
	console.log("  pi-tg");
}

async function runDoctor(config: TelegramBotConfig): Promise<void> {
	console.log("pi-tg doctor\n");
	console.log(`Config: ${getTelegramConfigPath()}`);
	console.log(`Workspace: ${config.defaultCwd}`);
	console.log(`Allowed users: ${csv(config.allowedUsers) || "none"}`);
	console.log(`Allowed chats: ${csv(config.allowedChats) || "none"}`);
	console.log(`Allow all users: ${yesNo(config.allowAllUsers)}`);
	console.log(`Streaming: ${config.streaming}`);
	console.log(`Auto-approve project files: ${yesNo(config.projectTrust)}`);
	const bot = await new TelegramApi(config.token).getMe();
	console.log(`Bot: @${bot.username ?? bot.id}`);
	console.log("\nReady. Start with: pi-tg");
}

const parsed = parseTelegramCliArgs(process.argv.slice(2));

if (parsed.command === "help") {
	console.log(formatTelegramHelp(packageJson.version));
	process.exit(0);
}

if (parsed.command === "version") {
	console.log(packageJson.version);
	process.exit(0);
}

if (parsed.command === "setup") {
	try {
		await runSetup();
		process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (parsed.errors.length > 0 || !parsed.config) {
	for (const error of parsed.errors) {
		console.error(`Error: ${error}`);
	}
	console.error("");
	console.error(formatTelegramHelp(packageJson.version));
	process.exit(1);
}

if (parsed.command === "doctor") {
	try {
		await runDoctor(parsed.config);
		process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

const bot = new TelegramPiBot(parsed.config);
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<never> {
	if (shuttingDown) {
		process.exit(exitCode);
	}
	shuttingDown = true;
	await bot.stop();
	process.exit(exitCode);
}

process.on("SIGINT", () => {
	void shutdown(0);
});
process.on("SIGTERM", () => {
	void shutdown(0);
});

try {
	await bot.start();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	await shutdown(1);
}
