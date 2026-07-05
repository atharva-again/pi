#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramPiBot } from "./bot.ts";
import { formatTelegramHelp, formatTelegramSetup, parseTelegramCliArgs } from "./config.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

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
	console.log(formatTelegramSetup());
	process.exit(0);
}

if (parsed.errors.length > 0 || !parsed.config) {
	for (const error of parsed.errors) {
		console.error(`Error: ${error}`);
	}
	console.error("");
	console.error(formatTelegramHelp(packageJson.version));
	process.exit(1);
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
