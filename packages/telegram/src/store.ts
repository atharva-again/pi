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

interface StoreFile {
	bindings?: ConversationBinding[];
	topicModeChats?: string[];
}

export class TelegramBindingStore {
	private readonly path: string;
	private readonly bindings = new Map<string, ConversationBinding>();
	private readonly topicModeChats = new Set<string>();

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
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const data: StoreFile = {
			bindings: [...this.bindings.values()],
			topicModeChats: [...this.topicModeChats.values()],
		};
		writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`);
	}

	getBinding(key: string): ConversationBinding | undefined {
		const binding = this.bindings.get(key);
		return binding ? { ...binding } : undefined;
	}

	setBinding(binding: ConversationBinding): void {
		this.bindings.set(binding.key, { ...binding, updatedAt: new Date().toISOString() });
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
		}
		this.save();
	}
}

export function conversationKey(chatId: string, threadId?: string): string {
	return threadId ? `${chatId}:${threadId}` : `${chatId}:root`;
}
