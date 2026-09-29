import type {
	AssistantMessage,
	Message,
	StopReason,
	SystemMessage,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	Harness,
	type Registry,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { context } from "./session-support.ts";

export function tool(name: string, description = `${name} tool`): ToolRegistration {
	return { name, description, parameters: Type.Object({}), execute: async () => ({ content: [] }) };
}

/** Open a Harness with a fresh registry holding the named tools. */
export async function openHarness(
	storage: Storage,
	toolNames: readonly string[] = [],
	options: { readonly registry?: Registry; readonly onReport?: (error: unknown) => void } = {},
): Promise<{ readonly harness: Harness; readonly registry: Registry }> {
	const registry = options.registry ?? createRegistry();
	for (const name of toolNames) registry.tools.add(tool(name));
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry, ...(options.onReport === undefined ? {} : { onReport: options.onReport }) },
		context,
	);
	return { harness, registry };
}

export function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

export function assistant(
	text: string,
	options: { readonly calls?: readonly string[]; readonly stopReason?: StopReason } = {},
): AssistantMessage {
	const calls: ToolCall[] = (options.calls ?? []).map((id) => ({
		type: "toolCall",
		id,
		name: `tool-${id}`,
		arguments: {},
	}));
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...calls],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		timestamp: 2,
	};
}

export function toolResult(id: string, text = `result ${id}`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: `tool-${id}`,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

export function system(sections: Record<string, string | null>): SystemMessage {
	return { role: "system", content: "", sections, timestamp: 4 };
}

/** Compact message rendering for assertions. */
export function describeMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `user:${message.content as string}`;
		case "assistant": {
			const text = message.content.find((content) => content.type === "text");
			return `assistant:${text?.type === "text" ? text.text : ""}`;
		}
		case "toolResult": {
			const text = message.content.find((content) => content.type === "text");
			return `result:${message.toolCallId}:${message.isError ? "error" : text?.type === "text" ? text.text : ""}`;
		}
		case "system":
			return `system:${Object.keys(message.sections ?? {}).join(",")}`;
	}
}
