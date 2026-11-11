import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConversationBinding {
	key: string;
	chatId: string;
	threadId?: string;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	updatedAt: string;
}

export interface TelegramWidgetConversationBinding {
	chatId: string;
	messageId: number;
	threadId?: string;
	chatType?: string;
}

interface StoreFile {
	bindings?: ConversationBinding[];
	topicModeChats?: string[];
	widgetBindings?: TelegramWidgetConversationBinding[];
}

export class TelegramBindingStore {
	private readonly path: string;
	private readonly bindings = new Map<string, ConversationBinding>();
	private readonly topicModeChats = new Set<string>();
	private readonly widgetBindings = new Map<string, TelegramWidgetConversationBinding>();

	constructor(path = join(getAgentDir(), "telegram", "bindings.json")) {
		this.path = path;
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) {
			return;
		}
		const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as StoreFile;
		for (const binding of parsed.bindings ?? []) {
			this.bindings.set(binding.key, binding);
		}
		for (const chatId of parsed.topicModeChats ?? []) {
			this.topicModeChats.add(chatId);
		}
		for (const binding of parsed.widgetBindings ?? []) {
			this.widgetBindings.set(this.widgetBindingKey(binding.chatId, binding.messageId), binding);
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const data: StoreFile = {
			bindings: [...this.bindings.values()],
			topicModeChats: [...this.topicModeChats.values()],
			widgetBindings: [...this.widgetBindings.values()],
		};
		writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`);
	}

	private widgetBindingKey(chatId: string, messageId: number): string {
		return `${chatId}:${messageId}`;
	}

	getBinding(key: string): ConversationBinding | undefined {
		const binding = this.bindings.get(key);
		return binding ? { ...binding } : undefined;
	}

	setBinding(binding: ConversationBinding): void {
		this.bindings.set(binding.key, { ...binding, updatedAt: new Date().toISOString() });
		this.save();
	}

	getWidgetBinding(chatId: string, messageId: number): TelegramWidgetConversationBinding | undefined {
		const binding = this.widgetBindings.get(this.widgetBindingKey(chatId, messageId));
		return binding ? { ...binding } : undefined;
	}

	setWidgetBinding(binding: TelegramWidgetConversationBinding): void {
		this.widgetBindings.set(this.widgetBindingKey(binding.chatId, binding.messageId), { ...binding });
		this.save();
	}

	deleteBinding(key: string): void {
		this.bindings.delete(key);
		this.save();
	}

	isTopicModeEnabled(chatId: string): boolean {
		return this.topicModeChats.has(chatId);
	}

	setTopicMode(chatId: string, enabled: boolean): void {
		if (enabled) {
			this.topicModeChats.add(chatId);
		} else {
			this.topicModeChats.delete(chatId);
			for (const [key, binding] of this.bindings) {
				if (binding.chatId === chatId && binding.threadId !== undefined) {
					this.bindings.delete(key);
				}
			}
			for (const [key, binding] of this.widgetBindings) {
				if (binding.chatId === chatId && binding.threadId !== undefined) {
					this.widgetBindings.delete(key);
				}
			}
		}
		this.save();
	}
}

export function conversationKey(chatId: string, threadId?: string): string {
	return threadId ? `${chatId}:${threadId}` : `${chatId}:root`;
}
