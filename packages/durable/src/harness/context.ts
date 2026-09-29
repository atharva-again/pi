import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEdit, ConversationId, Cursor, EntryId, EntryRecord, Storage } from "../types.ts";
import type { ContextView } from "./types.ts";

const SCAN_PAGE_SIZE = 256;
const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

/** Head marker and newest visible entry that fix one committed context range. */
export type ContextBounds = {
	readonly head: (EntryRecord & { readonly head: EntryId }) | undefined;
	readonly tail: EntryId;
};

/**
 * Capture the bounds of the current context with two O(1) reads. Run this on the Session line; entries at or below
 * the tail are immutable, so `deriveContext()` can then scan them off the line.
 */
export async function captureContextBounds(
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
): Promise<ContextBounds | undefined> {
	const tail = (await storage.scanEntries({ conversationId }, 1, undefined, context)).items[0];
	if (tail === undefined) return undefined;
	return { head: await storage.findLatestHeadMarker(conversationId, tail.id, context), tail: tail.id };
}

/**
 * Derive the active transcript and model context of one conversation within captured bounds.
 *
 * H = newest visible head marker; the range runs from `H.head` (or transcript start) through the tail. Per target,
 * the newest edit in the range wins. Context entries are H followed by the range's non-head entries.
 */
export async function deriveContext(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<ContextView> {
	if (bounds === undefined) return { head: undefined, entries: [], messages: [] };
	const head = bounds.head;
	const range: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(
			head === undefined
				? { conversationId, maxEntryId: bounds.tail }
				: { conversationId, minEntryId: head.head, maxEntryId: bounds.tail },
			SCAN_PAGE_SIZE,
			cursor,
			context,
		);
		range.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	range.reverse();

	const edits = new Map<EntryId, ContextEdit>();
	for (const entry of range) for (const edit of entry.edits ?? []) edits.set(edit.target, edit);

	const entries = head === undefined ? range : [head, ...range.filter((entry) => entry.head === undefined)];
	const messages: Message[] = [];
	for (const entry of entries) {
		const edit = edits.get(entry.id);
		if (edit?.action === "omit") continue;
		const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
		for (const message of contributed) {
			if (message.role === "assistant" && EXCLUDED_STOP_REASONS.has(message.stopReason)) continue;
			messages.push(message);
		}
	}
	return { head, entries, messages: orderToolResults(messages) };
}

/**
 * Place each assistant's tool results directly after it in call order. Results are taken from the messages before
 * the next assistant; a missing result is synthesized and unmatched results are dropped.
 */
function orderToolResults(messages: readonly Message[]): Message[] {
	const ordered: Message[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "toolResult") continue;
		ordered.push(message);
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (calls.length === 0) continue;
		const results = new Map<string, number>();
		for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
			const candidate = messages[next]!;
			if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
				results.set(candidate.toolCallId, next);
			}
		}
		for (const call of calls) {
			const resultIndex = results.get(call.id);
			ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]!);
		}
	}
	return ordered;
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true,
		details: { reason: "missing_result" },
		timestamp,
	};
}
