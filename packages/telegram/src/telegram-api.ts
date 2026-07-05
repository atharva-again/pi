import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	username?: string;
	has_topics_enabled?: boolean;
	allows_users_to_create_topics?: boolean;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel" | string;
	title?: string;
	username?: string;
}

export interface TelegramDocument {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	caption?: string;
	document?: TelegramDocument;
	reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface BotCommand {
	command: string;
	description: string;
}

export type ChatAction = "typing" | "upload_document" | "upload_photo" | "record_voice";

export type BotCommandScope =
	| { type: "default" }
	| { type: "all_private_chats" }
	| { type: "all_group_chats" }
	| { type: "chat"; chat_id: string | number };

interface InputRichMessage {
	markdown: string;
}

export interface SendMessageOptions {
	chatId: string;
	text: string;
	threadId?: string;
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
}

export interface SendDocumentOptions {
	chatId: string;
	path: string;
	threadId?: string;
	filename?: string;
	caption?: string;
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
}

export interface SentMessage {
	message_id: number;
	chat: TelegramChat;
	text?: string;
}

export interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

interface TelegramApiSuccess<T> {
	ok: true;
	result: T;
}

interface TelegramApiFailure {
	ok: false;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asApiResponse<T>(value: unknown): TelegramApiResponse<T> {
	if (!isRecord(value) || typeof value.ok !== "boolean") {
		return { ok: false, description: "Invalid Telegram API response" };
	}
	if (value.ok) {
		return { ok: true, result: value.result as T };
	}
	return {
		ok: false,
		error_code: typeof value.error_code === "number" ? value.error_code : undefined,
		description: typeof value.description === "string" ? value.description : undefined,
		parameters: isRecord(value.parameters)
			? { retry_after: typeof value.parameters.retry_after === "number" ? value.parameters.retry_after : undefined }
			: undefined,
	};
}

function normalizeChatId(chatId: string): string | number {
	const asNumber = Number(chatId);
	return Number.isSafeInteger(asNumber) ? asNumber : chatId;
}

function normalizeThreadId(threadId: string | undefined): number | undefined {
	if (threadId === undefined) return undefined;
	const asNumber = Number(threadId);
	return Number.isSafeInteger(asNumber) ? asNumber : undefined;
}

function normalizeCommandScope(scope: BotCommandScope | undefined): BotCommandScope | undefined {
	if (scope?.type !== "chat") {
		return scope;
	}
	return { type: "chat", chat_id: normalizeChatId(String(scope.chat_id)) };
}

export class TelegramApiError extends Error {
	readonly method: string;
	readonly code?: number;
	readonly retryAfter?: number;

	constructor(method: string, response: TelegramApiFailure) {
		super(response.description ?? `Telegram API ${method} failed`);
		this.name = "TelegramApiError";
		this.method = method;
		this.code = response.error_code;
		this.retryAfter = response.parameters?.retry_after;
	}
}

export class TelegramApi {
	private readonly baseUrl: string;
	private readonly fileBaseUrl: string;

	constructor(token: string, baseUrl = "https://api.telegram.org") {
		this.baseUrl = `${baseUrl}/bot${token}`;
		this.fileBaseUrl = `${baseUrl}/file/bot${token}`;
	}

	private async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
		const response = await fetch(`${this.baseUrl}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = asApiResponse<T>(await response.json());
		if (!json.ok) {
			throw new TelegramApiError(method, json);
		}
		return json.result;
	}

	private async requestMultipart<T>(method: string, body: FormData): Promise<T> {
		const response = await fetch(`${this.baseUrl}/${method}`, {
			method: "POST",
			body,
		});
		const json = asApiResponse<T>(await response.json());
		if (!json.ok) {
			throw new TelegramApiError(method, json);
		}
		return json.result;
	}

	async getMe(): Promise<TelegramUser> {
		return this.request<TelegramUser>("getMe", {});
	}

	async getUpdates(options: { offset?: number; timeout: number }): Promise<TelegramUpdate[]> {
		return this.request<TelegramUpdate[]>("getUpdates", {
			offset: options.offset,
			timeout: options.timeout,
			allowed_updates: ["message", "callback_query"],
		});
	}

	async setMyCommands(commands: BotCommand[], scope?: BotCommandScope): Promise<boolean> {
		return this.request<boolean>("setMyCommands", { commands, scope: normalizeCommandScope(scope) });
	}

	async sendChatAction(options: { chatId: string; threadId?: string; action: ChatAction }): Promise<boolean> {
		return this.request<boolean>("sendChatAction", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			action: options.action,
		});
	}

	async sendMessage(options: SendMessageOptions): Promise<SentMessage> {
		return this.request<SentMessage>("sendMessage", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			text: options.text,
			disable_notification: options.disableNotification,
			reply_markup: options.replyMarkup,
		});
	}

	async sendRichMessage(options: SendMessageOptions): Promise<SentMessage> {
		const richMessage: InputRichMessage = { markdown: options.text };
		return this.request<SentMessage>("sendRichMessage", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			rich_message: richMessage,
			disable_notification: options.disableNotification,
			reply_markup: options.replyMarkup,
		});
	}

	async sendDocument(options: SendDocumentOptions): Promise<SentMessage> {
		const form = new FormData();
		form.append("chat_id", String(normalizeChatId(options.chatId)));
		const threadId = normalizeThreadId(options.threadId);
		if (threadId !== undefined) {
			form.append("message_thread_id", String(threadId));
		}
		if (options.caption !== undefined) {
			form.append("caption", options.caption);
		}
		if (options.disableNotification !== undefined) {
			form.append("disable_notification", String(options.disableNotification));
		}
		if (options.replyMarkup !== undefined) {
			form.append("reply_markup", JSON.stringify(options.replyMarkup));
		}
		const data = await readFile(options.path);
		form.append("document", new Blob([new Uint8Array(data)]), options.filename ?? basename(options.path));
		return this.requestMultipart<SentMessage>("sendDocument", form);
	}

	async editMessageText(options: {
		chatId: string;
		messageId: number;
		text: string;
		threadId?: string;
		replyMarkup?: InlineKeyboardMarkup;
	}): Promise<SentMessage | true> {
		return this.request<SentMessage | true>("editMessageText", {
			chat_id: normalizeChatId(options.chatId),
			message_id: options.messageId,
			message_thread_id: normalizeThreadId(options.threadId),
			text: options.text,
			reply_markup: options.replyMarkup,
		});
	}

	async editRichMessage(options: {
		chatId: string;
		messageId: number;
		text: string;
		threadId?: string;
		replyMarkup?: InlineKeyboardMarkup;
	}): Promise<SentMessage | true> {
		const richMessage: InputRichMessage = { markdown: options.text };
		return this.request<SentMessage | true>("editMessageText", {
			chat_id: normalizeChatId(options.chatId),
			message_id: options.messageId,
			message_thread_id: normalizeThreadId(options.threadId),
			rich_message: richMessage,
			reply_markup: options.replyMarkup,
		});
	}

	async deleteMessage(options: { chatId: string; messageId: number }): Promise<boolean> {
		return this.request<boolean>("deleteMessage", {
			chat_id: normalizeChatId(options.chatId),
			message_id: options.messageId,
		});
	}

	async answerCallbackQuery(options: { callbackQueryId: string; text?: string }): Promise<boolean> {
		return this.request<boolean>("answerCallbackQuery", {
			callback_query_id: options.callbackQueryId,
			text: options.text,
			show_alert: false,
		});
	}

	async getFile(fileId: string): Promise<TelegramFile> {
		return this.request<TelegramFile>("getFile", { file_id: fileId });
	}

	async downloadFile(filePath: string): Promise<Buffer> {
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		const response = await fetch(`${this.fileBaseUrl}/${encodedPath}`);
		if (!response.ok) {
			throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
		}
		return Buffer.from(await response.arrayBuffer());
	}

	async sendMessageDraft(options: {
		chatId: string;
		draftId: number;
		text: string;
		threadId?: string;
	}): Promise<boolean> {
		return this.request<boolean>("sendMessageDraft", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			draft_id: options.draftId,
			text: options.text,
		});
	}

	async sendRichMessageDraft(options: {
		chatId: string;
		draftId: number;
		text: string;
		threadId?: string;
	}): Promise<boolean> {
		const richMessage: InputRichMessage = { markdown: options.text };
		return this.request<boolean>("sendRichMessageDraft", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			draft_id: options.draftId,
			rich_message: richMessage,
		});
	}
}
