import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_MESSAGE_LIMIT = 3900;

interface TextPart {
	type: "text";
	text: string;
}

function isTextPart(value: unknown): value is TextPart {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

export function truncateTelegramText(text: string, limit = SAFE_MESSAGE_LIMIT): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(0, limit - 20))}\n… truncated`;
}

export function truncateTelegramButtonText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function splitTelegramText(text: string): string[] {
	if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
		return [text];
	}
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= SAFE_MESSAGE_LIMIT) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n", SAFE_MESSAGE_LIMIT);
		if (splitAt < SAFE_MESSAGE_LIMIT / 2) {
			splitAt = SAFE_MESSAGE_LIMIT;
		}
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}

export function extractMessageText(
	message: Extract<AgentSessionEvent, { type: "message_end" | "message_update" | "message_start" }>["message"],
): string {
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter(isTextPart)
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
