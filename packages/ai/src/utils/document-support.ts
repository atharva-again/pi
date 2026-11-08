import type { Api, Model } from "../types.ts";

/** Native PDF input is supported by the ChatGPT-authenticated OpenAI Codex Responses route. */
export function supportsPdfInput<TApi extends Api>(model: Model<TApi>): boolean {
	return model.api === "openai-codex-responses" && model.provider === "openai-codex";
}
