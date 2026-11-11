import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelegramApi } from "./telegram-api.ts";
import { requestTelegramQueryAnswer } from "./widget-query-channel.ts";

export function createTelegramWidgetTool(api: Pick<TelegramApi, "sendWidget">, chatId: string, threadId?: string) {
	return defineTool({
		name: "send_telegram_widget",
		label: "Send Telegram widget",
		description:
			"Send the user a custom interactive HTML widget in Telegram. Use for a bespoke webpage, dashboard, or visualization they want built and sent in chat; do not require them to say 'widget'.",
		promptSnippet: "Send a custom interactive HTML widget to the current Telegram chat",
		promptGuidelines: [
			"Use send_telegram_widget when the user asks for a custom webpage, interactive view, or dashboard in Telegram.",
			"Follow Telegram widget profile 1: self-contained HTML, inline CSS/JS, designed for a 320px bubble and under 560px tall. Use theme CSS variables, buttons instead of form controls, and no internal scrolling.",
			"Keep HTML under 32768 UTF-8 bytes and aim below 3800 bytes compressed. Telegram silently removes unsupported HTML, CSS, and JavaScript; supported HTML/CSS/JS is much narrower than a browser.",
			"Use inline SVG or data-URI images only. No external assets, scripts, fonts, or network requests. Use standard system fonts. Make the first render synchronous from initial widget state.",
			"Prefer client-side interactions using embedded data. For an interaction that needs Pi, set allowQueries=true and call TelegramWidget.request() synchronously from a direct tap handler with 1–64 UTF-8 bytes. Handle pending/error states; only one request may be active, with a limit of 5 per user per 5 seconds. Answer each query within 15 seconds and update widget data separately when needed.",
			"Read TelegramWidget.chatData and publicData for initial state; the bot alone changes them. Listen for chatDataChanged/publicDataChanged and redraw. Shared widgets needing live public-state updates should call TelegramWidget.watchPublicData().",
			"Widget code cannot be changed after sending; a redesign requires sending a new widget. TelegramWidget.sendMessage, form controls, keyboard input, vertical dragging, and network access are not supported.",
		],
		parameters: Type.Object({
			html: Type.String({
				description:
					"Complete self-contained HTML document with inline CSS and JavaScript. Telegram limits it to 32768 UTF-8 bytes and 4096 bytes compressed.",
				minLength: 1,
				maxLength: 32768,
			}),
			caption: Type.Optional(
				Type.String({
					description: "Short caption displayed with the widget.",
					maxLength: 1024,
				}),
			),
			width: Type.Optional(
				Type.Union([Type.Literal(0), Type.Integer({ minimum: 200 })], {
					description: "Optional widget width in logical pixels; 0 or omission uses the full message width.",
				}),
			),
			height: Type.Optional(
				Type.Union([Type.Literal(0), Type.Integer({ minimum: 50, maximum: 600 })], {
					description: "Optional widget height in logical pixels; 0 or omission uses automatic height.",
				}),
			),
			publicData: Type.Optional(
				Type.String({
					description:
						"Optional shared widget state, visible wherever this widget is shown, up to 1024 UTF-8 bytes.",
					maxLength: 1024,
				}),
			),
			chatData: Type.Optional(
				Type.String({
					description: "Optional state private to this widget message, up to 1024 UTF-8 bytes.",
					maxLength: 1024,
				}),
			),
			allowQueries: Type.Optional(
				Type.Boolean({
					description: "Allow this widget to send user interactions to the bot with TelegramWidget.request().",
				}),
			),
			isShared: Type.Optional(
				Type.Boolean({
					description: "Create a shared widget that can be sent again and has shared public state.",
				}),
			),
			showCaptionAboveMedia: Type.Optional(
				Type.Boolean({
					description: "Display the caption above the widget.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const message = await api.sendWidget({
				chatId,
				threadId,
				html: params.html,
				caption: params.caption,
				width: params.width,
				height: params.height,
				publicData: params.publicData,
				chatData: params.chatData,
				allowQueries: params.allowQueries,
				isShared: params.isShared,
				showCaptionAboveMedia: params.showCaptionAboveMedia,
			});
			const sharedId =
				params.isShared === true && message.widget?.id ? ` Shared widget ID: ${message.widget.id}.` : "";
			return {
				content: [
					{ type: "text", text: `Sent interactive widget as Telegram message ${message.message_id}.${sharedId}` },
				],
				details: {
					messageId: message.message_id,
					widgetId: message.widget?.id,
					isShared: params.isShared === true,
				},
			};
		},
	});
}

function createSharedWidgetTool(api: Pick<TelegramApi, "sendSharedWidget">, chatId: string, threadId?: string) {
	return defineTool({
		name: "send_shared_telegram_widget",
		label: "Send shared Telegram widget",
		description: "Send an existing shared Telegram widget to the current chat using its widget ID.",
		promptSnippet: "Send an existing shared Telegram widget to the current chat",
		parameters: Type.Object({
			widgetId: Type.String({ description: "ID returned when the shared widget was created." }),
			chatData: Type.Optional(Type.String({ maxLength: 1024 })),
			caption: Type.Optional(Type.String({ maxLength: 1024 })),
			showCaptionAboveMedia: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const message = await api.sendSharedWidget({
				chatId,
				threadId,
				widgetId: params.widgetId,
				chatData: params.chatData,
				caption: params.caption,
				showCaptionAboveMedia: params.showCaptionAboveMedia,
			});
			return {
				content: [
					{
						type: "text",
						text: `Sent shared widget ${params.widgetId} as Telegram message ${message.message_id}.`,
					},
				],
				details: { messageId: message.message_id, widgetId: params.widgetId },
			};
		},
	});
}

function createWidgetInteractionTools(api: TelegramApi, chatId: string) {
	const answerQueryTool = defineTool({
		name: "answer_telegram_widget_query",
		label: "Answer Telegram widget interaction",
		description:
			"Return a short result to an active Telegram widget request. Use immediately when a widget interaction asks for an answer.",
		promptSnippet: "Answer an active Telegram widget request",
		parameters: Type.Object({
			queryId: Type.String({ description: "The query ID provided in the widget interaction context." }),
			data: Type.Optional(
				Type.String({
					description: "Short string returned to TelegramWidget.request(), at most 1024 UTF-8 bytes.",
					maxLength: 1024,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const outcome = await requestTelegramQueryAnswer(
				{ kind: "widget", queryId: params.queryId, data: params.data },
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text:
							outcome === "answered"
								? "Answered the Telegram widget request."
								: "This query is inactive: pi-tg already answered it or it is no longer available. Do not answer it again. Deliver the finished result with update_telegram_widget_data or update_shared_telegram_widget_data.",
					},
				],
				details: { queryId: params.queryId, outcome },
			};
		},
	});

	const updateWidgetDataTool = defineTool({
		name: "update_telegram_widget_data",
		label: "Update Telegram widget data",
		description:
			"Update the chat or public state of a Telegram widget after handling an interaction. Use its message ID or inline message ID from the interaction context.",
		promptSnippet: "Update data shown by a Telegram widget",
		parameters: Type.Object({
			messageId: Type.Optional(Type.Integer({ description: "Message ID for a widget sent in a chat." })),
			inlineMessageId: Type.Optional(Type.String({ description: "Inline message ID for a widget sent inline." })),
			chatData: Type.Optional(Type.String({ maxLength: 1024 })),
			publicData: Type.Optional(Type.String({ maxLength: 1024 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await api.editMessageWidgetData({
				chatId: params.inlineMessageId === undefined ? chatId : undefined,
				messageId: params.messageId,
				inlineMessageId: params.inlineMessageId,
				chatData: params.chatData,
				publicData: params.publicData,
			});
			return {
				content: [{ type: "text", text: "Updated Telegram widget data." }],
				details: { messageId: params.messageId, inlineMessageId: params.inlineMessageId },
			};
		},
	});

	const updateSharedWidgetDataTool = defineTool({
		name: "update_shared_telegram_widget_data",
		label: "Update shared Telegram widget",
		description: "Update the public state of a shared Telegram widget.",
		promptSnippet: "Update public data shown by a shared Telegram widget",
		parameters: Type.Object({
			widgetId: Type.String({ description: "Shared widget ID from the interaction context." }),
			publicData: Type.String({ maxLength: 1024 }),
			cacheTime: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await api.editSharedWidgetData({
				widgetId: params.widgetId,
				publicData: params.publicData,
				cacheTime: params.cacheTime,
			});
			return {
				content: [{ type: "text", text: "Updated shared Telegram widget data." }],
				details: { widgetId: params.widgetId },
			};
		},
	});

	const answerInlineWidgetTool = defineTool({
		name: "answer_telegram_inline_widget",
		label: "Answer inline Telegram query with widget",
		description:
			"Answer an inline query with a newly generated interactive Telegram widget. Use the inline query ID provided in the interaction context.",
		promptSnippet: "Answer an inline Telegram query with a generated widget",
		parameters: Type.Object({
			inlineQueryId: Type.String({ description: "Inline query ID from the interaction context." }),
			title: Type.String({ description: "Short title shown in inline results.", maxLength: 64 }),
			description: Type.Optional(Type.String({ maxLength: 256 })),
			html: Type.String({ minLength: 1, maxLength: 32768 }),
			width: Type.Optional(Type.Union([Type.Literal(0), Type.Integer({ minimum: 200 })])),
			height: Type.Optional(Type.Union([Type.Literal(0), Type.Integer({ minimum: 50, maximum: 600 })])),
			caption: Type.Optional(Type.String({ maxLength: 1024 })),
			publicData: Type.Optional(Type.String({ maxLength: 1024 })),
			chatData: Type.Optional(Type.String({ maxLength: 1024 })),
			allowQueries: Type.Optional(Type.Boolean()),
			isShared: Type.Optional(Type.Boolean()),
			showCaptionAboveMedia: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const resultId = randomUUID();
			const outcome = await requestTelegramQueryAnswer(
				{
					kind: "inline",
					options: {
						inlineQueryId: params.inlineQueryId,
						resultId,
						title: params.title,
						description: params.description,
						content: {
							html: params.html,
							width: params.width,
							height: params.height,
							caption: params.caption,
							public_data: params.publicData,
							chat_data: params.chatData,
							show_caption_above_media: params.showCaptionAboveMedia,
							allow_queries: params.allowQueries,
							is_shared: params.isShared,
						},
					},
				},
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text:
							outcome === "answered"
								? "Answered the inline query with a Telegram widget."
								: "This inline query is inactive: pi-tg already answered it or it is no longer available. Do not retry it or send its result as a chat message.",
					},
				],
				details: { inlineQueryId: params.inlineQueryId, resultId, outcome },
			};
		},
	});

	const answerInlineSharedWidgetTool = defineTool({
		name: "answer_telegram_inline_shared_widget",
		label: "Answer inline Telegram query with shared widget",
		description: "Answer an inline query with an existing shared Telegram widget.",
		promptSnippet: "Answer an inline Telegram query with an existing shared widget",
		parameters: Type.Object({
			inlineQueryId: Type.String({ description: "Inline query ID from the interaction context." }),
			widgetId: Type.String({ description: "Shared widget ID." }),
			title: Type.String({ description: "Short title shown in inline results.", maxLength: 64 }),
			description: Type.Optional(Type.String({ maxLength: 256 })),
			chatData: Type.Optional(Type.String({ maxLength: 1024 })),
			caption: Type.Optional(Type.String({ maxLength: 1024 })),
			showCaptionAboveMedia: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const resultId = randomUUID();
			const outcome = await requestTelegramQueryAnswer(
				{
					kind: "inline",
					options: {
						inlineQueryId: params.inlineQueryId,
						resultId,
						title: params.title,
						description: params.description,
						content: {
							widget_id: params.widgetId,
							chat_data: params.chatData,
							caption: params.caption,
							show_caption_above_media: params.showCaptionAboveMedia,
						},
					},
				},
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text:
							outcome === "answered"
								? "Answered the inline query with a shared Telegram widget."
								: "This inline query is inactive: pi-tg already answered it or it is no longer available. Do not retry it or send its result as a chat message.",
					},
				],
				details: { inlineQueryId: params.inlineQueryId, resultId, widgetId: params.widgetId, outcome },
			};
		},
	});

	return [
		answerQueryTool,
		updateWidgetDataTool,
		updateSharedWidgetDataTool,
		answerInlineWidgetTool,
		answerInlineSharedWidgetTool,
	];
}

export default function telegramWidgetExtension(pi: Pick<ExtensionAPI, "registerTool">): void {
	const token = process.env.PI_TELEGRAM_WIDGET_BOT_TOKEN;
	const chatId = process.env.PI_TELEGRAM_WIDGET_CHAT_ID;
	if (!process.env.PI_TELEGRAM_WIDGET_CHAT_TYPE || !token || !chatId) {
		return;
	}

	const threadId = process.env.PI_TELEGRAM_WIDGET_THREAD_ID || undefined;
	const api = new TelegramApi(
		token,
		process.env.PI_TELEGRAM_API_BASE_URL || undefined,
		process.env.PI_TELEGRAM_TEST_SERVER === "1",
	);
	pi.registerTool(createTelegramWidgetTool(api, chatId, threadId));
	pi.registerTool(createSharedWidgetTool(api, chatId, threadId));
	for (const tool of createWidgetInteractionTools(api, chatId)) {
		pi.registerTool(tool);
	}
}
