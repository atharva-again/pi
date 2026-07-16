import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatThinkingLevelConfirmation, supportedThinkingLevels } from "../src/bot.ts";

function reasoningModel(
	thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"],
): Model<"openai-completions"> {
	return {
		id: "test-reasoning-model",
		name: "Test Reasoning Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

describe("Telegram thinking levels", () => {
	it("only exposes opt-in extended levels supported by the model", () => {
		expect(supportedThinkingLevels(reasoningModel())).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supportedThinkingLevels(reasoningModel({ xhigh: null, max: "max" }))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"max",
		]);
	});

	it("reports the effective level without guessing when state is unavailable", () => {
		expect(formatThinkingLevelConfirmation({ thinkingLevel: "high" })).toBe("Thinking level set to high");
		expect(formatThinkingLevelConfirmation(undefined)).toBe(
			"Thinking level updated, but current state is unavailable.",
		);
	});
});
