import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Model } from "../src/types.ts";
import { supportsPdfInput } from "../src/utils/document-support.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

describe("OpenAI Responses document input", () => {
	it("checks PDF support independently from image input", () => {
		expect(supportsPdfInput(model)).toBe(true);
		expect(supportsPdfInput({ ...model, provider: "openai" })).toBe(false);
	});

	it("sends document bytes as an input_file data URL with the filename", () => {
		const input = convertResponsesMessages(
			model,
			normalizeContext({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Review this PDF." },
							{
								type: "document",
								data: "JVBERi0xLjQ=",
								mimeType: "application/pdf",
								filename: "report.pdf",
							},
						],
						timestamp: 1,
					},
				],
			}),
			new Set(["openai-codex"]),
		);

		expect(input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Review this PDF." },
					{
						type: "input_file",
						file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
						filename: "report.pdf",
					},
				],
			},
		]);
	});

	it("replaces historical PDFs for an unsupported model without changing the saved conversation", () => {
		const unsupportedModel: Model<"openai-responses"> = {
			...model,
			api: "openai-responses",
			provider: "openai",
		};
		const pdf = {
			type: "document" as const,
			data: "JVBERi0xLjQ=",
			mimeType: "application/pdf",
			filename: "report.pdf",
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Review this PDF." }, pdf], timestamp: 1 },
				{ role: "user", content: "Now answer a text question.", timestamp: 2 },
			],
		});
		const switched = convertResponsesMessages(unsupportedModel, context, new Set(["openai-codex"]));

		expect(switched).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Review this PDF." },
					{ type: "input_text", text: "(PDF omitted: model does not support PDFs): report.pdf" },
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "Now answer a text question." }] },
		]);
		expect(context.messages[0]).toMatchObject({ content: [{ type: "text" }, pdf] });
		expect(convertResponsesMessages(model, context, new Set(["openai-codex"]))[0]).toMatchObject({
			content: [
				{ type: "input_text" },
				{ type: "input_file", file_data: `data:application/pdf;base64,${pdf.data}` },
			],
		});
	});
});
