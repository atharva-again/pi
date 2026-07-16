import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	SessionStats,
	SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { TelegramBotConfig } from "./config.ts";
import { type ConversationRef, listRecentSessions, PiConversationManager, resolveSessionPath } from "./pi-manager.ts";
import { TelegramBindingStore } from "./store.ts";
import {
	type BotCommand,
	type InlineKeyboardButton,
	type InlineKeyboardMarkup,
	TelegramApi,
	TelegramApiError,
	type TelegramCallbackQuery,
	type TelegramDocument,
	type TelegramMessage,
	type TelegramUpdate,
	type TelegramUser,
} from "./telegram-api.ts";
import {
	extractMessageText,
	formatError,
	splitTelegramText,
	truncateTelegramButtonText,
	truncateTelegramText,
} from "./text.ts";

interface StreamingState {
	previewMessageId?: number;
	statusMessageId?: number;
	lastPreviewAt: number;
	lastText: string;
	typingInterval?: NodeJS.Timeout;
}

interface PendingUiRequest {
	conversationKey: string;
	requestId: string;
	kind: "confirm" | "select";
	value: string;
}

type ThinkingLevel = RpcSessionState["thinkingLevel"];
type AvailableModel = Extract<
	RpcResponse,
	{ success: true; command: "get_available_models" }
>["data"]["models"][number];
type ScopedModel = Extract<
	RpcResponse,
	{ success: true; command: "get_scoped_models" }
>["data"]["scopedModels"][number];
type AgentEventMessage = Extract<
	AgentSessionEvent,
	{ type: "message_end" | "message_start" | "message_update" }
>["message"];
type AssistantEventMessage = Extract<AgentEventMessage, { role: "assistant" }>;
type DynamicCommand = Extract<RpcResponse, { success: true; command: "get_commands" }>["data"]["commands"][number];
type DynamicCommandMenu = {
	aliases: Map<string, string>;
	commands: BotCommand[];
	skipped: Array<{ name: string; reason: string }>;
};
type ResumeScope = "workspace" | "all";

type TreeNodeDisplay = { id: string; label: string; depth: number; entry: SessionTreeNode["entry"] };
type ToolCallInfo = { name: string; arguments: Record<string, unknown> };

type PendingChatInput =
	| { type: "name" }
	| { type: "workspace" }
	| { type: "compact_instructions" }
	| { type: "import_jsonl" };

type TelegramCallbackAction =
	| { type: "abort" }
	| { type: "show_help" }
	| { type: "show_settings" }
	| { type: "show_model_providers" }
	| { type: "show_model_provider"; provider: string; page: number }
	| { type: "select_model"; provider: string; modelId: string }
	| { type: "show_thinking" }
	| { type: "set_thinking"; level: ThinkingLevel; source?: "model" | "settings" | "scoped" }
	| { type: "show_scoped_models" }
	| { type: "select_scoped_model"; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
	| { type: "edit_scoped_models"; provider?: string; page?: number }
	| { type: "toggle_scoped_model"; provider: string; modelId: string; page: number }
	| { type: "clear_scoped_models" }
	| { type: "save_scoped_models" }
	| { type: "show_export" }
	| { type: "export"; format: "html" | "jsonl" }
	| { type: "prompt_import" }
	| { type: "confirm_share" }
	| { type: "share" }
	| { type: "prompt_name" }
	| { type: "prompt_workspace" }
	| { type: "show_session" }
	| { type: "show_changelog"; page: number }
	| { type: "show_fork"; page: number }
	| { type: "fork"; entryId: string }
	| { type: "clone" }
	| { type: "show_tree"; page: number }
	| { type: "navigate_tree"; entryId: string }
	| { type: "show_trust" }
	| { type: "show_login" }
	| { type: "show_logout" }
	| { type: "new_session" }
	| { type: "show_compact" }
	| { type: "compact_now" }
	| { type: "prompt_compact" }
	| { type: "show_resume"; page: number; query?: string; scope?: ResumeScope }
	| { type: "resume"; sessionPath: string }
	| { type: "reload" }
	| { type: "quit" };

interface PiBuiltinCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const PI_BUILTIN_SLASH_COMMANDS: ReadonlyArray<PiBuiltinCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit pi" },
];

const TELEGRAM_COMMAND_ALIASES = new Map<string, string>([["scoped-models", "scoped_models"]]);
const TELEGRAM_COMMAND_DESCRIPTIONS = new Map<string, string>([["scoped-models", "Switch or configure scoped models"]]);
const PI_COMMAND_ALIASES = new Map<string, string>([["scoped_models", "scoped-models"]]);

export const TELEGRAM_NATIVE_COMMANDS: BotCommand[] = [
	{ command: "start", description: "Start the Telegram client" },
	{ command: "help", description: "Show Telegram help" },
];

export const TELEGRAM_PI_COMMANDS: BotCommand[] = PI_BUILTIN_SLASH_COMMANDS.map((command) => ({
	command: TELEGRAM_COMMAND_ALIASES.get(command.name) ?? command.name,
	description: TELEGRAM_COMMAND_DESCRIPTIONS.get(command.name) ?? command.description,
}));

export const TELEGRAM_BOT_COMMANDS: BotCommand[] = [...TELEGRAM_NATIVE_COMMANDS, ...TELEGRAM_PI_COMMANDS];
export const TELEGRAM_GROUP_COMMANDS: BotCommand[] = TELEGRAM_BOT_COMMANDS.filter(
	(command) => command.command !== "quit",
);

const STATIC_REAL_COMMANDS = new Set([
	...TELEGRAM_NATIVE_COMMANDS.map((command) => command.command),
	...PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
]);
const RESERVED_TELEGRAM_COMMANDS = new Set([
	...TELEGRAM_BOT_COMMANDS.map((command) => command.command),
	...PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
]);
const MAX_TELEGRAM_COMMANDS = 100;
const MAX_TELEGRAM_COMMAND_LENGTH = 32;
const MAX_TELEGRAM_COMMAND_DESCRIPTION_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function userId(user: TelegramUser | undefined): string | undefined {
	return user ? String(user.id) : undefined;
}

function chatId(message: TelegramMessage): string {
	return String(message.chat.id);
}

function threadId(message: TelegramMessage): string | undefined {
	if (message.chat.type === "private" && message.message_thread_id === 1) {
		return undefined;
	}
	return message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
}

function commandParts(text: string, botUsername: string | undefined): { command: string; args: string } | undefined {
	if (!text.startsWith("/")) {
		return undefined;
	}
	const [rawCommand = "", ...rest] = text.trim().split(/\s+/);
	const withoutSlash = rawCommand.slice(1);
	const [name, mention] = withoutSlash.split("@");
	if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
		return undefined;
	}
	return { command: PI_COMMAND_ALIASES.get(name.toLowerCase()) ?? name.toLowerCase(), args: rest.join(" ").trim() };
}

function telegramCommandAlias(command: string): string | undefined {
	const alias = command
		.trim()
		.replace(/^\/+/, "")
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, MAX_TELEGRAM_COMMAND_LENGTH);
	return alias.length > 0 ? alias : undefined;
}

function truncateTelegramCommandDescription(description: string): string {
	const normalized = description.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_TELEGRAM_COMMAND_DESCRIPTION_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_TELEGRAM_COMMAND_DESCRIPTION_LENGTH - 1)}…`;
}

function pathCommandArgument(args: string): string | undefined {
	const trimmed = args.trimStart();
	if (!trimmed) {
		return undefined;
	}
	const firstChar = trimmed[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = trimmed.indexOf(firstChar, 1);
		return closingQuoteIndex < 0 ? undefined : trimmed.slice(1, closingQuoteIndex);
	}
	const firstWhitespaceIndex = trimmed.search(/\s/);
	return firstWhitespaceIndex < 0 ? trimmed : trimmed.slice(0, firstWhitespaceIndex);
}

function redactToken(text: string): string {
	return text.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<telegram-token>");
}

function isPrivateChat(message: TelegramMessage): boolean {
	return message.chat.type === "private";
}

function isSuccess(response: RpcResponse): boolean {
	return response.success === true;
}

function responseError(response: RpcResponse): string {
	return response.success ? "Unknown error" : response.error;
}

function isCommandResponse<T extends RpcResponse["command"]>(
	response: RpcResponse,
	command: T,
): response is Extract<RpcResponse, { success: true; command: T }> {
	return response.success === true && response.command === command;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function modelReference(model: AvailableModel): string {
	return `${model.provider}/${model.id}`;
}

function modelButtonLabel(model: AvailableModel, selected: boolean): string {
	const prefix = selected ? "✓ " : "";
	return truncateTelegramButtonText(`${prefix}${model.name || model.id}`, 46);
}

export function supportedThinkingLevels(model: AvailableModel | undefined): ThinkingLevel[] {
	return model ? getSupportedThinkingLevels(model) : ["off"];
}

export function formatThinkingLevelConfirmation(
	requestedLevel: ThinkingLevel,
	state: Pick<RpcSessionState, "thinkingLevel"> | undefined,
): string {
	return `Thinking level set to ${state?.thinkingLevel ?? requestedLevel}`;
}

function parseModelArgs(args: string): { modelRef: string; thinkingLevel?: ThinkingLevel } | undefined {
	const trimmed = args.trim();
	if (!trimmed) {
		return undefined;
	}
	const tokens = trimmed.split(/\s+/);
	const last = tokens.at(-1);
	if (last && isThinkingLevel(last) && tokens.length > 1) {
		return { modelRef: tokens.slice(0, -1).join(" "), thinkingLevel: last };
	}
	return { modelRef: trimmed };
}

function markdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatMarkdownTable(headers: [string, string], rows: Array<[string, string]>): string {
	return [
		`| ${headers.map(markdownTableCell).join(" | ")} |`,
		"| --- | --- |",
		...rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`),
	].join("\n");
}

function formatCurrentModelTable(state: RpcSessionState | undefined): string {
	const model = state?.model ? `${state.model.provider}/${state.model.id}` : "none";
	return formatMarkdownTable(
		["Setting", "Value"],
		[
			["Model", model],
			["Thinking", state?.thinkingLevel ?? "unknown"],
		],
	);
}

function formatSettingsTable(options: {
	state: RpcSessionState | undefined;
	workspace: string;
	streaming: string;
	projectTrust: boolean;
}): string {
	const model = options.state?.model ? `${options.state.model.provider}/${options.state.model.id}` : "none";
	return formatMarkdownTable(
		["Setting", "Value"],
		[
			["Model", model],
			["Thinking", options.state?.thinkingLevel ?? "unknown"],
			["Workspace", options.workspace],
			["Streaming", options.streaming],
			["Auto-approve tools", options.projectTrust ? "on" : "off"],
		],
	);
}

function formatSessionStats(stats: SessionStats, sessionName: string): string {
	const sessionRows: Array<[string, string]> = [
		["Name", sessionName],
		["ID", stats.sessionId],
		["File", stats.sessionFile ? basename(stats.sessionFile) : "In-memory"],
	];

	const tokenRows: Array<[string, string]> = [
		["Input", stats.tokens.input.toLocaleString()],
		["Output", stats.tokens.output.toLocaleString()],
	];
	if (stats.tokens.cacheRead > 0) {
		tokenRows.push(["Cache read", stats.tokens.cacheRead.toLocaleString()]);
	}
	if (stats.tokens.cacheWrite > 0) {
		tokenRows.push(["Cache write", stats.tokens.cacheWrite.toLocaleString()]);
	}
	tokenRows.push(["Total", stats.tokens.total.toLocaleString()]);
	if (stats.cost > 0) {
		tokenRows.push(["Cost", `$${stats.cost.toFixed(4)}`]);
	}

	return [
		"**Session**",
		"",
		formatMarkdownTable(["Field", "Value"], sessionRows),
		"",
		"**Messages**",
		"",
		formatMarkdownTable(
			["Type", "Count"],
			[
				["User", stats.userMessages.toLocaleString()],
				["Assistant", stats.assistantMessages.toLocaleString()],
				["Tool calls", stats.toolCalls.toLocaleString()],
				["Tool results", stats.toolResults.toLocaleString()],
				["Total", stats.totalMessages.toLocaleString()],
			],
		),
		"",
		"**Tokens**",
		"",
		formatMarkdownTable(["Type", "Count"], tokenRows),
	].join("\n");
}

function changelogSections(): string[] {
	const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const changelog = readFileSync(join(dirname(codingAgentEntry), "..", "CHANGELOG.md"), "utf8").trim();
	const releaseMatches = [...changelog.matchAll(/^## /gm)];
	if (releaseMatches.length === 0) {
		return [changelog];
	}
	return releaseMatches.map((match, index) => {
		const end = releaseMatches[index + 1]?.index ?? changelog.length;
		return changelog.slice(match.index, end).trim();
	});
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
	});
}

export class TelegramPiBot {
	private readonly config: TelegramBotConfig;
	private readonly api: TelegramApi;
	private readonly store: TelegramBindingStore;
	private readonly manager: PiConversationManager;
	private readonly streaming = new Map<string, StreamingState>();
	private readonly pendingUi = new Map<string, PendingUiRequest>();
	private readonly pendingActions = new Map<string, TelegramCallbackAction>();
	private readonly pendingInputs = new Map<string, PendingChatInput>();
	private readonly pendingScopedModels = new Map<string, Set<string>>();
	private readonly eventQueues = new Map<string, Promise<void>>();
	private readonly dynamicCommandAliases = new Map<string, Map<string, string>>();
	private readonly commandMenuSignatures = new Map<string, string>();
	private botUser: TelegramUser | undefined;
	private stopping = false;

	constructor(config: TelegramBotConfig, api = new TelegramApi(config.token), store = new TelegramBindingStore()) {
		this.config = config;
		this.api = api;
		this.store = store;
		this.manager = new PiConversationManager({
			defaultCwd: config.defaultCwd,
			projectTrust: config.projectTrust,
			store,
			onEvent: (conversation, event) => {
				this.enqueueAgentEvent(conversation, event);
			},
			onUiRequest: (conversation, request) => {
				void this.handleUiRequest(conversation, request).catch((error) => {
					console.error(`Telegram extension UI error: ${redactToken(formatError(error))}`);
				});
			},
			onExit: (conversation, error) => {
				void this.sendText(
					conversation,
					`Pi runtime stopped${error ? `: ${redactToken(error.message)}` : "."}`,
					true,
				).catch((sendError) => {
					console.error(`Telegram runtime exit notification error: ${redactToken(formatError(sendError))}`);
				});
			},
		});
	}

	private enqueueAgentEvent(conversation: ConversationRef, event: AgentSessionEvent): void {
		const previous = this.eventQueues.get(conversation.key) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => this.handleAgentEvent(conversation, event))
			.catch((error) => {
				console.error(`Telegram event handling error: ${redactToken(formatError(error))}`);
			});
		this.eventQueues.set(conversation.key, next);
		void next.finally(() => {
			if (this.eventQueues.get(conversation.key) === next) {
				this.eventQueues.delete(conversation.key);
			}
		});
	}

	async start(): Promise<void> {
		this.botUser = await this.api.getMe();
		try {
			await this.registerCommandMenus();
		} catch (error) {
			console.error(`Failed to register Telegram command menu: ${redactToken(formatError(error))}`);
		}
		console.log(`pi-tg connected as @${this.botUser.username ?? this.botUser.id}`);
		console.log(`default workspace: ${this.config.defaultCwd}`);
		console.log(`streaming: ${this.config.streaming}`);
		let offset: number | undefined;
		while (!this.stopping) {
			try {
				const updates = await this.api.getUpdates({ offset, timeout: this.config.pollTimeoutSeconds });
				for (const update of updates) {
					await this.handleUpdate(update);
					offset = update.update_id + 1;
				}
			} catch (error) {
				const message = error instanceof TelegramApiError ? error.message : formatError(error);
				console.error(`Telegram polling error: ${redactToken(message)}`);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		await this.manager.dispose();
	}

	private async registerCommandMenus(): Promise<void> {
		await this.api.setMyCommands(TELEGRAM_BOT_COMMANDS, { type: "default" });
		await this.api.setMyCommands(TELEGRAM_BOT_COMMANDS, { type: "all_private_chats" });
		await this.api.setMyCommands(TELEGRAM_GROUP_COMMANDS, { type: "all_group_chats" });
	}

	private baseCommandsForConversation(conversation: ConversationRef): BotCommand[] {
		return conversation.chatType === "private" ? TELEGRAM_BOT_COMMANDS : TELEGRAM_GROUP_COMMANDS;
	}

	private buildDynamicCommandMenu(conversation: ConversationRef, commands: DynamicCommand[]): DynamicCommandMenu {
		const baseCommands = this.baseCommandsForConversation(conversation);
		const aliases = new Map<string, string>();
		const visibleCommands: BotCommand[] = [];
		const skipped: DynamicCommandMenu["skipped"] = [];
		const visibleLimit = Math.max(0, MAX_TELEGRAM_COMMANDS - baseCommands.length);

		for (const command of [...commands].sort((left, right) => left.name.localeCompare(right.name))) {
			const realCommand = command.name.trim().replace(/^\/+/, "");
			if (!realCommand || STATIC_REAL_COMMANDS.has(realCommand)) {
				continue;
			}
			const alias = telegramCommandAlias(realCommand);
			if (!alias) {
				skipped.push({ name: realCommand, reason: "no Telegram-safe alias" });
				continue;
			}
			if (RESERVED_TELEGRAM_COMMANDS.has(alias)) {
				skipped.push({ name: realCommand, reason: `alias /${alias} conflicts with a built-in command` });
				continue;
			}
			if (aliases.has(alias)) {
				skipped.push({ name: realCommand, reason: `alias /${alias} conflicts with another workspace command` });
				continue;
			}
			aliases.set(alias, realCommand);
			if (visibleCommands.length < visibleLimit) {
				const description =
					truncateTelegramCommandDescription(command.description ?? "") || `${command.source} command`;
				visibleCommands.push({
					command: alias,
					description,
				});
			} else {
				skipped.push({ name: realCommand, reason: "Telegram command menu is full" });
			}
		}

		return { aliases, commands: visibleCommands, skipped };
	}

	private async refreshChatCommandMenu(conversation: ConversationRef, force = false): Promise<void> {
		try {
			const response = await this.manager.sendCommand(conversation, { type: "get_commands" });
			if (!isCommandResponse(response, "get_commands")) {
				console.error(`Failed to load Pi commands: ${redactToken(responseError(response))}`);
				return;
			}

			const dynamicMenu = this.buildDynamicCommandMenu(conversation, response.data.commands);
			this.dynamicCommandAliases.set(conversation.chatId, dynamicMenu.aliases);
			const commands = [...this.baseCommandsForConversation(conversation), ...dynamicMenu.commands];
			const signature = JSON.stringify(commands);
			if (!force && this.commandMenuSignatures.get(conversation.chatId) === signature) {
				return;
			}

			await this.api.setMyCommands(commands, { type: "chat", chat_id: conversation.chatId });
			this.commandMenuSignatures.set(conversation.chatId, signature);
		} catch (error) {
			console.error(`Failed to refresh Telegram command menu: ${redactToken(formatError(error))}`);
		}
	}

	private async ensureChatCommandMenu(conversation: ConversationRef): Promise<void> {
		if (this.commandMenuSignatures.has(conversation.chatId)) {
			return;
		}
		await this.refreshChatCommandMenu(conversation);
	}

	private async resolveTelegramCommand(conversation: ConversationRef, command: string): Promise<string> {
		const cached = this.dynamicCommandAliases.get(conversation.chatId)?.get(command);
		if (cached) {
			return cached;
		}
		if (STATIC_REAL_COMMANDS.has(command)) {
			return command;
		}
		await this.refreshChatCommandMenu(conversation);
		return this.dynamicCommandAliases.get(conversation.chatId)?.get(command) ?? command;
	}

	private conversationFromMessage(message: TelegramMessage): ConversationRef {
		const id = chatId(message);
		const topic = threadId(message);
		return {
			key: topic ? `${id}:${topic}` : `${id}:root`,
			chatId: id,
			threadId: topic,
			chatType: message.chat.type,
		};
	}

	private isAuthorized(message: TelegramMessage): boolean {
		if (this.config.allowAllUsers) {
			return true;
		}
		const sender = userId(message.from);
		if (sender && this.config.allowedUsers.has(sender)) {
			return true;
		}
		return this.config.allowedChats.has(chatId(message));
	}

	private isAuthorizedCallback(query: TelegramCallbackQuery): boolean {
		if (this.config.allowAllUsers) {
			return true;
		}
		const sender = userId(query.from);
		if (sender && this.config.allowedUsers.has(sender)) {
			return true;
		}
		return query.message ? this.config.allowedChats.has(chatId(query.message)) : false;
	}

	private shouldProcessGroupMessage(message: TelegramMessage, text: string, command: boolean): boolean {
		if (isPrivateChat(message)) {
			return true;
		}
		if (command) {
			return true;
		}
		const username = this.botUser?.username;
		if (username && text.toLowerCase().includes(`@${username.toLowerCase()}`)) {
			return true;
		}
		const repliedBotId = message.reply_to_message?.from?.id;
		return repliedBotId !== undefined && this.botUser !== undefined && repliedBotId === this.botUser.id;
	}

	private cleanBotMention(text: string): string {
		const username = this.botUser?.username;
		if (!username) {
			return text;
		}
		return text.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (update.callback_query) {
			await this.handleCallback(update.callback_query);
			return;
		}
		const message = update.message;
		if (!message) {
			return;
		}
		await this.handleMessage(message);
	}

	private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
		if (!this.isAuthorizedCallback(query)) {
			await this.api.answerCallbackQuery({ callbackQueryId: query.id, text: "Not authorized" });
			return;
		}
		const data = query.data;
		if (data?.startsWith("ui:")) {
			await this.handleExtensionUiCallback(query, data.slice(3));
			return;
		}
		if (data?.startsWith("tg:")) {
			await this.handleTelegramCallback(query, data.slice(3));
			return;
		}
		await this.api.answerCallbackQuery({ callbackQueryId: query.id });
	}

	private async handleExtensionUiCallback(query: TelegramCallbackQuery, pendingId: string): Promise<void> {
		const pending = this.pendingUi.get(pendingId);
		if (!pending) {
			await this.api.answerCallbackQuery({ callbackQueryId: query.id, text: "Request expired" });
			return;
		}
		this.pendingUi.delete(pendingId);
		let response: RpcExtensionUIResponse;
		if (pending.kind === "confirm") {
			response = { type: "extension_ui_response", id: pending.requestId, confirmed: pending.value === "yes" };
		} else {
			response = { type: "extension_ui_response", id: pending.requestId, value: pending.value };
		}
		await this.manager.respondToUi(pending.conversationKey, response);
		await this.api.answerCallbackQuery({ callbackQueryId: query.id, text: "Recorded" });
	}

	private async handleTelegramCallback(query: TelegramCallbackQuery, actionId: string): Promise<void> {
		const action = this.pendingActions.get(actionId);
		if (!action) {
			await this.api.answerCallbackQuery({ callbackQueryId: query.id, text: "Request expired" });
			return;
		}
		this.pendingActions.delete(actionId);
		if (!query.message) {
			await this.api.answerCallbackQuery({ callbackQueryId: query.id, text: "Message unavailable" });
			return;
		}
		await this.api.answerCallbackQuery({ callbackQueryId: query.id });
		await this.handleTelegramAction(this.conversationFromMessage(query.message), action, query.message);
	}

	private async handleMessage(message: TelegramMessage): Promise<void> {
		if (!this.isAuthorized(message)) {
			return;
		}
		const text = message.text ?? message.caption ?? "";
		if (!text.trim() && !message.document) {
			return;
		}
		const conversation = this.conversationFromMessage(message);
		if (await this.handlePendingInput(conversation, message, text)) {
			return;
		}
		const parts = text.trim() ? commandParts(text, this.botUser?.username) : undefined;
		if (parts) {
			await this.handleCommand(conversation, message, parts.command, parts.args);
			return;
		}
		if (message.document) {
			await this.sendText(conversation, "Send /import first, then upload a .jsonl session file.", true);
			return;
		}
		if (isPrivateChat(message) && !conversation.threadId && this.store.isTopicModeEnabled(conversation.chatId)) {
			await this.sendText(
				conversation,
				"Topic mode is enabled. Create or open a topic, then send the task there.",
				true,
			);
			return;
		}
		if (!this.shouldProcessGroupMessage(message, text, false)) {
			return;
		}
		const prompt = this.cleanBotMention(text);
		if (!prompt) {
			return;
		}
		const error = await this.manager.prompt(conversation, prompt);
		if (error) {
			await this.sendText(conversation, `Error: ${redactToken(error)}`, true);
			return;
		}
		await this.ensureChatCommandMenu(conversation);
	}

	private async handleCommand(
		conversation: ConversationRef,
		message: TelegramMessage,
		command: string,
		args: string,
	): Promise<void> {
		const resolvedCommand = await this.resolveTelegramCommand(conversation, command);
		switch (resolvedCommand) {
			case "start":
			case "help":
				await this.sendText(conversation, await this.helpText(conversation), true);
				return;
			case "settings":
				await this.showSettings(conversation);
				return;
			case "model":
				await this.handleModel(conversation, args);
				return;
			case "scoped-models":
				await this.showScopedModels(conversation);
				return;
			case "export":
				await this.handleExport(conversation, args);
				return;
			case "import":
				if (message.document) {
					await this.handleImportDocument(conversation, message.document);
					return;
				}
				await this.handleImport(conversation, args);
				return;
			case "share":
				await this.confirmShare(conversation);
				return;
			case "copy":
				await this.handleCopy(conversation);
				return;
			case "name":
				await this.handleName(conversation, args);
				return;
			case "session":
				await this.handleSession(conversation);
				return;
			case "changelog":
				await this.handleChangelog(conversation, 0);
				return;
			case "hotkeys":
				await this.handleHotkeys(conversation);
				return;
			case "fork":
				await this.handleFork(conversation, args);
				return;
			case "clone":
				await this.confirmClone(conversation);
				return;
			case "tree":
				await this.handleTree(conversation);
				return;
			case "trust":
				await this.handleTrust(conversation);
				return;
			case "login":
				await this.handleLogin(conversation);
				return;
			case "logout":
				await this.handleLogout(conversation);
				return;
			case "new":
				await this.confirmNewSession(conversation);
				return;
			case "compact":
				await this.handleCompact(conversation, args);
				return;
			case "resume":
				await this.handleResume(conversation, args);
				return;
			case "reload":
				await this.confirmReload(conversation);
				return;
			case "quit":
				await this.confirmQuit(conversation, message);
				return;
			default:
				await this.manager.prompt(conversation, `/${resolvedCommand}${args ? ` ${args}` : ""}`);
				await this.ensureChatCommandMenu(conversation);
		}
	}

	private async helpText(conversation: ConversationRef): Promise<string> {
		const lines = [
			"Pi Telegram client",
			"",
			"Telegram-native:",
			...TELEGRAM_NATIVE_COMMANDS.map((command) => `/${command.command} - ${command.description}`),
			"",
			"Pi commands:",
			...TELEGRAM_PI_COMMANDS.map((command) => `/${command.command} - ${command.description}`),
		];

		try {
			const response = await this.manager.sendCommand(conversation, { type: "get_commands" });
			if (isCommandResponse(response, "get_commands")) {
				const dynamicMenu = this.buildDynamicCommandMenu(conversation, response.data.commands);
				this.dynamicCommandAliases.set(conversation.chatId, dynamicMenu.aliases);
				const commands = [...this.baseCommandsForConversation(conversation), ...dynamicMenu.commands];
				const signature = JSON.stringify(commands);
				if (this.commandMenuSignatures.get(conversation.chatId) !== signature) {
					try {
						await this.api.setMyCommands(commands, { type: "chat", chat_id: conversation.chatId });
						this.commandMenuSignatures.set(conversation.chatId, signature);
					} catch (error) {
						console.error(`Failed to refresh Telegram command menu: ${redactToken(formatError(error))}`);
					}
				}

				if (dynamicMenu.commands.length > 0) {
					lines.push("", "Workspace commands:");
					for (const command of dynamicMenu.commands) {
						const realCommand = dynamicMenu.aliases.get(command.command);
						const mapping = realCommand && realCommand !== command.command ? ` → /${realCommand}` : "";
						lines.push(`/${command.command}${mapping} - ${command.description}`);
					}
				}

				if (dynamicMenu.skipped.length > 0) {
					lines.push("", "---", "Skipped workspace commands:");
					for (const skipped of dynamicMenu.skipped) {
						lines.push(`/${skipped.name} - ${skipped.reason}`);
					}
				}
			} else {
				lines.push("", `Workspace commands unavailable: ${redactToken(responseError(response))}`);
			}
		} catch (error) {
			lines.push("", `Workspace commands unavailable: ${redactToken(formatError(error))}`);
		}

		lines.push(
			"",
			"Use buttons for menus and confirmations. Normal messages are sent to pi with full tool access as the user running pi-tg.",
		);
		return lines.join("\n");
	}

	private async handleSimpleResponse(
		conversation: ConversationRef,
		command: RpcCommand,
		successText: string,
		options?: { refreshCommands?: boolean },
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, command);
		const success = isSuccess(response);
		await this.sendText(conversation, success ? successText : `Error: ${redactToken(responseError(response))}`, true);
		if (success && options?.refreshCommands) {
			await this.refreshChatCommandMenu(conversation, true);
		}
	}

	private async handleExport(conversation: ConversationRef, args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			await this.showExportMenu(conversation);
			return;
		}
		if (trimmed === "html" || trimmed === "jsonl") {
			await this.runExport(conversation, trimmed);
			return;
		}
		const outputPath = pathCommandArgument(args);
		await this.runExport(conversation, outputPath?.endsWith(".jsonl") ? "jsonl" : "html", outputPath);
	}

	private async handleImport(conversation: ConversationRef, args: string): Promise<void> {
		const inputPath = pathCommandArgument(args);
		if (!inputPath) {
			this.pendingInputs.set(conversation.key, { type: "import_jsonl" });
			await this.sendText(
				conversation,
				"Send a .jsonl session file as a Telegram document, or reply with a local .jsonl path.",
				true,
			);
			return;
		}
		await this.importJsonlPath(conversation, inputPath);
	}

	private async handleShare(conversation: ConversationRef): Promise<void> {
		const tmpFile = join(tmpdir(), `pi-tg-session-${randomUUID()}.html`);
		const exportResponse = await this.manager.sendCommand(conversation, { type: "export_html", outputPath: tmpFile });
		if (!isCommandResponse(exportResponse, "export_html")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(exportResponse))}`, true);
			return;
		}
		try {
			const result = await runProcess("gh", ["gist", "create", "--public=false", exportResponse.data.path]);
			if (result.code !== 0) {
				await this.sendText(conversation, `Error: ${result.stderr.trim() || "Failed to create gist"}`, true);
				return;
			}
			const gistUrl = result.stdout.trim();
			const gistId = gistUrl.split("/").pop();
			if (!gistId) {
				await this.sendText(conversation, "Error: Failed to parse gist URL.", true);
				return;
			}
			await this.sendText(
				conversation,
				[
					"**Share Link Created**",
					"",
					formatMarkdownTable(
						["Field", "Value"],
						[
							["Share URL", `https://pi.earendil.works/gist/${gistId}`],
							["Gist", gistUrl],
						],
					),
				].join("\n"),
				true,
				undefined,
				true,
			);
		} catch (error) {
			await this.sendText(conversation, `Error: ${formatError(error)}`, true);
		}
	}

	private async handleCopy(conversation: ConversationRef): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "get_last_assistant_text" });
		if (!isCommandResponse(response, "get_last_assistant_text")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		await this.sendText(conversation, response.data.text ?? "No agent messages to copy yet.", true, undefined, true);
	}

	private async handleName(conversation: ConversationRef, args: string): Promise<void> {
		if (!args.trim()) {
			const state = await this.manager.getState(conversation);
			await this.sendText(
				conversation,
				state?.sessionName ? `Session name: ${state.sessionName}` : "This session has no display name.",
				true,
				{ inline_keyboard: [[this.actionButton("Rename", { type: "prompt_name" })]] },
			);
			return;
		}
		const response = await this.manager.sendCommand(conversation, { type: "set_session_name", name: args.trim() });
		await this.sendText(
			conversation,
			isSuccess(response) ? `Session name set: ${args.trim()}` : `Error: ${redactToken(responseError(response))}`,
			true,
		);
	}

	private async handleSession(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "get_session_stats" });
		if (!isCommandResponse(response, "get_session_stats")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		const state = await this.manager.getState(conversation);
		const binding = this.store.getBinding(conversation.key);
		const sessions = await listRecentSessions(200);
		const savedSession = sessions.find((session) => session.id === response.data.sessionId);
		const sessionName = state?.sessionName || savedSession?.firstMessage || "Untitled";
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				formatSessionStats(response.data, truncateTelegramButtonText(sessionName.replace(/\s+/g, " "), 120)),
				"",
				"**Runtime**",
				"",
				formatMarkdownTable(
					["Setting", "Value"],
					[
						["Model", state?.model ? `${state.model.provider}/${state.model.id}` : "none"],
						["Thinking", state?.thinkingLevel ?? "unknown"],
						["Workspace", binding?.cwd ?? this.config.defaultCwd],
					],
				),
			].join("\n"),
			{ inline_keyboard: [] },
		);
	}

	private async handleChangelog(
		conversation: ConversationRef,
		page: number,
		message?: TelegramMessage,
	): Promise<void> {
		try {
			const sections = changelogSections();
			const safePage = Math.min(Math.max(page, 0), Math.max(sections.length - 1, 0));
			const keyboard: InlineKeyboardMarkup = {
				inline_keyboard: [
					[
						this.actionButton("Previous", { type: "show_changelog", page: Math.max(safePage - 1, 0) }),
						this.actionButton("Next", {
							type: "show_changelog",
							page: Math.min(safePage + 1, Math.max(sections.length - 1, 0)),
						}),
					],
				],
			};
			await this.sendOrEditMenu(
				conversation,
				message,
				sections[safePage] ?? "No changelog entries found.",
				keyboard,
			);
		} catch (error) {
			await this.sendText(conversation, `Error: ${formatError(error)}`, true);
		}
	}

	private async handleFork(conversation: ConversationRef, args: string, message?: TelegramMessage): Promise<void> {
		if (args.trim()) {
			const response = await this.manager.sendCommand(conversation, { type: "fork", entryId: args.trim() });
			const text = isCommandResponse(response, "fork")
				? response.data.cancelled
					? "Fork cancelled."
					: `Forked from ${args.trim()}.`
				: `Error: ${redactToken(responseError(response))}`;
			if (message) {
				await this.sendOrEditMenu(conversation, message, text, { inline_keyboard: [] });
				return;
			}
			await this.sendText(conversation, text, true);
			return;
		}
		await this.showForkPicker(conversation, 0);
	}

	private async handleTree(conversation: ConversationRef): Promise<void> {
		await this.showTree(conversation, 0);
	}

	private async handleResume(conversation: ConversationRef, args: string): Promise<void> {
		if (!args) {
			await this.showResumeScopePicker(conversation);
			return;
		}
		const sessionPath = await resolveSessionPath(args);
		if (sessionPath) {
			await this.resumeSession(conversation, sessionPath);
			return;
		}
		await this.showResumePicker(conversation, 0, args, "all");
	}

	private async handleModel(conversation: ConversationRef, args: string): Promise<void> {
		const parsed = parseModelArgs(args);
		if (!parsed) {
			await this.showModelProviders(conversation);
			return;
		}
		const slash = parsed.modelRef.indexOf("/");
		if (slash === -1) {
			await this.sendText(conversation, "Usage: /model <provider>/<model> [thinking-level]", true);
			return;
		}
		const provider = parsed.modelRef.slice(0, slash);
		const modelId = parsed.modelRef.slice(slash + 1);
		await this.setModel(conversation, provider, modelId, parsed.thinkingLevel);
	}

	private registerAction(action: TelegramCallbackAction): string {
		if (this.pendingActions.size > 1000) {
			const oldest = this.pendingActions.keys().next().value;
			if (typeof oldest === "string") {
				this.pendingActions.delete(oldest);
			}
		}
		const id = randomUUID().slice(0, 16);
		this.pendingActions.set(id, action);
		return id;
	}

	private actionButton(text: string, action: TelegramCallbackAction): InlineKeyboardButton {
		return { text, callback_data: `tg:${this.registerAction(action)}` };
	}

	private buttonRows(buttons: InlineKeyboardButton[], columns: number): InlineKeyboardButton[][] {
		const rows: InlineKeyboardButton[][] = [];
		for (let index = 0; index < buttons.length; index += columns) {
			rows.push(buttons.slice(index, index + columns));
		}
		return rows;
	}

	private async sendOrEditMenu(
		conversation: ConversationRef,
		message: TelegramMessage | undefined,
		text: string,
		replyMarkup?: InlineKeyboardMarkup,
	): Promise<void> {
		if (!message) {
			await this.sendText(conversation, text, true, replyMarkup, true);
			return;
		}
		const options = {
			chatId: conversation.chatId,
			threadId: conversation.threadId,
			messageId: message.message_id,
			text,
			replyMarkup,
		};
		try {
			await this.api.editRichMessage(options);
		} catch {
			await this.api.editMessageText(options);
		}
	}

	private async handleTelegramAction(
		conversation: ConversationRef,
		action: TelegramCallbackAction,
		message: TelegramMessage,
	): Promise<void> {
		switch (action.type) {
			case "abort":
				await this.handleSimpleResponse(conversation, { type: "abort" }, "Stopped the current run.");
				return;
			case "show_help":
				await this.sendText(conversation, await this.helpText(conversation), true);
				return;
			case "show_settings":
				await this.showSettings(conversation, message);
				return;
			case "show_model_providers":
				await this.showModelProviders(conversation, message);
				return;
			case "show_model_provider":
				await this.showModelProvider(conversation, action.provider, action.page, message);
				return;
			case "select_model":
				await this.setModel(conversation, action.provider, action.modelId, undefined, message);
				return;
			case "show_thinking":
				await this.showThinkingSelector(conversation, message);
				return;
			case "set_thinking":
				await this.setThinkingLevel(conversation, action.level, undefined, message, action.source);
				return;
			case "show_scoped_models":
				await this.showScopedModels(conversation, message);
				return;
			case "select_scoped_model":
				await this.setScopedModel(conversation, action.provider, action.modelId, action.thinkingLevel, message);
				return;
			case "edit_scoped_models":
				await this.showScopedModelEditor(conversation, action.provider, action.page ?? 0, message);
				return;
			case "toggle_scoped_model":
				await this.toggleScopedModel(conversation, action.provider, action.modelId, action.page, message);
				return;
			case "clear_scoped_models":
				await this.saveScopedModels(conversation, [], message);
				return;
			case "save_scoped_models":
				await this.saveScopedModels(
					conversation,
					[...(this.pendingScopedModels.get(conversation.key) ?? new Set())],
					message,
				);
				return;
			case "show_export":
				await this.showExportMenu(conversation, message);
				return;
			case "export":
				await this.runExport(conversation, action.format);
				return;
			case "prompt_import":
				this.pendingInputs.set(conversation.key, { type: "import_jsonl" });
				await this.sendText(conversation, "Send a .jsonl document or local session path to import.", true);
				return;
			case "confirm_share":
				await this.confirmShare(conversation, message);
				return;
			case "share":
				await this.handleShare(conversation);
				return;
			case "prompt_name":
				this.pendingInputs.set(conversation.key, { type: "name" });
				await this.sendText(conversation, "Send the new session name.", true);
				return;
			case "prompt_workspace":
				this.pendingInputs.set(conversation.key, { type: "workspace" });
				await this.sendText(conversation, "Send the workspace path for this chat/topic.", true);
				return;
			case "show_session":
				await this.handleSession(conversation, message);
				return;
			case "show_changelog":
				await this.handleChangelog(conversation, action.page, message);
				return;
			case "show_fork":
				await this.showForkPicker(conversation, action.page, message);
				return;
			case "fork":
				await this.handleFork(conversation, action.entryId, message);
				return;
			case "clone":
				await this.handleSimpleResponse(conversation, { type: "clone" }, "Cloned the current session.");
				return;
			case "show_tree":
				await this.showTree(conversation, action.page, message);
				return;
			case "navigate_tree":
				await this.navigateTree(conversation, action.entryId, message);
				return;
			case "show_trust":
				await this.handleTrust(conversation, message);
				return;
			case "show_login":
				await this.handleLogin(conversation, message);
				return;
			case "show_logout":
				await this.handleLogout(conversation, message);
				return;
			case "new_session":
				await this.handleSimpleResponse(conversation, { type: "new_session" }, "Started a new pi session.", {
					refreshCommands: true,
				});
				return;
			case "show_compact":
				await this.handleCompact(conversation, "", message);
				return;
			case "compact_now":
				await this.handleSimpleResponse(conversation, { type: "compact" }, "Compacted the current session.");
				return;
			case "prompt_compact":
				this.pendingInputs.set(conversation.key, { type: "compact_instructions" });
				await this.sendText(conversation, "Send compaction instructions.", true);
				return;
			case "show_resume":
				if (!action.scope) {
					await this.showResumeScopePicker(conversation, message);
					return;
				}
				await this.showResumePicker(conversation, action.page, action.query, action.scope, message);
				return;
			case "resume":
				await this.resumeSession(conversation, action.sessionPath);
				return;
			case "reload":
				await this.handleSimpleResponse(
					conversation,
					{ type: "reload" },
					"Reloaded keybindings, extensions, skills, prompts, and themes.",
					{ refreshCommands: true },
				);
				return;
			case "quit":
				await this.sendText(conversation, "Stopping pi-tg.", true);
				await this.stop();
				return;
		}
	}

	private async getAvailableModels(conversation: ConversationRef): Promise<AvailableModel[] | undefined> {
		const response = await this.manager.sendCommand(conversation, { type: "get_available_models" });
		if (!isCommandResponse(response, "get_available_models")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return undefined;
		}
		return response.data.models;
	}

	private async showSettings(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const state = await this.manager.getState(conversation);
		const binding = this.store.getBinding(conversation.key);
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Settings**",
				"",
				formatSettingsTable({
					state,
					workspace: binding?.cwd ?? this.config.defaultCwd,
					streaming: this.config.streaming,
					projectTrust: this.config.projectTrust,
				}),
			].join("\n"),
			{
				inline_keyboard: [
					[
						this.actionButton("Model", { type: "show_model_providers" }),
						this.actionButton("Thinking", { type: "show_thinking" }),
					],
					[
						this.actionButton("Scoped models", { type: "show_scoped_models" }),
						this.actionButton("Session", { type: "show_session" }),
					],
					[this.actionButton("Workspace", { type: "prompt_workspace" })],
					[this.actionButton("Auth", { type: "show_login" }), this.actionButton("Trust", { type: "show_trust" })],
					[this.actionButton("Reload", { type: "reload" })],
				],
			},
		);
	}

	private async showModelProviders(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const models = await this.getAvailableModels(conversation);
		if (!models) return;
		const providers = [...new Set(models.map((model) => model.provider))].sort();
		const buttons = providers.map((provider) =>
			this.actionButton(provider, { type: "show_model_provider", provider, page: 0 }),
		);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Model Selector**", "", "Step 1/3: Choose A Provider"].join("\n"),
			{ inline_keyboard: this.buttonRows(buttons, 2) },
		);
	}

	private async showModelProvider(
		conversation: ConversationRef,
		provider: string,
		page: number,
		message?: TelegramMessage,
	): Promise<void> {
		const models = await this.getAvailableModels(conversation);
		if (!models) return;
		const providerModels = models.filter((model) => model.provider === provider);
		const state = await this.manager.getState(conversation);
		const selectedRef = state?.model ? `${state.model.provider}/${state.model.id}` : undefined;
		const pageSize = 8;
		const maxPage = Math.max(Math.ceil(providerModels.length / pageSize) - 1, 0);
		const safePage = Math.min(Math.max(page, 0), maxPage);
		const pageModels = providerModels.slice(safePage * pageSize, safePage * pageSize + pageSize);
		const rows = pageModels.map((model) => [
			this.actionButton(modelButtonLabel(model, modelReference(model) === selectedRef), {
				type: "select_model",
				provider: model.provider,
				modelId: model.id,
			}),
		]);
		rows.push([
			this.actionButton("Previous", { type: "show_model_provider", provider, page: Math.max(safePage - 1, 0) }),
			this.actionButton("Next", { type: "show_model_provider", provider, page: Math.min(safePage + 1, maxPage) }),
		]);
		rows.push([this.actionButton("Back to providers", { type: "show_model_providers" })]);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Model Selector**", "", "Step 2/3: Choose A Model"].join("\n"),
			{ inline_keyboard: rows },
		);
	}

	private async setModel(
		conversation: ConversationRef,
		provider: string,
		modelId: string,
		thinkingLevel?: ThinkingLevel,
		message?: TelegramMessage,
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "set_model", provider, modelId });
		if (!isCommandResponse(response, "set_model")) {
			const errorText = `Error: ${redactToken(responseError(response))}`;
			if (message) {
				await this.sendOrEditMenu(conversation, message, errorText, { inline_keyboard: [] });
				return;
			}
			await this.sendText(conversation, errorText, true);
			return;
		}
		if (thinkingLevel) {
			await this.setThinkingLevel(
				conversation,
				thinkingLevel,
				`Model set to ${provider}/${modelId}`,
				message,
				"model",
			);
			return;
		}
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Model Selector**", "", "Step 3/3: Choose A Thinking Level"].join("\n"),
			this.thinkingKeyboard(response.data, "model"),
		);
	}

	private thinkingKeyboard(
		model: AvailableModel | undefined,
		source: "model" | "settings" | "scoped",
	): InlineKeyboardMarkup {
		const backButton =
			source === "scoped"
				? this.actionButton("Back To Scoped Models", { type: "show_scoped_models" })
				: this.actionButton(
						"Back To Models",
						model
							? { type: "show_model_provider", provider: model.provider, page: 0 }
							: { type: "show_model_providers" },
					);
		return {
			inline_keyboard: [
				...this.buttonRows(
					supportedThinkingLevels(model).map((level) =>
						this.actionButton(level, { type: "set_thinking", level, source }),
					),
					3,
				),
				[backButton],
			],
		};
	}

	private async showThinkingSelector(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const state = await this.manager.getState(conversation);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Thinking Level**", "", "Choose a thinking level", "", formatCurrentModelTable(state)].join("\n"),
			this.thinkingKeyboard(state?.model, "settings"),
		);
	}

	private async setThinkingLevel(
		conversation: ConversationRef,
		level: ThinkingLevel,
		prefix?: string,
		message?: TelegramMessage,
		source?: "model" | "settings" | "scoped",
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "set_thinking_level", level });
		if (!isSuccess(response)) {
			const errorText = `Error: ${redactToken(responseError(response))}`;
			if (message) {
				await this.sendOrEditMenu(conversation, message, errorText, { inline_keyboard: [] });
				return;
			}
			await this.sendText(conversation, errorText, true);
			return;
		}
		const state = await this.manager.getState(conversation);
		const text = message
			? [
					source === "model"
						? "**Model Selector**"
						: source === "scoped"
							? "**Scoped Model Selector**"
							: "**Thinking Level**",
					"",
					source === "model"
						? "Model and thinking level updated."
						: source === "scoped"
							? "Current model updated."
							: formatThinkingLevelConfirmation(level, state),
					"",
					formatCurrentModelTable(state),
				]
					.filter((line): line is string => line !== undefined)
					.join("\n")
			: [prefix, formatThinkingLevelConfirmation(level, state)]
					.filter((line): line is string => line !== undefined)
					.join("\n");
		if (message) {
			await this.sendOrEditMenu(conversation, message, text, { inline_keyboard: [] });
			return;
		}
		await this.sendText(conversation, text, true);
	}

	private async getScopedModels(conversation: ConversationRef): Promise<ScopedModel[] | undefined> {
		const response = await this.manager.sendCommand(conversation, { type: "get_scoped_models" });
		if (!isCommandResponse(response, "get_scoped_models")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return undefined;
		}
		return response.data.scopedModels;
	}

	private async showScopedModels(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const scopedModels = await this.getScopedModels(conversation);
		if (!scopedModels) return;
		const rows = scopedModels.map((scoped) => [
			this.actionButton(
				truncateTelegramButtonText(
					`${scoped.model.provider}/${scoped.model.id}${scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : ""}`,
					56,
				),
				{
					type: "select_scoped_model",
					provider: scoped.model.provider,
					modelId: scoped.model.id,
					thinkingLevel: scoped.thinkingLevel,
				},
			),
		]);
		rows.push([this.actionButton("Edit Scoped Models", { type: "edit_scoped_models" })]);
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Scoped Model Selector**",
				"",
				"Switch provider and model from your custom scoped model list.",
				scopedModels.length === 0 ? "" : undefined,
				scopedModels.length === 0 ? "No scoped models configured." : undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
			{ inline_keyboard: rows },
		);
	}

	private async setScopedModel(
		conversation: ConversationRef,
		provider: string,
		modelId: string,
		_thinkingLevel: ThinkingLevel | undefined,
		message: TelegramMessage,
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "set_model", provider, modelId });
		if (!isCommandResponse(response, "set_model")) {
			await this.sendOrEditMenu(conversation, message, `Error: ${redactToken(responseError(response))}`, {
				inline_keyboard: [],
			});
			return;
		}
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Scoped Model Selector**", "", "Step 2/2: Choose A Thinking Level"].join("\n"),
			this.thinkingKeyboard(response.data, "scoped"),
		);
	}

	private async showScopedModelEditor(
		conversation: ConversationRef,
		provider?: string,
		page = 0,
		message?: TelegramMessage,
	): Promise<void> {
		const models = await this.getAvailableModels(conversation);
		if (!models) return;
		let selected = this.pendingScopedModels.get(conversation.key);
		if (!selected) {
			const scopedModels = await this.getScopedModels(conversation);
			if (!scopedModels) return;
			selected = new Set(scopedModels.map((scoped) => modelReference(scoped.model)));
			this.pendingScopedModels.set(conversation.key, selected);
		}
		if (!provider) {
			const providers = [...new Set(models.map((model) => model.provider))].sort();
			await this.sendOrEditMenu(
				conversation,
				message,
				["**Edit Scoped Models**", "", "Step 1/2: Choose A Provider"].join("\n"),
				{
					inline_keyboard: [
						...this.buttonRows(
							providers.map((modelProvider) =>
								this.actionButton(modelProvider, {
									type: "edit_scoped_models",
									provider: modelProvider,
									page: 0,
								}),
							),
							2,
						),
						[this.actionButton("Back To Scoped Models", { type: "show_scoped_models" })],
					],
				},
			);
			return;
		}
		const providerModels = models.filter((model) => model.provider === provider);
		const pageSize = 8;
		const maxPage = Math.max(Math.ceil(providerModels.length / pageSize) - 1, 0);
		const safePage = Math.min(Math.max(page, 0), maxPage);
		const rows = providerModels.slice(safePage * pageSize, safePage * pageSize + pageSize).map((model) => [
			this.actionButton(modelButtonLabel(model, selected.has(modelReference(model))), {
				type: "toggle_scoped_model",
				provider,
				modelId: model.id,
				page: safePage,
			}),
		]);
		rows.push([
			this.actionButton("Previous", { type: "edit_scoped_models", provider, page: Math.max(safePage - 1, 0) }),
			this.actionButton("Next", { type: "edit_scoped_models", provider, page: Math.min(safePage + 1, maxPage) }),
		]);
		rows.push([
			this.actionButton("Back To Providers", { type: "edit_scoped_models" }),
			this.actionButton("Save", { type: "save_scoped_models" }),
		]);
		rows.push([this.actionButton("Clear", { type: "clear_scoped_models" })]);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Edit Scoped Models**", "", "Step 2/2: Select Models"].join("\n"),
			{ inline_keyboard: rows },
		);
	}

	private async toggleScopedModel(
		conversation: ConversationRef,
		provider: string,
		modelId: string,
		page: number,
		message: TelegramMessage,
	): Promise<void> {
		const selected = this.pendingScopedModels.get(conversation.key) ?? new Set<string>();
		const ref = `${provider}/${modelId}`;
		if (selected.has(ref)) {
			selected.delete(ref);
		} else {
			selected.add(ref);
		}
		this.pendingScopedModels.set(conversation.key, selected);
		await this.showScopedModelEditor(conversation, provider, page, message);
	}

	private async saveScopedModels(
		conversation: ConversationRef,
		patterns: string[],
		message: TelegramMessage,
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "set_scoped_models", patterns });
		this.pendingScopedModels.delete(conversation.key);
		if (!isCommandResponse(response, "set_scoped_models")) {
			await this.sendOrEditMenu(conversation, message, `Error: ${redactToken(responseError(response))}`, {
				inline_keyboard: [],
			});
			return;
		}
		const warnings = response.data.diagnostics.map((diagnostic) => `Warning: ${diagnostic.message}`);
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Edit Scoped Models**",
				"",
				patterns.length === 0
					? "Scoped model list cleared."
					: `Scoped model list saved with ${response.data.scopedModels.length} model(s).`,
				...warnings,
			].join("\n"),
			{ inline_keyboard: [[this.actionButton("Back To Scoped Models", { type: "show_scoped_models" })]] },
		);
	}

	private async showExportMenu(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Export Session**", "", "Choose how to export the current session."].join("\n"),
			{
				inline_keyboard: [
					[this.actionButton("HTML document", { type: "export", format: "html" })],
					[this.actionButton("JSONL document", { type: "export", format: "jsonl" })],
					[this.actionButton("Share link", { type: "confirm_share" })],
				],
			},
		);
	}

	private async runExport(
		conversation: ConversationRef,
		format: "html" | "jsonl",
		outputPath?: string,
	): Promise<void> {
		const path = outputPath ?? join(tmpdir(), `pi-tg-session-${randomUUID()}.${format}`);
		const response = await this.manager.sendCommand(
			conversation,
			format === "jsonl" ? { type: "export_jsonl", outputPath: path } : { type: "export_html", outputPath: path },
		);
		if (!isCommandResponse(response, "export_html") && !isCommandResponse(response, "export_jsonl")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		try {
			await this.api.sendDocument({
				chatId: conversation.chatId,
				threadId: conversation.threadId,
				path: response.data.path,
				filename: basename(response.data.path),
				caption: `Pi session export (${format.toUpperCase()})`,
				disableNotification: true,
			});
		} catch (error) {
			await this.sendText(
				conversation,
				`Session exported to: ${response.data.path}\nTelegram document upload failed: ${formatError(error)}`,
				true,
			);
			return;
		}
		await this.sendText(
			conversation,
			[
				"**Export Complete**",
				"",
				formatMarkdownTable(
					["Field", "Value"],
					[
						["Format", format.toUpperCase()],
						["File", basename(response.data.path)],
					],
				),
			].join("\n"),
			true,
			undefined,
			true,
		);
	}

	private async importJsonlPath(conversation: ConversationRef, inputPath: string): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "import_jsonl", inputPath });
		if (isCommandResponse(response, "import_jsonl")) {
			if (!response.data.cancelled) {
				await this.refreshChatCommandMenu(conversation, true);
			}
			await this.sendText(
				conversation,
				response.data.cancelled
					? "Import cancelled."
					: [
							"**Import Complete**",
							"",
							formatMarkdownTable(["Field", "Value"], [["File", basename(inputPath)]]),
						].join("\n"),
				true,
				undefined,
				!response.data.cancelled,
			);
			return;
		}
		await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
	}

	private async handleImportDocument(conversation: ConversationRef, document: TelegramDocument): Promise<void> {
		if (document.file_name && !document.file_name.endsWith(".jsonl")) {
			await this.sendText(conversation, "Only .jsonl session files can be imported.", true);
			return;
		}
		try {
			const file = await this.api.getFile(document.file_id);
			if (!file.file_path) {
				await this.sendText(conversation, "Telegram did not return a file path for this document.", true);
				return;
			}
			const data = await this.api.downloadFile(file.file_path);
			const inputPath = join(tmpdir(), `pi-tg-import-${randomUUID()}.jsonl`);
			await writeFile(inputPath, data);
			await this.importJsonlPath(conversation, inputPath);
		} catch (error) {
			await this.sendText(conversation, `Error: ${formatError(error)}`, true);
		}
	}

	private async handlePendingInput(
		conversation: ConversationRef,
		message: TelegramMessage,
		text: string,
	): Promise<boolean> {
		const pending = this.pendingInputs.get(conversation.key);
		if (!pending) {
			return false;
		}
		if (pending.type === "import_jsonl" && message.document) {
			this.pendingInputs.delete(conversation.key);
			await this.handleImportDocument(conversation, message.document);
			return true;
		}
		const value = text.trim();
		if (!value) {
			return true;
		}
		if (value === "/cancel") {
			this.pendingInputs.delete(conversation.key);
			await this.sendText(conversation, "Cancelled.", true);
			return true;
		}
		this.pendingInputs.delete(conversation.key);
		if (pending.type === "name") {
			await this.handleName(conversation, value);
			return true;
		}
		if (pending.type === "workspace") {
			try {
				const binding = await this.manager.setWorkspace(conversation, value);
				await this.refreshChatCommandMenu(conversation, true);
				await this.sendText(
					conversation,
					[
						"**Workspace Updated**",
						"",
						formatMarkdownTable(["Field", "Value"], [["Workspace", binding.cwd]]),
						"",
						"New Pi session started.",
					].join("\n"),
					true,
					undefined,
					true,
				);
			} catch (error) {
				await this.sendText(conversation, `Error: ${formatError(error)}`, true);
			}
			return true;
		}
		if (pending.type === "compact_instructions") {
			await this.handleSimpleResponse(
				conversation,
				{ type: "compact", customInstructions: value },
				"Compacted the current session.",
			);
			return true;
		}
		await this.importJsonlPath(conversation, value);
		return true;
	}

	private async confirmShare(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Share Session**",
				"",
				"This uploads an HTML export to a secret GitHub gist using the local `gh` CLI.",
				"",
				"Continue?",
			].join("\n"),
			{
				inline_keyboard: [
					[this.actionButton("Create share link", { type: "share" })],
					[this.actionButton("Cancel", { type: "show_session" })],
				],
			},
		);
	}

	private async handleHotkeys(conversation: ConversationRef): Promise<void> {
		await this.sendText(
			conversation,
			[
				"TUI hotkeys do not apply in Telegram.",
				"",
				"Telegram equivalents:",
				"- Use slash commands and inline buttons for menus.",
				"- Use the Stop button while Pi is working.",
				"- Long-press Telegram messages to copy text.",
			].join("\n"),
			true,
		);
	}

	private async confirmClone(conversation: ConversationRef): Promise<void> {
		await this.sendText(conversation, "Clone the current session at the current position?", true, {
			inline_keyboard: [
				[this.actionButton("Clone", { type: "clone" }), this.actionButton("Cancel", { type: "show_session" })],
			],
		});
	}

	private async handleTrust(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const binding = this.store.getBinding(conversation.key);
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Project Trust**",
				"",
				formatMarkdownTable(
					["Setting", "Value"],
					[
						["Workspace", binding?.cwd ?? this.config.defaultCwd],
						["Auto-approve tools", this.config.projectTrust ? "enabled" : "disabled"],
					],
				),
				"",
				"Authorized Telegram users inherit the filesystem and shell permissions of the `pi-tg` process.",
				"",
				"Change trust by restarting `pi-tg` with the desired trust options or by using local Pi trust settings.",
			].join("\n"),
		);
	}

	private async handleLogin(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Login**",
				"",
				"For safety, `pi-tg` does not collect API keys in chat.",
				"",
				"Run provider login locally with Pi, then use Reload here.",
			].join("\n"),
			{ inline_keyboard: [[this.actionButton("Reload after local login", { type: "reload" })]] },
		);
	}

	private async handleLogout(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Logout**",
				"",
				"Removing provider credentials is destructive and should be done locally.",
				"",
				"Run Pi locally to remove credentials, then use Reload here.",
			].join("\n"),
			{ inline_keyboard: [[this.actionButton("Reload", { type: "reload" })]] },
		);
	}

	private async confirmNewSession(conversation: ConversationRef): Promise<void> {
		const state = await this.manager.getState(conversation);
		await this.sendText(
			conversation,
			state?.messageCount
				? "Start a new session? The current session remains saved."
				: "Start a new session in this chat/topic?",
			true,
			{
				inline_keyboard: [
					[
						this.actionButton("New session", { type: "new_session" }),
						this.actionButton("Cancel", { type: "show_session" }),
					],
				],
			},
		);
	}

	private async handleCompact(conversation: ConversationRef, args: string, message?: TelegramMessage): Promise<void> {
		if (args.trim()) {
			await this.handleSimpleResponse(
				conversation,
				{ type: "compact", customInstructions: args.trim() },
				"Compacted the current session.",
			);
			return;
		}
		const state = await this.manager.getState(conversation);
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Compact Session**",
				"",
				"Compact the current session context?",
				state
					? [
							"",
							formatMarkdownTable(
								["Setting", "Value"],
								[
									["Messages", state.messageCount.toLocaleString()],
									["Busy", state.isStreaming || state.isCompacting ? "yes" : "no"],
								],
							),
						].join("\n")
					: undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
			{
				inline_keyboard: [
					[
						this.actionButton("Compact now", { type: "compact_now" }),
						this.actionButton("With instructions", { type: "prompt_compact" }),
					],
					[this.actionButton("Cancel", { type: "show_session" })],
				],
			},
		);
	}

	private async confirmReload(conversation: ConversationRef): Promise<void> {
		const state = await this.manager.getState(conversation);
		if (state?.isStreaming || state?.isCompacting) {
			await this.sendText(conversation, "Pi is busy. Reload anyway?", true, {
				inline_keyboard: [
					[this.actionButton("Reload", { type: "reload" }), this.actionButton("Cancel", { type: "show_session" })],
				],
			});
			return;
		}
		await this.handleSimpleResponse(
			conversation,
			{ type: "reload" },
			"Reloaded keybindings, extensions, skills, prompts, and themes.",
			{ refreshCommands: true },
		);
	}

	private async confirmQuit(conversation: ConversationRef, message: TelegramMessage): Promise<void> {
		if (!isPrivateChat(message)) {
			await this.sendText(conversation, "Use a private bot chat to stop pi-tg.", true);
			return;
		}
		await this.sendText(conversation, "Stop pi-tg for all chats?", true, {
			inline_keyboard: [
				[this.actionButton("Stop pi-tg", { type: "quit" }), this.actionButton("Cancel", { type: "show_session" })],
			],
		});
	}

	private async showForkPicker(conversation: ConversationRef, page: number, message?: TelegramMessage): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "get_fork_messages" });
		if (!isCommandResponse(response, "get_fork_messages")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		if (response.data.messages.length === 0) {
			await this.sendText(conversation, "No user messages available to fork.", true);
			return;
		}
		const pageSize = 6;
		const maxPage = Math.max(Math.ceil(response.data.messages.length / pageSize) - 1, 0);
		const safePage = Math.min(Math.max(page, 0), maxPage);
		const rows = response.data.messages.slice(safePage * pageSize, safePage * pageSize + pageSize).map((message) => [
			this.actionButton(truncateTelegramButtonText(message.text.replace(/\s+/g, " "), 52), {
				type: "fork",
				entryId: message.entryId,
			}),
		]);
		rows.push([
			this.actionButton("Previous", { type: "show_fork", page: Math.max(safePage - 1, 0) }),
			this.actionButton("Next", { type: "show_fork", page: Math.min(safePage + 1, maxPage) }),
		]);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Fork Session**", "", "Choose a user message to fork from.", `Page ${safePage + 1}/${maxPage + 1}`].join(
				"\n",
			),
			{ inline_keyboard: rows },
		);
	}

	private async showTree(conversation: ConversationRef, page: number, message?: TelegramMessage): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "get_tree" });
		if (!isCommandResponse(response, "get_tree")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		const toolCalls = new Map<string, ToolCallInfo>();
		const nodes = this.flattenTree(response.data.tree, toolCalls).filter((node) => this.shouldShowTreeNode(node));
		if (nodes.length === 0) {
			await this.sendText(conversation, "Session tree is empty.", true);
			return;
		}
		const pageSize = 8;
		const maxPage = Math.max(Math.ceil(nodes.length / pageSize) - 1, 0);
		const safePage = Math.min(Math.max(page, 0), maxPage);
		const rows = nodes.slice(safePage * pageSize, safePage * pageSize + pageSize).map((node) => [
			this.actionButton(this.treeButtonLabel(node), {
				type: "navigate_tree",
				entryId: node.id,
			}),
		]);
		if (maxPage > 0) {
			rows.push([
				this.actionButton("Previous", { type: "show_tree", page: Math.max(safePage - 1, 0) }),
				this.actionButton("Next", { type: "show_tree", page: Math.min(safePage + 1, maxPage) }),
			]);
		}
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Session Tree**", "", "Choose a point to navigate to."].join("\n"),
			{ inline_keyboard: rows },
		);
	}

	private flattenTree(nodes: SessionTreeNode[], toolCalls: Map<string, ToolCallInfo>, depth = 0): TreeNodeDisplay[] {
		const flattened: TreeNodeDisplay[] = [];
		for (const node of nodes) {
			this.collectToolCalls(node, toolCalls);
			flattened.push({
				id: node.entry.id,
				label: this.treeNodeLabel(node, toolCalls),
				depth,
				entry: node.entry,
			});
			flattened.push(...this.flattenTree(node.children, toolCalls, depth + 1));
		}
		return flattened;
	}

	private treeButtonLabel(node: TreeNodeDisplay): string {
		return truncateTelegramButtonText(node.label, 56);
	}

	private shouldShowTreeNode(node: TreeNodeDisplay): boolean {
		const entry = node.entry;
		if (
			entry.type === "label" ||
			entry.type === "custom" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "session_info" ||
			entry.type === "work_duration"
		) {
			return false;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = "content" in entry.message ? entry.message.content : undefined;
			const stopReason = "stopReason" in entry.message ? entry.message.stopReason : undefined;
			const hasText = this.hasTreeTextContent(content);
			const isErrorOrAborted = typeof stopReason === "string" && stopReason !== "stop" && stopReason !== "toolUse";
			if (!hasText && !isErrorOrAborted) {
				return false;
			}
		}
		return true;
	}

	private hasTreeTextContent(content: unknown): boolean {
		if (typeof content === "string") return content.trim().length > 0;
		if (!Array.isArray(content)) return false;
		return content.some(
			(part) =>
				isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
		);
	}

	private collectToolCalls(node: SessionTreeNode, toolCalls: Map<string, ToolCallInfo>): void {
		const entry = node.entry;
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		const content = "content" in entry.message ? entry.message.content : undefined;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments)) continue;
			toolCalls.set(block.id, { name: block.name, arguments: block.arguments });
		}
	}

	private treeNodeLabel(node: SessionTreeNode, toolCalls: Map<string, ToolCallInfo>): string {
		if (node.label) return `[${node.label}] ${this.treeEntryLabel(node, toolCalls)}`;
		return this.treeEntryLabel(node, toolCalls);
	}

	private treeEntryLabel(node: SessionTreeNode, toolCalls: Map<string, ToolCallInfo>): string {
		const entry = node.entry;
		const normalize = (text: string) =>
			text
				.replace(/[\n\t]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					return `user: ${normalize(this.extractTreeContent("content" in message ? message.content : undefined))}`;
				}
				if (message.role === "assistant") {
					const content = normalize(this.extractTreeContent("content" in message ? message.content : undefined));
					if (content) return `assistant: ${content}`;
					const errorMessage =
						"errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
					if (errorMessage) return `assistant: ${normalize(errorMessage)}`;
					const stopReason =
						"stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : "";
					return stopReason === "aborted" ? "assistant: (aborted)" : "assistant: (no content)";
				}
				if (message.role === "toolResult") {
					const toolCallId =
						"toolCallId" in message && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
					const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
					if (toolCall) return this.formatTreeToolCall(toolCall.name, toolCall.arguments);
					const toolName =
						"toolName" in message && typeof message.toolName === "string" ? message.toolName : "tool";
					return `[${toolName}]`;
				}
				if (message.role === "bashExecution") {
					const command = "command" in message && typeof message.command === "string" ? message.command : "";
					return `[bash]: ${normalize(command)}`;
				}
				return `[${message.role}]`;
			}
			case "custom_message": {
				const content = typeof entry.content === "string" ? entry.content : this.extractTreeContent(entry.content);
				return `[${entry.customType}]: ${normalize(content)}`;
			}
			case "compaction":
				return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`;
			case "branch_summary":
				return `[branch summary]: ${normalize(entry.summary)}`;
			case "session_info":
				return entry.name ? `[title: ${entry.name}]` : "[title: empty]";
			case "work_duration":
				return `[worked for: ${this.formatTreeDuration(entry.durationMs)}]`;
			case "model_change":
				return `[model: ${entry.modelId}]`;
			case "thinking_level_change":
				return `[thinking: ${entry.thinkingLevel}]`;
			case "custom":
				return `[custom: ${entry.customType}]`;
			case "label":
				return `[label: ${entry.label ?? "(cleared)"}]`;
		}
	}

	private extractTreeContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}

	private formatTreeDuration(durationMs: number): string {
		const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
		const seconds = totalSeconds % 60;
		const totalMinutes = Math.floor(totalSeconds / 60);
		const minutes = totalMinutes % 60;
		const hours = Math.floor(totalMinutes / 60);
		if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
		if (minutes > 0) return `${minutes}m ${seconds}s`;
		return `${seconds}s`;
	}

	private formatTreeToolCall(name: string, args: Record<string, unknown>): string {
		const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
		switch (name) {
			case "read":
				return `[read: ${path}]`;
			case "write":
				return `[write: ${path}]`;
			case "edit":
				return `[edit: ${path}]`;
			case "bash": {
				const command = typeof args.command === "string" ? args.command.replace(/[\n\t]/g, " ").trim() : "";
				return `[bash: ${truncateTelegramButtonText(command, 50)}]`;
			}
			case "grep":
				return `[grep: ${typeof args.pattern === "string" ? args.pattern : ""}]`;
			case "find":
				return `[find: ${typeof args.pattern === "string" ? args.pattern : ""}]`;
			case "ls":
				return `[ls: ${path || "."}]`;
			default:
				return `[${name}]`;
		}
	}

	private async navigateTree(
		conversation: ConversationRef,
		entryId: string,
		message?: TelegramMessage,
	): Promise<void> {
		const response = await this.manager.sendCommand(conversation, { type: "navigate_tree", entryId });
		if (!isCommandResponse(response, "navigate_tree")) {
			await this.sendText(conversation, `Error: ${redactToken(responseError(response))}`, true);
			return;
		}
		await this.sendOrEditMenu(
			conversation,
			message,
			[
				"**Session Tree**",
				"",
				"Navigated to selected point.",
				response.data.editorText ? "" : undefined,
				response.data.editorText ? "**Previous user message**" : undefined,
				response.data.editorText ? truncateTelegramText(response.data.editorText, 1000) : undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
			{ inline_keyboard: [[this.actionButton("Back To Tree", { type: "show_tree", page: 0 })]] },
		);
	}

	private sessionMatchesQuery(
		session: { id: string; cwd: string; name?: string; firstMessage: string },
		query: string,
	): boolean {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return true;
		}
		return [session.id, session.cwd, session.name ?? "", session.firstMessage].some((value) =>
			value.toLowerCase().includes(normalized),
		);
	}

	private sessionButtonLabel(session: { id: string; cwd: string; name?: string; firstMessage: string }): string {
		const title = (session.name || session.firstMessage || "Untitled").replace(/\s+/g, " ").trim();
		const workspace = basename(session.cwd) || session.cwd;
		return truncateTelegramButtonText(`${title} · ${workspace}`, 56);
	}

	private currentWorkspace(conversation: ConversationRef): string {
		return this.store.getBinding(conversation.key)?.cwd ?? this.config.defaultCwd;
	}

	private async showResumeScopePicker(conversation: ConversationRef, message?: TelegramMessage): Promise<void> {
		const workspace = this.currentWorkspace(conversation);
		await this.sendOrEditMenu(
			conversation,
			message,
			["**Resume Session**", "", "Choose where to look for sessions."].join("\n"),
			{
				inline_keyboard: [
					[
						this.actionButton(
							truncateTelegramButtonText(`Current Workspace: ${basename(workspace) || workspace}`, 56),
							{
								type: "show_resume",
								page: 0,
								scope: "workspace",
							},
						),
					],
					[this.actionButton("All Chats", { type: "show_resume", page: 0, scope: "all" })],
				],
			},
		);
	}

	private async showResumePicker(
		conversation: ConversationRef,
		page: number,
		query = "",
		scope: ResumeScope,
		message?: TelegramMessage,
	): Promise<void> {
		const allSessions = await listRecentSessions(200);
		const workspace = this.currentWorkspace(conversation);
		const sessions = allSessions
			.filter((session) => scope === "all" || session.cwd === workspace)
			.filter((session) => this.sessionMatchesQuery(session, query));
		if (allSessions.length === 0) {
			await this.sendText(conversation, "No saved sessions found.", true);
			return;
		}
		const pageSize = 7;
		const maxPage = Math.max(Math.ceil(sessions.length / pageSize) - 1, 0);
		const safePage = Math.min(Math.max(page, 0), maxPage);
		const rows = sessions.slice(safePage * pageSize, safePage * pageSize + pageSize).map((session) => [
			this.actionButton(this.sessionButtonLabel(session), {
				type: "resume",
				sessionPath: session.id,
			}),
		]);
		if (maxPage > 0) {
			rows.push([
				this.actionButton("Previous", { type: "show_resume", page: Math.max(safePage - 1, 0), query, scope }),
				this.actionButton("Next", { type: "show_resume", page: Math.min(safePage + 1, maxPage), query, scope }),
			]);
		}
		rows.push([this.actionButton("Back", { type: "show_resume", page: 0 })]);
		const text = [
			"**Resume Session**",
			"",
			query ? `Search: ${query}` : scope === "workspace" ? `Current workspace: ${workspace}` : "All chats",
			sessions.length === 0 ? "No matching sessions found." : "Choose a session to resume.",
			"",
			"Search with `/resume <query>`.",
		].join("\n");
		await this.sendOrEditMenu(conversation, message, text, { inline_keyboard: rows });
	}

	private async resumeSession(conversation: ConversationRef, sessionRef: string): Promise<void> {
		const sessionPath = await resolveSessionPath(sessionRef);
		if (!sessionPath) {
			await this.sendText(conversation, `No session found for ${sessionRef}`, true);
			return;
		}
		const response = await this.manager.restoreSession(conversation, sessionPath);
		if (isCommandResponse(response, "switch_session") && !response.data.cancelled) {
			await this.refreshChatCommandMenu(conversation, true);
		}
		await this.sendText(
			conversation,
			isSuccess(response)
				? `Resumed ${basename(sessionPath)} into this chat/topic.`
				: `Error: ${redactToken(responseError(response))}`,
			true,
		);
	}

	private async handleUiRequest(conversation: ConversationRef, request: RpcExtensionUIRequest): Promise<void> {
		switch (request.method) {
			case "confirm": {
				const yesId = this.registerPendingUi(conversation.key, request.id, "confirm", "yes");
				const noId = this.registerPendingUi(conversation.key, request.id, "confirm", "no");
				await this.sendText(conversation, `${request.title}\n\n${request.message}`, true, {
					inline_keyboard: [
						[
							{ text: "Approve", callback_data: `ui:${yesId}` },
							{ text: "Deny", callback_data: `ui:${noId}` },
						],
					],
				});
				return;
			}
			case "select": {
				const rows = request.options.slice(0, 20).map((option) => {
					const id = this.registerPendingUi(conversation.key, request.id, "select", option);
					return [{ text: truncateTelegramButtonText(option, 40), callback_data: `ui:${id}` }];
				});
				await this.sendText(conversation, request.title, true, { inline_keyboard: rows });
				return;
			}
			case "notify":
				await this.sendText(conversation, request.message, true);
				return;
			case "input":
			case "editor":
				await this.manager.respondToUi(conversation.key, {
					type: "extension_ui_response",
					id: request.id,
					cancelled: true,
				});
				await this.sendText(
					conversation,
					`${request.title}\nInteractive text input is not supported in Telegram yet.`,
					true,
				);
				return;
			case "setStatus":
			case "setWidget":
			case "setTitle":
			case "set_editor_text":
				return;
		}
	}

	private registerPendingUi(
		conversationKeyValue: string,
		requestId: string,
		kind: "confirm" | "select",
		value: string,
	): string {
		const id = randomUUID().slice(0, 12);
		this.pendingUi.set(id, { conversationKey: conversationKeyValue, requestId, kind, value });
		return id;
	}

	private assistantFinalText(message: AssistantEventMessage): string | undefined {
		if (message.stopReason === "toolUse") {
			return undefined;
		}
		const text = extractMessageText(message).trim();
		if (text) {
			return text;
		}
		if (message.stopReason === "error") {
			return message.errorMessage?.trim() || "Request failed.";
		}
		if (message.stopReason === "aborted") {
			return message.errorMessage?.trim() || "Request aborted.";
		}
		return undefined;
	}

	private async handleAgentEvent(conversation: ConversationRef, event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.streaming.set(conversation.key, {
					lastPreviewAt: 0,
					lastText: "",
				});
				this.startTypingIndicator(conversation);
				await this.updateStatus(conversation, "Working…");
				return;
			case "tool_execution_start":
				return;
			case "message_update":
				if (event.message.role === "assistant" && event.message.stopReason !== "toolUse") {
					await this.updateAssistantPreview(conversation, extractMessageText(event.message));
				}
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					await this.finishAssistantMessage(conversation, event.message);
				}
				return;
			case "agent_end":
				this.stopTypingIndicator(conversation.key);
				await this.clearStatus(conversation);
				return;
		}
	}

	private startTypingIndicator(conversation: ConversationRef): void {
		const state = this.streaming.get(conversation.key);
		if (!state || state.typingInterval) {
			return;
		}
		const sendTyping = (): void => {
			void this.api
				.sendChatAction({ chatId: conversation.chatId, threadId: conversation.threadId, action: "typing" })
				.catch(() => {});
		};
		sendTyping();
		state.typingInterval = setInterval(sendTyping, 4000);
	}

	private stopTypingIndicator(conversationKey: string): void {
		const state = this.streaming.get(conversationKey);
		if (state?.typingInterval) {
			clearInterval(state.typingInterval);
			state.typingInterval = undefined;
		}
	}

	private async updateStatus(conversation: ConversationRef, text: string): Promise<void> {
		const replyMarkup: InlineKeyboardMarkup = {
			inline_keyboard: [[this.actionButton("Stop", { type: "abort" })]],
		};
		let state = this.streaming.get(conversation.key);
		if (!state) {
			state = { lastPreviewAt: 0, lastText: "" };
			this.streaming.set(conversation.key, state);
			this.startTypingIndicator(conversation);
		}
		try {
			if (state.statusMessageId === undefined) {
				const sent = await this.api.sendMessage({
					chatId: conversation.chatId,
					threadId: conversation.threadId,
					text,
					disableNotification: true,
					replyMarkup,
				});
				state.statusMessageId = sent.message_id;
				return;
			}
			await this.api.editMessageText({
				chatId: conversation.chatId,
				threadId: conversation.threadId,
				messageId: state.statusMessageId,
				text,
				replyMarkup,
			});
		} catch {
			// Status updates are best-effort.
		}
	}

	private async clearStatus(conversation: ConversationRef): Promise<void> {
		const state = this.streaming.get(conversation.key);
		if (!state?.statusMessageId) {
			return;
		}
		try {
			await this.api.deleteMessage({ chatId: conversation.chatId, messageId: state.statusMessageId });
		} catch {
			// Deleting status messages is best-effort.
		}
	}

	private async updateAssistantPreview(conversation: ConversationRef, text: string): Promise<void> {
		if (!text || this.config.streaming === "off") {
			return;
		}
		let state = this.streaming.get(conversation.key);
		if (!state) {
			state = { lastPreviewAt: 0, lastText: "" };
			this.streaming.set(conversation.key, state);
			this.startTypingIndicator(conversation);
		}
		const now = Date.now();
		const minInterval = 1000;
		if (now - state.lastPreviewAt < minInterval || text === state.lastText) {
			return;
		}
		state.lastPreviewAt = now;
		state.lastText = text;
		const preview = truncateTelegramText(text, 3900);
		await this.updateEditPreview(conversation, state, preview);
	}

	private async updateEditPreview(conversation: ConversationRef, state: StreamingState, text: string): Promise<void> {
		try {
			if (state.previewMessageId === undefined) {
				const sent = await this.api.sendMessage({
					chatId: conversation.chatId,
					threadId: conversation.threadId,
					text,
					disableNotification: true,
				});
				state.previewMessageId = sent.message_id;
				return;
			}
			await this.api.editMessageText({
				chatId: conversation.chatId,
				threadId: conversation.threadId,
				messageId: state.previewMessageId,
				text,
			});
		} catch {
			// Streaming previews are best-effort; final delivery still happens.
		}
	}

	private async finishAssistantMessage(conversation: ConversationRef, message: AssistantEventMessage): Promise<void> {
		const state = this.streaming.get(conversation.key);
		const finalText = this.assistantFinalText(message);
		if (!finalText) {
			return;
		}
		const chunks = splitTelegramText(finalText);
		try {
			if (state?.previewMessageId !== undefined) {
				const text = chunks[0] ?? finalText;
				try {
					await this.api.editRichMessage({
						chatId: conversation.chatId,
						threadId: conversation.threadId,
						messageId: state.previewMessageId,
						text,
					});
				} catch {
					await this.api.editMessageText({
						chatId: conversation.chatId,
						threadId: conversation.threadId,
						messageId: state.previewMessageId,
						text,
					});
				}
				for (const chunk of chunks.slice(1)) {
					await this.sendText(conversation, chunk, false, undefined, true);
				}
				return;
			}
			for (const chunk of chunks) {
				await this.sendText(conversation, chunk, false, undefined, true);
			}
		} finally {
			this.stopTypingIndicator(conversation.key);
			await this.clearStatus(conversation);
			this.streaming.delete(conversation.key);
		}
	}

	private async sendText(
		conversation: ConversationRef,
		text: string,
		disableNotification: boolean,
		replyMarkup?: InlineKeyboardMarkup,
		richMarkdown = false,
	): Promise<void> {
		for (const chunk of splitTelegramText(text)) {
			const options = {
				chatId: conversation.chatId,
				threadId: conversation.threadId,
				text: chunk,
				disableNotification,
				replyMarkup,
			};
			if (richMarkdown) {
				try {
					await this.api.sendRichMessage(options);
					continue;
				} catch {
					// Fall back to plain text if Telegram rejects rich Markdown.
				}
			}
			await this.api.sendMessage(options);
		}
	}
}
