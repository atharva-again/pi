import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TelegramBindingStore } from "../src/store.ts";

it("retains widget conversation mappings beyond 500 entries and across restarts", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tg-widget-bindings-"));
	try {
		const path = join(directory, "bindings.json");
		const store = new TelegramBindingStore(path);
		const oldest = { chatId: "12345", messageId: 1, threadId: "456", chatType: "private" };
		store.setWidgetBinding(oldest);
		for (let messageId = 2; messageId <= 501; messageId++) {
			store.setWidgetBinding({ ...oldest, messageId, threadId: "789" });
		}

		expect(store.getWidgetBinding("12345", 1)).toEqual(oldest);
		const restartedStore = new TelegramBindingStore(path);
		for (let messageId = 1; messageId <= 501; messageId++) {
			expect(restartedStore.getWidgetBinding("12345", messageId)).toEqual({
				...oldest,
				messageId,
				threadId: messageId === 1 ? "456" : "789",
			});
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
