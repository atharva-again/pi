import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";

/** Durable per-conversation model, thinking level, and desired tool loadout. */
export type ConversationConfigState = {
	model?: { provider: string; modelId: string };
	thinkingLevel: ModelThinkingLevel;
	/** Desired tool names in offered order; names may be unregistered in the current process. */
	activeTools: string[];
};

/** Built-in configuration document; rewindable so forks start from the configuration at their fork entry. */
export const ConversationConfig = defineDoc<ConversationConfigState>({
	kind: "pi.conversation.config",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ thinkingLevel: "off", activeTools: [] }),
	checkpointWhen: () => true,
});
