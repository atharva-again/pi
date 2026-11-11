import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { deflateSync } from "node:zlib";

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
	is_forum?: boolean;
}

export interface TelegramDocument {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id?: string;
	width: number;
	height: number;
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
	photo?: TelegramPhotoSize[];
	reply_to_message?: TelegramMessage;
	widget?: TelegramWidget;
}

export interface TelegramWidget {
	id?: string;
	width?: number;
	height?: number;
	html: string;
	public_data?: string;
	chat_data?: string;
}

export interface TelegramWidgetQueryType {
	type: string;
}

export interface TelegramWidgetQuery {
	id: string;
	from: TelegramUser;
	chat?: TelegramChat;
	message_id?: number;
	inline_message_id?: string;
	chat_instance: string;
	chat_type?: string;
	type: TelegramWidgetQueryType;
	data: string;
	widget_id?: string;
}

export interface TelegramSharedWidgetQuery {
	id: string;
	from: TelegramUser;
	type: TelegramWidgetQueryType;
	data: string;
	widget_id: string;
}

export interface TelegramInlineQuery {
	id: string;
	from: TelegramUser;
	query: string;
	offset: string;
	chat_type?: string;
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
	widget_query?: TelegramWidgetQuery;
	shared_widget_query?: TelegramSharedWidgetQuery;
	inline_query?: TelegramInlineQuery;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramKeyboardButton {
	text: string;
	[key: string]: unknown;
}

export type TelegramReplyMarkup =
	| InlineKeyboardMarkup
	| {
			keyboard: TelegramKeyboardButton[][];
			is_persistent?: boolean;
			resize_keyboard?: boolean;
			one_time_keyboard?: boolean;
			input_field_placeholder?: string;
			selective?: boolean;
	  }
	| { remove_keyboard: true; selective?: boolean }
	| { force_reply: true; input_field_placeholder?: string; selective?: boolean };

export interface TelegramMessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: TelegramUser;
	language?: string;
	custom_emoji_id?: string;
}

export interface TelegramReplyParameters {
	message_id: number;
	chat_id?: string | number;
	allow_sending_without_reply?: boolean;
	quote?: string;
	quote_parse_mode?: TelegramCaptionParseMode;
	quote_entities?: TelegramMessageEntity[];
	quote_position?: number;
	checklist_task_id?: number;
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

export type TelegramParseMode = "MarkdownV2";
export type TelegramCaptionParseMode = "HTML" | "Markdown" | "MarkdownV2";

interface InputRichMessage {
	markdown: string;
}

export interface SendMessageOptions {
	chatId: string;
	text: string;
	threadId?: string;
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
	parseMode?: TelegramParseMode;
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

export interface SendPhotoOptions {
	chatId: string;
	photo: string | Uint8Array;
	threadId?: string;
	filename?: string;
	caption?: string;
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
}

export interface SendAnimationOptions {
	chatId: string;
	animation: string | Uint8Array;
	threadId?: string;
	filename?: string;
	caption?: string;
	disableNotification?: boolean;
	replyMarkup?: InlineKeyboardMarkup;
}

export interface SendWidgetOptions {
	chatId: string;
	html: string;
	threadId?: string;
	caption?: string;
	parseMode?: TelegramCaptionParseMode;
	captionEntities?: TelegramMessageEntity[];
	width?: number;
	height?: number;
	publicData?: string;
	chatData?: string;
	allowQueries?: boolean;
	isShared?: boolean;
	showCaptionAboveMedia?: boolean;
	disableNotification?: boolean;
	protectContent?: boolean;
	allowPaidBroadcast?: boolean;
	messageEffectId?: string;
	replyParameters?: TelegramReplyParameters;
	replyMarkup?: TelegramReplyMarkup;
}

export interface SendSharedWidgetOptions {
	chatId: string;
	widgetId: string;
	threadId?: string;
	chatData?: string;
	caption?: string;
	parseMode?: TelegramCaptionParseMode;
	captionEntities?: TelegramMessageEntity[];
	showCaptionAboveMedia?: boolean;
	disableNotification?: boolean;
	protectContent?: boolean;
	allowPaidBroadcast?: boolean;
	messageEffectId?: string;
	replyParameters?: TelegramReplyParameters;
	replyMarkup?: TelegramReplyMarkup;
}

export interface EditMessageWidgetDataOptions {
	chatId?: string;
	messageId?: number;
	inlineMessageId?: string;
	publicData?: string;
	chatData?: string;
}

export interface InlineWidgetMessageContent {
	html: string;
	width?: number;
	height?: number;
	public_data?: string;
	chat_data?: string;
	caption?: string;
	parse_mode?: TelegramCaptionParseMode;
	caption_entities?: TelegramMessageEntity[];
	show_caption_above_media?: boolean;
	allow_queries?: boolean;
	is_shared?: boolean;
}

export interface InlineSharedWidgetMessageContent {
	widget_id: string;
	chat_data?: string;
	caption?: string;
	parse_mode?: TelegramCaptionParseMode;
	caption_entities?: TelegramMessageEntity[];
	show_caption_above_media?: boolean;
}

export interface AnswerInlineWidgetQueryOptions {
	inlineQueryId: string;
	resultId: string;
	title: string;
	description?: string;
	content: InlineWidgetMessageContent | InlineSharedWidgetMessageContent;
}

export interface InlineWidgetResult {
	type: "article";
	id: string;
	title: string;
	description?: string;
	input_message_content: InlineWidgetMessageContent | InlineSharedWidgetMessageContent;
}

export interface InlineTextResult {
	type: "article";
	id: string;
	title: string;
	description?: string;
	input_message_content: { message_text: string };
}

export type TelegramInlineResult = InlineWidgetResult | InlineTextResult;

export interface SentMessage {
	message_id: number;
	chat: TelegramChat;
	text?: string;
	widget?: TelegramWidget;
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

export function validateWidgetData(value: string | undefined, name: string): void {
	if (value !== undefined && Buffer.byteLength(value, "utf8") > 1024) {
		throw new Error(`Telegram widget ${name} must be at most 1024 UTF-8 bytes`);
	}
}

function validateCaptionFormatting(
	parseMode: TelegramCaptionParseMode | undefined,
	entities: TelegramMessageEntity[] | undefined,
): void {
	if (parseMode !== undefined && entities !== undefined) {
		throw new Error("Telegram widget captions cannot use both parseMode and captionEntities");
	}
}

function validateWidgetHtml(html: string): void {
	const htmlBytes = Buffer.byteLength(html, "utf8");
	if (htmlBytes < 1 || htmlBytes > 32_768) {
		throw new Error("Telegram widget HTML must be between 1 and 32768 UTF-8 bytes");
	}
	if (html.includes("\0")) {
		throw new Error("Telegram widget HTML must not contain a NUL character");
	}
	const compressedBytes = deflateSync(Buffer.from(html, "utf8"), { level: 9 }).byteLength;
	if (compressedBytes > 4096) {
		throw new Error("Telegram widget HTML must be at most 4096 bytes when compressed");
	}
}

function validateWidgetSize(options: { width?: number; height?: number }): void {
	if (
		options.width !== undefined &&
		(!Number.isSafeInteger(options.width) || (options.width !== 0 && options.width < 200))
	) {
		throw new Error("Telegram widget width must be 0 or an integer of at least 200 logical pixels");
	}
	if (
		options.height !== undefined &&
		(!Number.isSafeInteger(options.height) || (options.height !== 0 && (options.height < 50 || options.height > 600)))
	) {
		throw new Error("Telegram widget height must be 0 or an integer between 50 and 600 logical pixels");
	}
}

export function createInlineWidgetResult(options: AnswerInlineWidgetQueryOptions): InlineWidgetResult {
	if (options.resultId.length < 1 || options.resultId.length > 64) {
		throw new Error("Telegram inline widget result ID must be between 1 and 64 characters");
	}
	if (options.title.length < 1 || options.title.length > 64) {
		throw new Error("Telegram inline widget title must be between 1 and 64 characters");
	}
	if (options.description !== undefined && options.description.length > 256) {
		throw new Error("Telegram inline widget description must be at most 256 characters");
	}
	validateCaptionFormatting(options.content.parse_mode, options.content.caption_entities);
	if ("html" in options.content) {
		validateWidgetHtml(options.content.html);
		validateWidgetData(options.content.public_data, "public_data");
		validateWidgetSize(options.content);
	}
	validateWidgetData(options.content.chat_data, "chat_data");
	return {
		type: "article",
		id: options.resultId,
		title: options.title,
		description: options.description,
		input_message_content: options.content,
	};
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

	constructor(token: string, baseUrl = "https://api.telegram.org", useTestServer = false) {
		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
		this.baseUrl = `${normalizedBaseUrl}/bot${token}${useTestServer ? "/test" : ""}`;
		this.fileBaseUrl = `${normalizedBaseUrl}/file/bot${token}`;
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
			allowed_updates: ["message", "callback_query", "widget_query", "shared_widget_query", "inline_query"],
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
			parse_mode: options.parseMode,
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

	async sendPhoto(options: SendPhotoOptions): Promise<SentMessage> {
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
		const data = typeof options.photo === "string" ? await readFile(options.photo) : options.photo;
		form.append("photo", new Blob([new Uint8Array(data)]), options.filename ?? "image.jpg");
		return this.requestMultipart<SentMessage>("sendPhoto", form);
	}

	async sendAnimation(options: SendAnimationOptions): Promise<SentMessage> {
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
		const data = typeof options.animation === "string" ? await readFile(options.animation) : options.animation;
		form.append("animation", new Blob([new Uint8Array(data)]), options.filename ?? "animation.gif");
		return this.requestMultipart<SentMessage>("sendAnimation", form);
	}

	async sendWidget(options: SendWidgetOptions): Promise<SentMessage> {
		validateWidgetHtml(options.html);
		validateWidgetData(options.publicData, "public_data");
		validateWidgetData(options.chatData, "chat_data");
		validateWidgetSize(options);
		validateCaptionFormatting(options.parseMode, options.captionEntities);

		return this.request<SentMessage>("sendWidget", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			html: options.html,
			caption: options.caption,
			parse_mode: options.parseMode,
			caption_entities: options.captionEntities,
			width: options.width,
			height: options.height,
			public_data: options.publicData,
			chat_data: options.chatData,
			allow_queries: options.allowQueries,
			is_shared: options.isShared,
			show_caption_above_media: options.showCaptionAboveMedia,
			disable_notification: options.disableNotification,
			protect_content: options.protectContent,
			allow_paid_broadcast: options.allowPaidBroadcast,
			message_effect_id: options.messageEffectId,
			reply_parameters: options.replyParameters,
			reply_markup: options.replyMarkup,
		});
	}

	async sendSharedWidget(options: SendSharedWidgetOptions): Promise<SentMessage> {
		validateWidgetData(options.chatData, "chat_data");
		validateCaptionFormatting(options.parseMode, options.captionEntities);
		return this.request<SentMessage>("sendSharedWidget", {
			chat_id: normalizeChatId(options.chatId),
			message_thread_id: normalizeThreadId(options.threadId),
			widget_id: options.widgetId,
			chat_data: options.chatData,
			caption: options.caption,
			parse_mode: options.parseMode,
			caption_entities: options.captionEntities,
			show_caption_above_media: options.showCaptionAboveMedia,
			disable_notification: options.disableNotification,
			protect_content: options.protectContent,
			allow_paid_broadcast: options.allowPaidBroadcast,
			message_effect_id: options.messageEffectId,
			reply_parameters: options.replyParameters,
			reply_markup: options.replyMarkup,
		});
	}

	async answerWidgetQuery(options: { widgetQueryId: string; data?: string }): Promise<boolean> {
		validateWidgetData(options.data, "query answer data");
		return this.request<boolean>("answerWidgetQuery", {
			widget_query_id: options.widgetQueryId,
			data: options.data,
		});
	}

	async editMessageWidgetData(options: EditMessageWidgetDataOptions): Promise<boolean> {
		const hasInlineMessageId = options.inlineMessageId !== undefined;
		const hasChatMessage = options.chatId !== undefined && options.messageId !== undefined;
		if (
			hasInlineMessageId === hasChatMessage ||
			(options.chatId !== undefined) !== (options.messageId !== undefined)
		) {
			throw new Error("Edit widget data requires either inlineMessageId or both chatId and messageId");
		}
		if (options.publicData === undefined && options.chatData === undefined) {
			throw new Error("Edit widget data requires publicData or chatData");
		}
		validateWidgetData(options.publicData, "public_data");
		validateWidgetData(options.chatData, "chat_data");
		return this.request<boolean>("editMessageWidgetData", {
			chat_id: options.chatId === undefined ? undefined : normalizeChatId(options.chatId),
			message_id: options.messageId,
			inline_message_id: options.inlineMessageId,
			public_data: options.publicData,
			chat_data: options.chatData,
		});
	}

	async editSharedWidgetData(options: { widgetId: string; publicData: string; cacheTime?: number }): Promise<boolean> {
		validateWidgetData(options.publicData, "public_data");
		if (options.cacheTime !== undefined && (options.cacheTime < 5 || options.cacheTime > 3600)) {
			throw new Error("Telegram widget cacheTime must be between 5 and 3600 seconds");
		}
		return this.request<boolean>("editSharedWidgetData", {
			widget_id: options.widgetId,
			public_data: options.publicData,
			cache_time: options.cacheTime,
		});
	}

	async answerInlineWidgetQuery(options: AnswerInlineWidgetQueryOptions): Promise<boolean> {
		return this.answerInlineQuery({
			inlineQueryId: options.inlineQueryId,
			results: [createInlineWidgetResult(options)],
		});
	}

	async answerInlineQuery(options: { inlineQueryId: string; results: TelegramInlineResult[] }): Promise<boolean> {
		return this.request<boolean>("answerInlineQuery", {
			inline_query_id: options.inlineQueryId,
			results: options.results,
			cache_time: 0,
			is_personal: true,
		});
	}

	async editMessageText(options: {
		chatId: string;
		messageId: number;
		text: string;
		threadId?: string;
		replyMarkup?: InlineKeyboardMarkup;
		parseMode?: TelegramParseMode;
	}): Promise<SentMessage | true> {
		return this.request<SentMessage | true>("editMessageText", {
			chat_id: normalizeChatId(options.chatId),
			message_id: options.messageId,
			message_thread_id: normalizeThreadId(options.threadId),
			text: options.text,
			parse_mode: options.parseMode,
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
}
