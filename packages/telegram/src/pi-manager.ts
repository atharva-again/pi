import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import type { ConversationBinding } from "./store.ts";
import { conversationKey, type TelegramBindingStore } from "./store.ts";

export interface ConversationRef {
	key: string;
	chatId: string;
	threadId?: string;
	chatType?: string;
}

interface LiveConversation {
	binding: ConversationBinding;
	process: RpcProcessInstance;
}

export interface PiConversationManagerOptions {
	defaultCwd: string;
	projectTrust: boolean;
	store: TelegramBindingStore;
	onEvent: (conversation: ConversationRef, event: AgentSessionEvent) => void;
	onUiRequest: (conversation: ConversationRef, request: RpcExtensionUIRequest) => void;
	onExit: (conversation: ConversationRef, error?: Error) => void;
}

function isGetStateResponse(
	response: RpcResponse,
): response is Extract<RpcResponse, { success: true; command: "get_state"; data: RpcSessionState }> {
	return response.success === true && response.command === "get_state";
}

function isSuccessResponse(response: RpcResponse): boolean {
	return response.success === true;
}

function responseError(response: RpcResponse): string | undefined {
	return response.success ? undefined : response.error;
}

export async function resolveSessionPath(sessionRef: string): Promise<string | undefined> {
	if (sessionRef.includes("/") || sessionRef.includes("\\") || sessionRef.endsWith(".jsonl")) {
		const resolved = resolve(sessionRef);
		return existsSync(resolved) ? resolved : undefined;
	}
	const sessions = await SessionManager.listAll();
	const match =
		sessions.find((session) => session.id === sessionRef) ??
		sessions.find((session) => session.id.startsWith(sessionRef));
	return match?.path;
}

export async function listRecentSessions(
	limit: number,
): Promise<Array<{ id: string; cwd: string; name?: string; firstMessage: string }>> {
	const sessions = await SessionManager.listAll();
	return sessions.slice(0, limit).map((session) => ({
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		firstMessage: session.firstMessage,
	}));
}

export class PiConversationManager {
	private readonly defaultCwd: string;
	private readonly projectTrust: boolean;
	private readonly store: TelegramBindingStore;
	private readonly onEvent: (conversation: ConversationRef, event: AgentSessionEvent) => void;
	private readonly onUiRequest: (conversation: ConversationRef, request: RpcExtensionUIRequest) => void;
	private readonly onExit: (conversation: ConversationRef, error?: Error) => void;
	private readonly live = new Map<string, LiveConversation>();
	private readonly expectedStops = new Set<string>();

	constructor(options: PiConversationManagerOptions) {
		this.defaultCwd = options.defaultCwd;
		this.projectTrust = options.projectTrust;
		this.store = options.store;
		this.onEvent = options.onEvent;
		this.onUiRequest = options.onUiRequest;
		this.onExit = options.onExit;
	}

	private createConversationRef(binding: ConversationBinding, chatType?: string): ConversationRef {
		return {
			key: binding.key,
			chatId: binding.chatId,
			threadId: binding.threadId,
			chatType,
		};
	}

	private buildPiArgs(binding: ConversationBinding): string[] {
		const args: string[] = [];
		if (this.projectTrust) {
			args.push("--approve");
		}
		if (binding.sessionFile) {
			args.push("--session", binding.sessionFile);
		}
		return args;
	}

	private async syncState(live: LiveConversation): Promise<RpcSessionState | undefined> {
		const response = await live.process.send({ type: "get_state" });
		if (!isGetStateResponse(response)) {
			return undefined;
		}
		live.binding = {
			...live.binding,
			sessionFile: response.data.sessionFile,
			sessionId: response.data.sessionId,
			updatedAt: new Date().toISOString(),
		};
		this.store.setBinding(live.binding);
		return response.data;
	}

	async getConversation(chatId: string, threadId: string | undefined, chatType?: string): Promise<LiveConversation> {
		const key = conversationKey(chatId, threadId);
		const existing = this.live.get(key);
		if (existing) {
			return existing;
		}

		let binding = this.store.getBinding(key);
		if (!binding) {
			binding = {
				key,
				chatId,
				threadId,
				cwd: this.defaultCwd,
				updatedAt: new Date().toISOString(),
			};
			this.store.setBinding(binding);
		}

		const rpcProcess = createRpcProcessInstance({ cwd: binding.cwd, args: this.buildPiArgs(binding) });
		const live: LiveConversation = { binding, process: rpcProcess };
		this.live.set(key, live);
		const conversation = this.createConversationRef(binding, chatType);
		rpcProcess.onEvent((event) => {
			this.onEvent(conversation, event);
			if (event.type === "agent_end") {
				void this.syncState(live).catch(() => {});
			}
		});
		rpcProcess.setUiRequestHandler((request) => {
			this.onUiRequest(conversation, request);
		});
		rpcProcess.onExit((error) => {
			this.live.delete(key);
			if (this.expectedStops.delete(key)) {
				return;
			}
			this.onExit(conversation, error);
		});
		await this.syncState(live);
		return live;
	}

	async getState(conversation: ConversationRef): Promise<RpcSessionState | undefined> {
		const live = await this.getConversation(conversation.chatId, conversation.threadId, conversation.chatType);
		return this.syncState(live);
	}

	async prompt(conversation: ConversationRef, message: string): Promise<string | undefined> {
		const live = await this.getConversation(conversation.chatId, conversation.threadId, conversation.chatType);
		const response = await live.process.send({ type: "prompt", message, streamingBehavior: "steer" });
		return responseError(response);
	}

	async sendCommand(conversation: ConversationRef, command: RpcCommand): Promise<RpcResponse> {
		const live = await this.getConversation(conversation.chatId, conversation.threadId, conversation.chatType);
		const response = await live.process.send(command);
		if (isSuccessResponse(response)) {
			await this.syncState(live);
		}
		return response;
	}

	async respondToUi(conversationKeyValue: string, response: RpcExtensionUIResponse): Promise<void> {
		const live = this.live.get(conversationKeyValue);
		if (!live) {
			return;
		}
		live.process.handleUiResponse(response);
	}

	async setWorkspace(conversation: ConversationRef, cwd: string): Promise<ConversationBinding> {
		const resolvedCwd = resolve(cwd);
		if (!existsSync(resolvedCwd)) {
			throw new Error(`Workspace does not exist: ${resolvedCwd}`);
		}
		const live = this.live.get(conversation.key);
		if (live) {
			this.live.delete(conversation.key);
			this.expectedStops.add(conversation.key);
			await live.process.dispose();
		}
		const binding: ConversationBinding = {
			key: conversation.key,
			chatId: conversation.chatId,
			threadId: conversation.threadId,
			cwd: resolvedCwd,
			updatedAt: new Date().toISOString(),
		};
		this.store.setBinding(binding);
		await this.getConversation(conversation.chatId, conversation.threadId, conversation.chatType);
		return binding;
	}

	async restoreSession(conversation: ConversationRef, sessionPath: string): Promise<RpcResponse> {
		const live = await this.getConversation(conversation.chatId, conversation.threadId, conversation.chatType);
		const response = await live.process.send({ type: "switch_session", sessionPath });
		if (isSuccessResponse(response)) {
			await this.syncState(live);
		}
		return response;
	}

	async dispose(): Promise<void> {
		for (const [key, live] of this.live) {
			this.expectedStops.add(key);
			await live.process.dispose();
		}
		this.live.clear();
	}
}
