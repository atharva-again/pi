import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AnswerInlineWidgetQueryOptions } from "./telegram-api.ts";

export type TelegramQueryAnswer =
	| { kind: "widget"; queryId: string; data?: string }
	| { kind: "inline"; options: AnswerInlineWidgetQueryOptions };

export type TelegramQueryAnswerOutcome = "answered" | "inactive";
export type TelegramQueryAnswerHandler = (answer: TelegramQueryAnswer) => Promise<TelegramQueryAnswerOutcome>;

interface QueryAnswerRequest {
	type: "telegram_query_answer";
	id: string;
	answer: TelegramQueryAnswer;
}

type QueryAnswerResponse =
	| { type: "telegram_query_answer_response"; id: string; success: true; outcome: TelegramQueryAnswerOutcome }
	| { type: "telegram_query_answer_response"; id: string; success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryAnswerRequest(value: unknown): value is QueryAnswerRequest {
	if (!isRecord(value) || value.type !== "telegram_query_answer" || typeof value.id !== "string") return false;
	const answer = value.answer;
	if (!isRecord(answer)) return false;
	if (answer.kind === "widget") {
		return typeof answer.queryId === "string" && (answer.data === undefined || typeof answer.data === "string");
	}
	// This channel connects our own extension to its parent, not external callers.
	// The API validates the inline content before the coordinator consumes the query.
	return (
		answer.kind === "inline" &&
		isRecord(answer.options) &&
		typeof answer.options.inlineQueryId === "string" &&
		typeof answer.options.resultId === "string" &&
		typeof answer.options.title === "string" &&
		isRecord(answer.options.content)
	);
}

function isQueryAnswerResponse(value: unknown): value is QueryAnswerResponse {
	return (
		isRecord(value) &&
		value.type === "telegram_query_answer_response" &&
		typeof value.id === "string" &&
		((value.success === true && (value.outcome === "answered" || value.outcome === "inactive")) ||
			(value.success === false && typeof value.error === "string"))
	);
}

export function handleTelegramQueryAnswer(
	child: ChildProcess,
	message: unknown,
	handler: TelegramQueryAnswerHandler | undefined,
): void {
	if (!isQueryAnswerRequest(message)) return;
	const respond = (response: QueryAnswerResponse): void => {
		if (child.connected) child.send(response, () => {});
	};
	void (async () => {
		try {
			if (!handler) throw new Error("Telegram query answers are unavailable.");
			const outcome = await handler(message.answer);
			respond({ type: "telegram_query_answer_response", id: message.id, success: true, outcome });
		} catch (error) {
			respond({
				type: "telegram_query_answer_response",
				id: message.id,
				success: false,
				error: error instanceof Error ? error.message : "Unable to answer Telegram query.",
			});
		}
	})();
}

export function requestTelegramQueryAnswer(
	answer: TelegramQueryAnswer,
	signal: AbortSignal | undefined,
): Promise<TelegramQueryAnswerOutcome> {
	if (!process.send || !process.connected) {
		return Promise.reject(new Error("Telegram query answers require the pi-tg parent process."));
	}
	if (signal?.aborted) return Promise.reject(new Error("Telegram query answer was aborted."));
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const cleanup = (): void => {
			clearTimeout(timeout);
			process.off("message", onMessage);
			process.off("disconnect", onDisconnect);
			signal?.removeEventListener("abort", onAbort);
		};
		const onMessage = (message: unknown): void => {
			if (!isQueryAnswerResponse(message) || message.id !== id) return;
			cleanup();
			if (message.success) resolve(message.outcome);
			else reject(new Error(message.error));
		};
		const onDisconnect = (): void => {
			cleanup();
			reject(new Error("The pi-tg parent process disconnected."));
		};
		const onAbort = (): void => {
			cleanup();
			reject(new Error("Telegram query answer was aborted."));
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for pi-tg to answer the query. Do not retry the query answer."));
		}, 15_000);
		timeout.unref();
		process.on("message", onMessage);
		process.once("disconnect", onDisconnect);
		signal?.addEventListener("abort", onAbort, { once: true });
		process.send?.({ type: "telegram_query_answer", id, answer } satisfies QueryAnswerRequest, (error) => {
			if (!error) return;
			cleanup();
			reject(error);
		});
	});
}
