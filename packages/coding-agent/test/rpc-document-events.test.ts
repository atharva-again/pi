import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { toRpcEvent } from "../src/modes/json-event.ts";

describe("RPC document event payloads", () => {
	it("omits document bytes from message and agent-end notifications without mutating session messages", () => {
		const documentData = "JVBERi0xLjQ=";
		const userMessage = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: "Review this PDF." },
				{
					type: "document" as const,
					data: documentData,
					mimeType: "application/pdf",
					filename: "report.pdf",
				},
			],
			timestamp: 1,
		};
		const events: AgentSessionEvent[] = [
			{ type: "message_start", message: userMessage },
			{ type: "agent_end", messages: [userMessage], willRetry: false },
		];

		for (const event of events) {
			const rpcEvent = toRpcEvent(event);
			expect(JSON.stringify(rpcEvent)).not.toContain(documentData);
			expect(JSON.stringify(rpcEvent)).toContain('"dataOmitted":true');
		}

		expect(userMessage.content[1]).toEqual({
			type: "document",
			data: documentData,
			mimeType: "application/pdf",
			filename: "report.pdf",
		});
	});
});
