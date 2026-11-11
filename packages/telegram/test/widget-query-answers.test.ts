import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRpcProcessInstance, type RpcProcessInstance } from "../src/rpc-process.ts";
import type { AnswerInlineWidgetQueryOptions, TelegramApi } from "../src/telegram-api.ts";
import telegramWidgetExtension from "../src/telegram-widget-extension.ts";
import { TelegramQueryAnswers } from "../src/widget-query-answers.ts";
import * as queryChannel from "../src/widget-query-channel.ts";

const coordinators: TelegramQueryAnswers[] = [];

function createQueries() {
	const api = {
		answerWidgetQuery: vi.fn(async (_options: Parameters<TelegramApi["answerWidgetQuery"]>[0]) => true),
		answerInlineQuery: vi.fn(async (_options: Parameters<TelegramApi["answerInlineQuery"]>[0]) => true),
	};
	const queries = new TelegramQueryAnswers(api);
	coordinators.push(queries);
	return { api, queries };
}

function inlineOptions(shared: boolean): AnswerInlineWidgetQueryOptions {
	return {
		inlineQueryId: "inline-query",
		resultId: "result",
		title: "Dashboard",
		content: shared ? { widget_id: "shared-widget" } : { html: "<p>Ready</p>" },
	};
}

function sendWithTimeout(rpc: RpcProcessInstance, command: RpcCommand): Promise<RpcResponse> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${command.type}`)), 20_000);
		void rpc.send(command).then(
			(response) => {
				clearTimeout(timer);
				resolve(response);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

afterEach(() => {
	for (const queries of coordinators.splice(0)) queries.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Telegram query answer ownership", () => {
	it("cancels the widget fallback before waiting for the answer to finish", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		const response = Promise.withResolvers<boolean>();
		api.answerWidgetQuery.mockReturnValue(response.promise);
		queries.beginWidget("chat", "query");

		const answer = queries.answer("chat", { kind: "widget", queryId: "query", data: "ready" });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.answerWidgetQuery).toHaveBeenCalledExactlyOnceWith({ widgetQueryId: "query", data: "ready" });
		expect(await queries.answer("chat", { kind: "widget", queryId: "query" })).toBe("inactive");

		response.resolve(true);
		expect(await answer).toBe("answered");
	});

	it("does not answer again when the widget fallback wins", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "query");

		await vi.advanceTimersByTimeAsync(9_999);
		expect(api.answerWidgetQuery).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await queries.answer("chat", { kind: "widget", queryId: "query", data: "ready" })).toBe("inactive");
		expect(await queries.answer("chat", { kind: "widget", queryId: "query", data: '{"error":"late"}' })).toBe(
			"inactive",
		);
		expect(api.answerWidgetQuery).toHaveBeenCalledExactlyOnceWith({
			widgetQueryId: "query",
			data: '{"status":"processing"}',
		});
	});

	it("keeps the query available when answer validation fails", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "query");

		await expect(
			queries.answer("chat", { kind: "widget", queryId: "query", data: "🙂".repeat(257) }),
		).rejects.toThrow("1024 UTF-8 bytes");
		expect(api.answerWidgetQuery).not.toHaveBeenCalled();
		expect(await queries.answer("chat", { kind: "widget", queryId: "query", data: "ready" })).toBe("answered");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.answerWidgetQuery).toHaveBeenCalledTimes(1);
	});

	it("does not retry an answer whose delivery outcome is unknown", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		api.answerWidgetQuery.mockRejectedValue(new Error("Connection lost after sending"));
		queries.beginWidget("chat", "query");

		await expect(queries.answer("chat", { kind: "widget", queryId: "query" })).rejects.toThrow("Connection lost");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await queries.answer("chat", { kind: "widget", queryId: "query" })).toBe("inactive");
		expect(api.answerWidgetQuery).toHaveBeenCalledTimes(1);
	});

	it("does not let another conversation consume a query", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "query");
		expect(await queries.answer("different-chat", { kind: "widget", queryId: "query" })).toBe("inactive");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.answerWidgetQuery).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("cancels the inline fallback for a timely result (shared=%s)", async (shared) => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		const options = inlineOptions(shared);
		queries.beginInline("chat", options.inlineQueryId);

		expect(await queries.answer("chat", { kind: "inline", options })).toBe("answered");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.answerInlineQuery).toHaveBeenCalledExactlyOnceWith({
			inlineQueryId: "inline-query",
			results: [
				{
					type: "article",
					id: "result",
					title: "Dashboard",
					description: undefined,
					input_message_content: options.content,
				},
			],
		});
	});

	it.each([false, true])("suppresses late inline results and failures (shared=%s)", async (shared) => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginInline("chat", "inline-query");
		await vi.advanceTimersByTimeAsync(8_000);

		expect(await queries.answer("chat", { kind: "inline", options: inlineOptions(shared) })).toBe("inactive");
		expect(await queries.failInline("chat", "inline-query")).toBe("inactive");
		expect(api.answerInlineQuery).toHaveBeenCalledExactlyOnceWith({ inlineQueryId: "inline-query", results: [] });
	});

	it("validates inline HTML before consuming its query", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginInline("chat", "inline-query");
		await expect(
			queries.answer("chat", {
				kind: "inline",
				options: { ...inlineOptions(false), content: { html: "" } },
			}),
		).rejects.toThrow("32768 UTF-8 bytes");
		expect(api.answerInlineQuery).not.toHaveBeenCalled();
		expect(await queries.answer("chat", { kind: "inline", options: inlineOptions(false) })).toBe("answered");
		await vi.advanceTimersByTimeAsync(8_000);
		expect(api.answerInlineQuery).toHaveBeenCalledTimes(1);
	});

	it("keeps widget and inline query IDs separate", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "same-id");
		queries.beginInline("chat", "same-id");
		await queries.answer("chat", { kind: "widget", queryId: "same-id" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.answerWidgetQuery).toHaveBeenCalledTimes(1);
		expect(api.answerInlineQuery).toHaveBeenCalledExactlyOnceWith({ inlineQueryId: "same-id", results: [] });
	});

	it("cancels all pending fallbacks on shutdown", async () => {
		vi.useFakeTimers();
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "widget-query");
		queries.beginInline("chat", "inline-query");
		queries.dispose();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(api.answerWidgetQuery).not.toHaveBeenCalled();
		expect(api.answerInlineQuery).not.toHaveBeenCalled();
		expect(await queries.answer("chat", { kind: "widget", queryId: "widget-query" })).toBe("inactive");
	});
});

describe("Telegram query answer tool feedback", () => {
	it.each([
		{
			name: "answer_telegram_widget_query",
			params: { queryId: "query", data: "ready" },
			guidance: "update_telegram_widget_data",
		},
		{
			name: "answer_telegram_inline_widget",
			params: { inlineQueryId: "query", title: "Dashboard", html: "<p>Ready</p>" },
			guidance: "Do not retry",
		},
		{
			name: "answer_telegram_inline_shared_widget",
			params: { inlineQueryId: "query", title: "Dashboard", widgetId: "shared-widget" },
			guidance: "Do not retry",
		},
	])("explains an inactive query without calling Telegram ($name)", async ({ name, params, guidance }) => {
		vi.stubEnv("PI_TELEGRAM_WIDGET_BOT_TOKEN", "test-token");
		vi.stubEnv("PI_TELEGRAM_WIDGET_CHAT_ID", "12345");
		vi.stubEnv("PI_TELEGRAM_WIDGET_CHAT_TYPE", "private");
		const request = vi.spyOn(queryChannel, "requestTelegramQueryAnswer").mockResolvedValue("inactive");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
		telegramWidgetExtension({ registerTool: registerTool as ExtensionAPI["registerTool"] });
		const tool = registerTool.mock.calls.map(([registered]) => registered).find((tool) => tool.name === name);
		if (!tool) throw new Error(`Tool ${name} was not registered`);

		const result = await tool.execute("call", params, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);

		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringContaining(guidance),
		});
		expect(result.details).toMatchObject({ outcome: "inactive" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Telegram query answer process channel", () => {
	it("routes child answers through the parent without starting a model run", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tg-query-ipc-"));
		const workspace = join(directory, "workspace");
		mkdirSync(workspace);
		const { api, queries } = createQueries();
		queries.beginWidget("chat", "widget-query");
		queries.beginInline("chat", "inline-query");
		const rpc = createRpcProcessInstance({
			cwd: workspace,
			env: { PI_CODING_AGENT_DIR: join(directory, "agent") },
			args: [
				"--no-session",
				"--extension",
				fileURLToPath(new URL("./fixtures/widget-query-probe.ts", import.meta.url)),
			],
			onQueryAnswer: (answer) => queries.answer("chat", answer),
		});
		const onEvent = vi.fn();
		rpc.onEvent(onEvent);
		try {
			for (const args of ["widget", "widget", "inline", "inline"]) {
				const response = await sendWithTimeout(rpc, { type: "prompt", message: `/widget_answer_probe ${args}` });
				expect(response).toMatchObject({ command: "prompt", success: true });
			}
			await vi.waitFor(
				async () => {
					const response = await sendWithTimeout(rpc, { type: "get_entries" });
					if (!response.success || response.command !== "get_entries") {
						throw new Error("Could not read query probe entries");
					}
					const outcomes = response.data.entries
						.filter((entry) => entry.type === "custom" && entry.customType === "widget_answer_probe")
						.map((entry) => (entry.type === "custom" ? entry.data : undefined));
					expect(outcomes).toEqual([
						{ outcome: "answered" },
						{ outcome: "inactive" },
						{ outcome: "answered" },
						{ outcome: "inactive" },
					]);
				},
				{ timeout: 10_000 },
			);
			expect(api.answerWidgetQuery).toHaveBeenCalledExactlyOnceWith({
				widgetQueryId: "widget-query",
				data: "ready",
			});
			expect(api.answerInlineQuery).toHaveBeenCalledTimes(1);
			expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent_start" }));
		} finally {
			await rpc.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
