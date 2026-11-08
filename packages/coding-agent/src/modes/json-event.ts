import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DocumentContent, ImageContent, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

/** Document metadata sent in RPC events when the attachment bytes are omitted. */
export type RpcDocumentAttachment = Omit<DocumentContent, "data"> & { dataOmitted: true };

type RpcUserMessage = Omit<UserMessage, "content"> & {
	content: string | (TextContent | ImageContent | RpcDocumentAttachment)[];
};
type RpcAgentMessage = Exclude<AgentMessage, { role: "user" }> | RpcUserMessage;

type RpcEvent<T> = T extends { type: "agent_end"; messages: AgentMessage[] }
	? Omit<T, "messages"> & { messages: RpcAgentMessage[] }
	: T extends { message: AgentMessage }
		? Omit<T, "message"> & { message: RpcAgentMessage }
		: T;

/** RPC event shape; document attachment bytes are excluded from notifications. */
export type RpcAgentSessionEvent = RpcEvent<JsonAgentSessionEvent>;

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (!("partial" in event)) {
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage,
 * tool-call ids, and tool names remain available because their size is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}

function omitDocumentData(message: AgentMessage): RpcAgentMessage {
	if (message.role === "user") {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => {
						if (block.type !== "document") return block;
						return {
							type: "document" as const,
							mimeType: block.mimeType,
							...(block.filename ? { filename: block.filename } : {}),
							dataOmitted: true as const,
						};
					});
		return {
			...message,
			content,
		};
	}
	return message;
}

/** Convert an event for RPC without copying document bytes into stdout notifications. */
export function toRpcEvent(event: AgentSessionEvent): RpcAgentSessionEvent {
	const jsonEvent = toJsonEvent(event);
	switch (jsonEvent.type) {
		case "agent_end":
			return { ...jsonEvent, messages: jsonEvent.messages.map(omitDocumentData) };
		case "message_start":
		case "message_end":
		case "turn_end":
			return { ...jsonEvent, message: omitDocumentData(jsonEvent.message) };
		default:
			return jsonEvent;
	}
}
