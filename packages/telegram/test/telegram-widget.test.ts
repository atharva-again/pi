import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPiBot } from "../src/bot.ts";
import type { ConversationRef } from "../src/pi-manager.ts";
import { TelegramBindingStore } from "../src/store.ts";
import {
	type SendWidgetOptions,
	TelegramApi,
	type TelegramInlineQuery,
	type TelegramInlineResult,
	type TelegramSharedWidgetQuery,
	type TelegramWidgetQuery,
} from "../src/telegram-api.ts";
import { createTelegramWidgetTool } from "../src/telegram-widget-extension.ts";
import { TelegramQueryAnswers } from "../src/widget-query-answers.ts";

type WidgetQueryBotContext = {
	isAuthorizedWidgetSender(sender: TelegramWidgetQuery["from"], targetChatId?: string): boolean;
	widgetConversation(query: TelegramWidgetQuery): ConversationRef;
	answerWidgetQuerySafely(queryId: string, data?: string): void;
	promptForWidgetInteraction(conversation: ConversationRef, queryId: string, prompt: string): void;
};

type InlineQueryBotContext = {
	isAuthorizedWidgetSender(sender: TelegramInlineQuery["from"]): boolean;
	telegramTestServer: boolean;
	api: {
		answerInlineQuery(options: { inlineQueryId: string; results: TelegramInlineResult[] }): Promise<boolean>;
	};
	manager: {
		prompt(conversation: ConversationRef, prompt: string): Promise<string | undefined>;
	};
	widgetQueries: Pick<TelegramQueryAnswers, "beginInline" | "failInline">;
	widgetOnlyConversations: Set<string>;
};

type WidgetEventBotContext = {
	widgetOnlyConversations: Set<string>;
	streaming: Map<string, { previewTextBlocks: Map<number, string> }>;
	startTypingIndicator(conversation: ConversationRef): void;
	stopTypingIndicator(key: string): void;
	updateStatus(conversation: ConversationRef, text: string): Promise<void>;
	clearStatus(conversation: ConversationRef): Promise<void>;
	updateAssistantPreview(conversation: ConversationRef, text: string): Promise<void>;
	finishAssistantMessage(conversation: ConversationRef, message: unknown): Promise<void>;
	handleWidgetToolResult(conversation: ConversationRef, event: RpcAgentSessionEvent): void;
};

type WidgetQueryBotPrototype = {
	widgetConversation(
		this: { store: Pick<TelegramBindingStore, "getWidgetBinding"> },
		query: TelegramWidgetQuery,
	): ConversationRef;
	handleWidgetQuery(this: WidgetQueryBotContext, query: TelegramWidgetQuery): Promise<void>;
	handleSharedWidgetQuery(
		this: Omit<WidgetQueryBotContext, "widgetConversation">,
		query: TelegramSharedWidgetQuery,
	): Promise<void>;
	handleInlineQuery(this: InlineQueryBotContext, query: TelegramInlineQuery): Promise<void>;
	handleAgentEvent(
		this: WidgetEventBotContext,
		conversation: ConversationRef,
		event: RpcAgentSessionEvent,
	): Promise<void>;
};

const widgetBotPrototype = TelegramPiBot.prototype as unknown as WidgetQueryBotPrototype;
const widgetConversation: ConversationRef = { key: "12345:root", chatId: "12345", chatType: "private" };
const temporaryDirectories: string[] = [];

function createInlineQueryContext(telegramTestServer: boolean) {
	const api = {
		answerWidgetQuery: vi.fn(async () => true),
		answerInlineQuery: vi.fn(async () => true),
	};
	return {
		isAuthorizedWidgetSender: () => true,
		telegramTestServer,
		api,
		manager: { prompt: vi.fn(async (): Promise<string | undefined> => undefined) },
		widgetQueries: new TelegramQueryAnswers(api),
		widgetOnlyConversations: new Set<string>(),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Telegram widgets", () => {
	it("sends the widget HTML and optional display settings through the Bot API", async () => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						ok: true,
						result: { message_id: 42, chat: { id: 12345, type: "private" } },
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const message = await new TelegramApi("bot-token").sendWidget({
			chatId: "12345",
			threadId: "678",
			html: "<html><body><button>Filter</button></body></html>",
			caption: "October spending",
			captionEntities: [{ type: "bold", offset: 0, length: 7 }],
			width: 360,
			height: 480,
			publicData: '{"revision":1}',
			chatData: '{"filter":"all"}',
			allowQueries: true,
			isShared: true,
			showCaptionAboveMedia: true,
			disableNotification: true,
			protectContent: true,
			allowPaidBroadcast: true,
			messageEffectId: "effect-1",
			replyParameters: { message_id: 40, quote: "details" },
			replyMarkup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] },
		});

		expect(message.message_id).toBe(42);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.telegram.org/botbot-token/sendWidget");
		expect(JSON.parse(String(init?.body))).toEqual({
			chat_id: 12345,
			message_thread_id: 678,
			html: "<html><body><button>Filter</button></body></html>",
			caption: "October spending",
			caption_entities: [{ type: "bold", offset: 0, length: 7 }],
			width: 360,
			height: 480,
			public_data: '{"revision":1}',
			chat_data: '{"filter":"all"}',
			allow_queries: true,
			is_shared: true,
			show_caption_above_media: true,
			disable_notification: true,
			protect_content: true,
			allow_paid_broadcast: true,
			message_effect_id: "effect-1",
			reply_parameters: { message_id: 40, quote: "details" },
			reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open" }]] },
		});
	});

	it("rejects HTML that exceeds Telegram's UTF-8 or compressed-size limits", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const api = new TelegramApi("bot-token");

		await expect(api.sendWidget({ chatId: "12345", html: "🙂".repeat(8193) })).rejects.toThrow("32768 UTF-8 bytes");
		await expect(api.sendWidget({ chatId: "12345", html: randomBytes(5000).toString("hex") })).rejects.toThrow(
			"4096 bytes when compressed",
		);
		await expect(api.sendWidget({ chatId: "12345", html: "<p>\0</p>" })).rejects.toThrow("NUL character");
		await expect(api.sendWidget({ chatId: "12345", html: "<p>test</p>", width: 199 })).rejects.toThrow(
			"width must be 0 or an integer",
		);
		await expect(api.sendWidget({ chatId: "12345", html: "<p>test</p>", height: 601 })).rejects.toThrow(
			"height must be 0 or an integer",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("supports widget queries, state updates, shared widgets, and inline widget results", async () => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const api = new TelegramApi("test-token", undefined, true);

		await api.answerWidgetQuery({ widgetQueryId: "query-1", data: '{"status":"ready"}' });
		await api.editMessageWidgetData({ chatId: "12345", messageId: 42, chatData: '{"page":2}' });
		await api.editMessageWidgetData({ inlineMessageId: "inline-1", publicData: '{"votes":3}' });
		await api.editSharedWidgetData({ widgetId: "shared-1", publicData: '{"votes":4}', cacheTime: 5 });
		await api.sendSharedWidget({
			chatId: "12345",
			widgetId: "shared-1",
			caption: "Shared dashboard",
			parseMode: "HTML",
		});
		await api.answerInlineWidgetQuery({
			inlineQueryId: "inline-query-1",
			resultId: "result-1",
			title: "October spending",
			content: {
				html: "<html><body>October</body></html>",
				width: 0,
				height: 0,
				caption: "October",
				show_caption_above_media: true,
				allow_queries: true,
			},
		});

		const requests = fetchMock.mock.calls.map(([url, init]) => ({
			url: String(url),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		}));
		expect(requests.map(({ url }) => url)).toEqual([
			"https://api.telegram.org/bottest-token/test/answerWidgetQuery",
			"https://api.telegram.org/bottest-token/test/editMessageWidgetData",
			"https://api.telegram.org/bottest-token/test/editMessageWidgetData",
			"https://api.telegram.org/bottest-token/test/editSharedWidgetData",
			"https://api.telegram.org/bottest-token/test/sendSharedWidget",
			"https://api.telegram.org/bottest-token/test/answerInlineQuery",
		]);
		expect(requests[0]?.body).toEqual({ widget_query_id: "query-1", data: '{"status":"ready"}' });
		expect(requests[2]?.body).toEqual({ inline_message_id: "inline-1", public_data: '{"votes":3}' });
		expect(requests[4]?.body).toMatchObject({
			chat_id: 12345,
			widget_id: "shared-1",
			caption: "Shared dashboard",
			parse_mode: "HTML",
		});
		expect(requests[5]?.body).toMatchObject({
			inline_query_id: "inline-query-1",
			cache_time: 0,
			is_personal: true,
			results: [
				{
					type: "article",
					id: "result-1",
					title: "October spending",
					input_message_content: {
						html: "<html><body>October</body></html>",
						width: 0,
						height: 0,
						caption: "October",
						show_caption_above_media: true,
						allow_queries: true,
					},
				},
			],
		});
	});

	it("requests widget and inline updates while polling", async () => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await new TelegramApi("bot-token").getUpdates({ timeout: 25 });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.telegram.org/botbot-token/getUpdates");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			allowed_updates: expect.arrayContaining(["widget_query", "shared_widget_query", "inline_query"]),
		});
	});

	it("binds the agent tool to its current chat instead of accepting a model-selected destination", async () => {
		let sentOptions: SendWidgetOptions | undefined;
		const tool = createTelegramWidgetTool(
			{
				sendWidget: async (options) => {
					sentOptions = options;
					return { message_id: 77, chat: { id: 12345, type: "private" } };
				},
			},
			"12345",
			"678",
		);

		const result = await tool.execute(
			"tool-call",
			{ html: "<html><body>Custom dashboard</body></html>" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(sentOptions).toEqual({
			chatId: "12345",
			threadId: "678",
			html: "<html><body>Custom dashboard</body></html>",
			caption: undefined,
			width: undefined,
			height: undefined,
			publicData: undefined,
			chatData: undefined,
			allowQueries: undefined,
			isShared: undefined,
			showCaptionAboveMedia: undefined,
		});
		expect(result.content).toContainEqual({
			type: "text",
			text: "Sent interactive widget as Telegram message 77.",
		});
	});

	it("only forwards supported widget data and omits extra query fields", async () => {
		const promptForWidgetInteraction = vi.fn();
		const answerWidgetQuerySafely = vi.fn();
		const context: WidgetQueryBotContext = {
			isAuthorizedWidgetSender: () => true,
			widgetConversation: () => widgetConversation,
			answerWidgetQuerySafely,
			promptForWidgetInteraction,
		};
		const baseQuery = {
			id: "widget-query",
			from: { id: 12345, first_name: "Alice" },
			chat: { id: 12345, type: "private" },
			chat_instance: "chat-instance",
			data: "payment:42",
		};

		const dataType: TelegramWidgetQuery["type"] = { type: "data" };
		Object.assign(dataType, { wallet_card: { address: "wallet-address", amount: "1250000000" } });
		await widgetBotPrototype.handleWidgetQuery.call(context, { ...baseQuery, type: dataType });

		await widgetBotPrototype.handleWidgetQuery.call(context, {
			...baseQuery,
			id: "unsupported-query",
			type: { type: "sign_data" },
		});

		expect(promptForWidgetInteraction).toHaveBeenCalledTimes(1);
		expect(promptForWidgetInteraction.mock.calls[0]?.[2]).toContain('"query_type":{"type":"data"}');
		expect(promptForWidgetInteraction.mock.calls[0]?.[2]).not.toContain("wallet_card");
		expect(answerWidgetQuerySafely).toHaveBeenCalledWith(
			"unsupported-query",
			JSON.stringify({ error: "Unsupported widget interaction type." }),
		);
	});

	it("routes forwarded shared-widget queries with only their public interaction context", async () => {
		const promptForWidgetInteraction = vi.fn();
		const answerWidgetQuerySafely = vi.fn();
		const dataType: TelegramSharedWidgetQuery["type"] = { type: "data" };
		Object.assign(dataType, { wallet_card: { address: "wallet-address", amount: "1250000000" } });
		const context = {
			isAuthorizedWidgetSender: () => true,
			answerWidgetQuerySafely,
			promptForWidgetInteraction,
		};

		await widgetBotPrototype.handleSharedWidgetQuery.call(context, {
			id: "shared-query",
			from: { id: 12345, first_name: "Alice" },
			type: dataType,
			data: "refresh",
			widget_id: "shared-widget",
		});
		await widgetBotPrototype.handleSharedWidgetQuery.call(context, {
			id: "unsupported-shared-query",
			from: { id: 12345, first_name: "Alice" },
			type: { type: "sent_transaction" },
			data: "transaction",
			widget_id: "shared-widget",
		});

		expect(promptForWidgetInteraction).toHaveBeenCalledTimes(1);
		expect(promptForWidgetInteraction.mock.calls[0]?.[2]).toContain('"type":"data"');
		expect(promptForWidgetInteraction.mock.calls[0]?.[2]).not.toContain("wallet_card");
		expect(promptForWidgetInteraction.mock.calls[0]?.[2]).toContain("do not use unrelated private chat");
		expect(answerWidgetQuerySafely).toHaveBeenCalledWith(
			"unsupported-shared-query",
			JSON.stringify({ error: "Unsupported widget interaction type." }),
		);
	});

	it("persists widget-to-topic conversation bindings across restarts", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tg-widget-store-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "bindings.json");
		const store = new TelegramBindingStore(path);
		const binding = {
			chatId: "-10012345",
			messageId: 77,
			threadId: "456",
			chatType: "supergroup",
		};

		store.setWidgetBinding(binding);

		const restartedStore = new TelegramBindingStore(path);
		expect(restartedStore.getWidgetBinding("-10012345", 77)).toEqual(binding);
		expect(
			widgetBotPrototype.widgetConversation.call(
				{ store: restartedStore },
				{
					id: "query",
					from: { id: 12345, first_name: "Alice" },
					chat: { id: -10012345, type: "supergroup" },
					message_id: 77,
					chat_instance: "instance",
					type: { type: "data" },
					data: "refresh",
				},
			),
		).toEqual({
			key: "-10012345:456",
			chatId: "-10012345",
			threadId: "456",
			chatType: "supergroup",
		});
	});

	it("explains the production restriction instead of silently dropping inline widget requests", async () => {
		const context = createInlineQueryContext(false);

		await widgetBotPrototype.handleInlineQuery.call(context, {
			id: "inline-query",
			from: { id: 12345, first_name: "Alice" },
			query: "spending dashboard",
			offset: "",
		});

		expect(context.api.answerInlineQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				inlineQueryId: "inline-query",
				results: [
					expect.objectContaining({
						title: "Telegram test server required",
						input_message_content: expect.objectContaining({
							message_text: expect.stringContaining("PI_TELEGRAM_TEST_SERVER=1"),
						}),
					}),
				],
			}),
		);
	});

	it.each(["returned error", "rejected promise"])("cleans up an inline query after a %s", async (failure) => {
		vi.useFakeTimers();
		const context = createInlineQueryContext(true);
		if (failure === "returned error") {
			context.manager.prompt.mockResolvedValue("Pi is unavailable");
		} else {
			context.manager.prompt.mockRejectedValue(new Error("Pi is unavailable"));
		}

		await widgetBotPrototype.handleInlineQuery.call(context, {
			id: "inline-query",
			from: { id: 12345 },
			query: "dashboard",
			offset: "",
		});
		await vi.runAllTimersAsync();

		expect(context.api.answerInlineQuery).toHaveBeenCalledExactlyOnceWith({
			inlineQueryId: "inline-query",
			results: [],
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(context.widgetOnlyConversations.size).toBe(0);
	});

	it("keeps the inline fallback scheduled when Pi accepts the prompt", async () => {
		vi.useFakeTimers();
		const context = createInlineQueryContext(true);

		await widgetBotPrototype.handleInlineQuery.call(context, {
			id: "inline-query",
			from: { id: 12345 },
			query: "dashboard",
			offset: "",
		});
		await vi.advanceTimersByTimeAsync(7_999);
		expect(context.api.answerInlineQuery).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		expect(context.widgetOnlyConversations.has(widgetConversation.key)).toBe(true);

		await vi.advanceTimersByTimeAsync(1);
		expect(context.api.answerInlineQuery).toHaveBeenCalledExactlyOnceWith({
			inlineQueryId: "inline-query",
			results: [],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("suppresses widget chat output but still processes tool results and run cleanup", async () => {
		const previewTextBlocks = new Map([[0, "Existing preview"]]);
		const context = {
			widgetOnlyConversations: new Set([widgetConversation.key]),
			streaming: new Map([[widgetConversation.key, { previewTextBlocks }]]),
			startTypingIndicator: vi.fn(),
			stopTypingIndicator: vi.fn(),
			updateStatus: vi.fn(async () => {}),
			clearStatus: vi.fn(async () => {}),
			updateAssistantPreview: vi.fn(async () => {}),
			finishAssistantMessage: vi.fn(async () => {}),
			handleWidgetToolResult: vi.fn(),
		};
		const message: Extract<RpcAgentSessionEvent, { type: "message_end" }>["message"] = {
			role: "assistant",
			content: [{ type: "text", text: "Widget response" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const suppressedEvents: RpcAgentSessionEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message },
			{
				type: "message_update",
				usage: message.usage,
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Widget response" },
			},
			{ type: "message_end", message },
		];
		for (const event of suppressedEvents) {
			await widgetBotPrototype.handleAgentEvent.call(context, widgetConversation, event);
		}
		expect(previewTextBlocks.get(0)).toBe("Existing preview");
		expect(context.startTypingIndicator).not.toHaveBeenCalled();
		expect(context.updateStatus).not.toHaveBeenCalled();
		expect(context.updateAssistantPreview).not.toHaveBeenCalled();
		expect(context.finishAssistantMessage).not.toHaveBeenCalled();

		const toolEvent: RpcAgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tool-call",
			toolName: "answer_telegram_widget_query",
			result: { content: [], details: { queryId: "widget-query" } },
			isError: false,
		};
		await widgetBotPrototype.handleAgentEvent.call(context, widgetConversation, toolEvent);
		expect(context.handleWidgetToolResult).toHaveBeenCalledWith(widgetConversation, toolEvent);

		await widgetBotPrototype.handleAgentEvent.call(context, widgetConversation, {
			type: "agent_end",
			messages: [],
			willRetry: false,
		});
		expect(context.widgetOnlyConversations.size).toBe(0);
		expect(context.stopTypingIndicator).toHaveBeenCalledExactlyOnceWith(widgetConversation.key);
		expect(context.clearStatus).toHaveBeenCalledExactlyOnceWith(widgetConversation);

		await widgetBotPrototype.handleAgentEvent.call(context, widgetConversation, { type: "agent_start" });
		await widgetBotPrototype.handleAgentEvent.call(context, widgetConversation, { type: "message_end", message });
		expect(context.startTypingIndicator).toHaveBeenCalledWith(widgetConversation);
		expect(context.updateStatus).toHaveBeenCalledWith(widgetConversation, "Working…");
		expect(context.finishAssistantMessage).toHaveBeenCalledWith(widgetConversation, message);
	});
});
