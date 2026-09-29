import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message, Models, ModelThinkingLevel, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	ConversationOwnership,
	Cursor,
	DocumentObserver,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	Session,
	SubmissionId,
	SubmissionRecord,
	Task,
	TaskId,
	TaskOptions,
	TaskRecord,
	TaskState,
	Tx,
} from "../types.ts";

/** Provider and model ID resolved through pi-ai `Models`. */
export type ModelRef = {
	readonly provider: string;
	readonly modelId: string;
};

export type UserInput = UserMessage["content"];

/** Host submission: user input that may start a turn, or a passive entry write. */
export type SubmissionDraft = {
	readonly requestId?: string;
} & (
	| {
			readonly type: "input";
			readonly content: UserInput;
			readonly whenBusy?: "steer" | "followUp" | "reject";
			readonly entry?: never;
	  }
	| {
			readonly type: "write";
			readonly entry: EntryDraft;
			readonly content?: never;
			readonly whenBusy?: never;
	  }
);

export type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

export type SettledSubmissionRecord = SubmissionRecord & {
	readonly status: "done" | "unanswered";
};

/** Awaitable host object for one durably admitted submission. */
export interface Submission {
	readonly id: SubmissionId;
	status(context: Context): Promise<SubmissionRecord>;
	wait(context: Context): Promise<SettledSubmissionRecord>;
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
	readonly state: Extract<TaskState<JsonValue, R>, { readonly status: "terminal" }>;
};

/** Erased executable task definition stored in the registry. */
export type AnyTask = {
	readonly definition: {
		readonly name: string;
		readonly version: number;
		readonly initial: unknown;
		readonly phases: Readonly<Record<string, unknown>>;
		readonly abort: unknown;
		readonly migrate?: unknown;
		readonly hooks?: object;
	};
};

/** Hook handler map declared by a task definition. */
export type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H> ? H : never;

/** Committed document reads. */
export type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

/** Invocation-bound conversation operations available to tools. */
export interface ConversationHandle {
	readonly id: ConversationId;
	submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
	abort(context: Context): Promise<void>;
	waitForIdle(context: Context): Promise<void>;
}

/** Post-tools controls requested by a tool result. */
export type ToolControl = {
	readonly addTools?: readonly string[];
	readonly terminate?: true;
	readonly handoff?: string;
};

export type ToolExecutionResult = {
	readonly content?: ToolResultMessage["content"];
	readonly isError?: boolean;
	readonly details?: JsonValue;
	readonly control?: ToolControl;
};

/** Operations available to one tool invocation. */
export interface ToolExecutionApi extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly callId: string;
	/** Append running output; it becomes the result content when the result omits `content`. */
	output(chunk: string | Uint8Array): void;
	/** Replace running details; the last value becomes the result details when the result omits `details`. */
	details(value: JsonValue, context: Context): Promise<void>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: Omit<TaskOptions, "conversationId">,
		context: Context,
	): Promise<TaskId<R>>;
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
}

/** Executable tool registered in a registry. Only pi-ai `Tool` fields enter the transcript. */
export type ToolRegistration = Tool & {
	/** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */
	readonly replay?: "safe" | "unsafe";
	readonly outputLimits?: {
		readonly maxBytes?: number;
		readonly maxLines?: number;
		readonly retain?: "head" | "tail";
	};
	execute(args: JsonValue, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult>;
};

/** Token for removing registrations. Work already running keeps using what it started with. */
export interface Registration {
	/** Idempotent; removes exactly the registrations this token covers. */
	dispose(): void;
}

/** Pure decorator; returns a new tool with the same name and never mutates its input. */
export type ToolWrapper<Tool extends ToolRegistration> = (tool: Tool) => Tool;

/** Conversation selection for a scoped hook registration. */
export type HookScope = {
	readonly conversationId: ConversationId;
	/** Also match conversations owned, transitively, by tasks of this conversation. */
	readonly subtree?: boolean;
};

/** Input to system prompt section rendering for one request preparation. */
export type PromptInput<Tool extends ToolRegistration> = {
	readonly conversationId: ConversationId;
	/** Active and registered tools in configured order, as offered in this request. */
	readonly tools: readonly Tool[];
	/** Sections already in effect after replaying the active transcript. */
	readonly shown: Readonly<Record<string, string>>;
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Committed document reads. */
	readonly read: DocumentReader;
};

/** One registered system prompt section; sections render in registry order before each request. */
export type PromptSection<Tool extends ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
	/** Default true: wrap the text as `<key>\n...\n</key>`. */
	readonly tag?: boolean;
};

/** Pure decorator; returns a new section with the same key and never mutates its input. */
export type PromptSectionWrapper<Tool extends ToolRegistration> = (section: PromptSection<Tool>) => PromptSection<Tool>;

/** One registered hook handler map for task `K`. */
export type HookRegistration<K extends AnyTask> = {
	readonly handlers: Partial<HooksOf<K>>;
	readonly scope?: HookScope;
};

/** Wrapper composition failure found while building a snapshot. */
export type RegistryFailure = {
	readonly kind: "tool" | "section";
	/** Tool name or section key. */
	readonly name: string;
	readonly error: unknown;
};

/** Immutable view of one published registry state. */
export interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
	/** Composed tools in registry order; a tool whose wrapper failed is absent. */
	tools(): readonly Tool[];
	tool(name: string): Tool | undefined;
	/** Base tool names in registry order, including tools whose wrappers fail. */
	toolNames(): readonly string[];
	task(name: string): AnyTask | undefined;
	/** Hooks registered for tasks with `task`'s name, in registry order. */
	hooks<K extends AnyTask>(task: K): readonly HookRegistration<K>[];
	/** Composed sections in registry order; a section whose wrapper failed is absent. */
	sections(): readonly PromptSection<Tool>[];
	/** Wrapper failures of this state. */
	failures(): readonly RegistryFailure[];
}

/** Read side of a registry consumed by a Harness. */
export interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
	/** Immutable view of the whole current registry. */
	snapshot(): RegistrySnapshot<Tool>;
	/** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
	subscribe(listener: () => void): () => void;
}

/** Application-owned registry of tools, hooks, tasks, and the system prompt. */
export interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
	readonly tools: {
		add(tool: Tool): Registration;
		/** `key` identifies the wrapper: it orders wrappers of one tool and keeps its position on re-registration. */
		wrap(name: string, key: string, wrapper: ToolWrapper<Tool>): Registration;
		/** Composed tools of the current state. */
		list(): readonly Tool[];
	};
	readonly hooks: {
		add<K extends AnyTask>(
			task: K,
			handlers: Partial<HooksOf<K>>,
			options?: { readonly scope?: HookScope; readonly key?: string },
		): Registration;
	};
	readonly tasks: {
		add(task: AnyTask): Registration;
		list(): readonly AnyTask[];
	};
	readonly systemPrompt: {
		section(key: string, render: PromptSection<Tool>["render"], options?: { readonly tag?: boolean }): Registration;
		wrap(key: string, wrapperKey: string, wrapper: PromptSectionWrapper<Tool>): Registration;
		/** Composed sections of the current state. */
		sections(): readonly PromptSection<Tool>[];
	};
	/** Stage registrations and disposals made synchronously by `register`, then publish them at once. Cannot nest. */
	batch(register: () => void): Registration;
}

/**
 * Runs inside the creating commit, after the conversation and its configuration exist. The conversation creation is
 * already a table write, so table reads here throw `ReadAfterWrite`; document access remains available.
 */
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	readonly init?: ConversationInit;
};

export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
	/** pi-ai model access used by generation. */
	readonly models: Models;
	readonly registry: RegistryReader<Tool>;
	readonly now?: () => number;
	/** Receives extension failures that do not fail the calling operation. Must not throw. */
	readonly onReport?: (error: unknown) => void;
};

/** Typed entry kind with a narrowing guard. */
export interface Entry<E extends EntryRecord = EntryRecord> {
	readonly kind: string;
	is(entry: EntryRecord | undefined): entry is E;
}

/** Raw active transcript and derived model context. */
export type ContextView = {
	/** Newest applicable head marker, if any. */
	readonly head: EntryRecord | undefined;
	/** Raw active entries: the head marker followed by non-head entries from its head through the tail. */
	readonly entries: readonly EntryRecord[];
	/** Model context for the next provider request. */
	readonly messages: readonly Message[];
};

/** Stateless handle for one conversation, bound to the Harness that returned it. Compare handles by `id`. */
export interface Conversation {
	readonly id: ConversationId;

	getModel(context: Context): Promise<ModelRef | undefined>;
	setModel(model: ModelRef | undefined, context: Context): Promise<void>;
	getThinkingLevel(context: Context): Promise<ModelThinkingLevel>;
	setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void>;
	getActiveTools(context: Context): Promise<readonly string[]>;
	setActiveTools(names: readonly string[], context: Context): Promise<void>;

	/** Session commit whose `tx.createTask()` defaults to this conversation. */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	context(context: Context): Promise<ContextView>;
	/** Newest-first fork-aware history of this conversation. */
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	/** Resolve when no live non-background task belongs to this conversation. */
	waitForIdle(context: Context): Promise<void>;
}

// TODO: decide how Harness exposes subscribeCommits() and subscribeClose(). Their listeners run on the Session line
// and must not throw or call Session APIs, and Harness close will also join task invocations.
/** Durable agent harness over one Session. */
export interface Harness extends Session {
	/** Enable task scheduling. Idempotent; throws after close. */
	resume(): void;

	/** Return the reserved root conversation, creating it with `init` in one commit when absent. */
	root(context: Context, options?: { readonly init?: ConversationInit }): Promise<Conversation>;
	// Conversation activity (active/idle notifications) is specified with turn control in Package 17.
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	/**
	 * Commit the abort mark, signal and join an active run invocation, and schedule the abort invocation. A task whose
	 * definition cannot take it settles as `orphaned` instead.
	 */
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
	/** Resolve with the terminal receipt; cancelling `context` cancels only this wait. */
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** Resolve when no live non-background task exists. */
	waitForIdle(context: Context): Promise<void>;
}
