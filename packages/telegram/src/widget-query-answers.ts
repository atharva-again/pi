import { createInlineWidgetResult, type TelegramApi, validateWidgetData } from "./telegram-api.ts";
import type { TelegramQueryAnswer, TelegramQueryAnswerOutcome } from "./widget-query-channel.ts";

interface PendingQuery {
	conversationKey: string;
	timer: NodeJS.Timeout;
}

export class TelegramQueryAnswers {
	private readonly api: Pick<TelegramApi, "answerWidgetQuery" | "answerInlineQuery">;
	private readonly pending = new Map<string, PendingQuery>();

	constructor(api: Pick<TelegramApi, "answerWidgetQuery" | "answerInlineQuery">) {
		this.api = api;
	}

	beginWidget(conversationKey: string, queryId: string): void {
		this.begin("widget", conversationKey, queryId, 10_000, () =>
			this.api.answerWidgetQuery({ widgetQueryId: queryId, data: JSON.stringify({ status: "processing" }) }),
		);
	}

	beginInline(conversationKey: string, queryId: string): void {
		this.begin("inline", conversationKey, queryId, 8_000, () =>
			this.api.answerInlineQuery({ inlineQueryId: queryId, results: [] }),
		);
	}

	private begin(
		kind: TelegramQueryAnswer["kind"],
		conversationKey: string,
		queryId: string,
		delay: number,
		fallback: () => Promise<boolean>,
	): void {
		const key = `${kind}:${queryId}`;
		if (this.pending.has(key)) return;
		const timer = setTimeout(() => {
			void this.complete(kind, conversationKey, queryId, fallback).catch(() => {});
		}, delay);
		timer.unref();
		this.pending.set(key, { conversationKey, timer });
	}

	async answer(conversationKey: string, answer: TelegramQueryAnswer): Promise<TelegramQueryAnswerOutcome> {
		if (answer.kind === "widget") {
			validateWidgetData(answer.data, "query answer data");
			return this.complete("widget", conversationKey, answer.queryId, () =>
				this.api.answerWidgetQuery({ widgetQueryId: answer.queryId, data: answer.data }),
			);
		}
		const result = createInlineWidgetResult(answer.options);
		return this.complete("inline", conversationKey, answer.options.inlineQueryId, () =>
			this.api.answerInlineQuery({ inlineQueryId: answer.options.inlineQueryId, results: [result] }),
		);
	}

	async failInline(conversationKey: string, queryId: string): Promise<TelegramQueryAnswerOutcome> {
		return this.complete("inline", conversationKey, queryId, () =>
			this.api.answerInlineQuery({ inlineQueryId: queryId, results: [] }),
		);
	}

	private async complete(
		kind: TelegramQueryAnswer["kind"],
		conversationKey: string,
		queryId: string,
		send: () => Promise<boolean>,
	): Promise<TelegramQueryAnswerOutcome> {
		const key = `${kind}:${queryId}`;
		const pending = this.pending.get(key);
		if (!pending || pending.conversationKey !== conversationKey) return "inactive";
		// Claim before starting I/O. Neither the timeout nor a concurrent tool call
		// may send another answer, even if the first request's outcome is unknown.
		clearTimeout(pending.timer);
		this.pending.delete(key);
		await send();
		return "answered";
	}

	dispose(): void {
		for (const { timer } of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
	}
}
