import type { Context, Draft, JsonValue } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { SessionImpl } from "../session/session.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	Storage,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { ConversationConfig, type ConversationConfigState } from "./config.ts";
import { captureContextBounds, deriveContext } from "./context.ts";
import { TaskScheduler } from "./scheduler.ts";
import type {
	ContextView,
	Conversation,
	ConversationCreateOptions,
	ConversationInit,
	HarnessOptions,
	Harness as HarnessType,
	ModelRef,
	RegistryReader,
	RegistrySnapshot,
	SettledTask,
	ToolRegistration,
} from "./types.ts";

type CreateTarget =
	| { readonly kind: "root" }
	| { readonly kind: "independent"; readonly ownership: ConversationOwnership }
	| {
			readonly kind: "fork";
			readonly parentId: ConversationId;
			readonly at: EntryId;
			readonly ownership: ConversationOwnership;
	  };

/** Harness-private services used by Conversation handles. */
type ConversationHost<Tool extends ToolRegistration> = {
	readonly harness: HarnessImpl<Tool>;
	readonly storage: Storage;
	readonly registry: RegistryReader<Tool>;
	readonly tasks: TaskScheduler;
	create(target: CreateTarget, init: ConversationInit | undefined, context: Context): Promise<Conversation>;
};

class ConversationImpl<Tool extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	readonly #host: ConversationHost<Tool>;

	constructor(id: ConversationId, host: ConversationHost<Tool>) {
		this.id = id;
		this.#host = host;
	}

	async getModel(context: Context): Promise<ModelRef | undefined> {
		return (await this.#config(context)).model;
	}

	setModel(model: ModelRef | undefined, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (model === undefined) delete config.model;
			else config.model = { provider: model.provider, modelId: model.modelId };
		}, context);
	}

	async getThinkingLevel(context: Context): Promise<ModelThinkingLevel> {
		return (await this.#config(context)).thinkingLevel;
	}

	setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void> {
		return this.#editConfig((config) => {
			config.thinkingLevel = level;
		}, context);
	}

	async getActiveTools(context: Context): Promise<readonly string[]> {
		return (await this.#config(context)).activeTools;
	}

	setActiveTools(names: readonly string[], context: Context): Promise<void> {
		return this.#editConfig((config) => {
			if (new Set(names).size !== names.length) throw new Error("Active tools list a name more than once");
			requireRegistered(this.#host.registry.snapshot(), names, config.activeTools);
			config.activeTools = [...names];
		}, context);
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.#host.harness.commitWith(change, context, this.id);
	}

	async context(context: Context): Promise<ContextView> {
		const storage = this.#host.storage;
		const bounds = await this.#host.harness.readOnLine(() => captureContextBounds(storage, this.id, context));
		return deriveContext(storage, this.id, bounds, context);
	}

	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		const bounded: EntryQuery = {
			conversationId: this.id,
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		};
		return this.#host.harness.readOnLine(() => this.#host.storage.scanEntries(bounded, limit, cursor, context));
	}

	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#host.create(
			{ kind: "fork", parentId: this.id, at, ownership: options.ownership },
			options.init,
			context,
		);
	}

	waitForIdle(context: Context): Promise<void> {
		return this.#host.tasks.waitForIdle(this.id, context);
	}

	async #config(context: Context): Promise<Readonly<ConversationConfigState>> {
		return (
			(await this.#host.harness.snapshot(ConversationConfig, this.id, context)) ??
			ConversationConfig.definition.initial()
		);
	}

	#editConfig(edit: (config: Draft<ConversationConfigState>) => void, context: Context): Promise<void> {
		return this.#host.harness.commitWith(async (tx) => {
			edit(await tx.doc(ConversationConfig, this.id));
		}, context);
	}
}

/** Session kernel extended with conversation handles and a registry. */
class HarnessImpl<Tool extends ToolRegistration> extends SessionImpl implements HarnessType {
	readonly #storage: Storage;
	readonly #registry: RegistryReader<Tool>;
	readonly #host: ConversationHost<Tool>;
	readonly #tasks: TaskScheduler;
	#closed = false;

	constructor(storage: Storage, options: HarnessOptions<Tool>, context: Context) {
		super(storage);
		this.#storage = storage;
		this.#registry = options.registry;
		this.#tasks = new TaskScheduler({
			session: this,
			storage,
			registry: options.registry,
			models: options.models,
			now: options.now ?? Date.now,
			report: options.onReport ?? (() => {}),
			context: withoutAbortSignal(context),
		});
		this.#host = {
			harness: this,
			storage,
			registry: options.registry,
			tasks: this.#tasks,
			create: (target, init, context) => this.#create(target, init, context),
		};
	}

	/** Reconcile surviving `running` tasks to `pending`; part of open. */
	openTasks(context: Context): Promise<void> {
		return this.#tasks.open(context);
	}

	resume(): void {
		this.#assertOpen();
		this.#tasks.resume();
	}

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
		return this.readOnLine(() => this.#storage.task(id, context)) as Promise<
			TaskRecord<JsonValue, JsonValue, R> | undefined
		>;
	}

	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		return this.#tasks.abort(id, context);
	}

	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>> {
		return this.#tasks.waitForTask(id, context) as Promise<SettledTask<R>>;
	}

	waitForIdle(context: Context): Promise<void> {
		return this.#tasks.waitForIdle(undefined, context);
	}

	root(context: Context, options?: { readonly init?: ConversationInit }): Promise<Conversation> {
		return this.#create({ kind: "root" }, options?.init, context);
	}

	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.#assertOpen();
		const record = await this.readOnLine(() => this.#storage.conversation(id, context));
		return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
	}

	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options.init, context);
	}

	override close(context: Context): Promise<void> {
		this.#closed = true;
		return super.close(context);
	}

	/** Join task invocations after admission is sealed and before Storage closes; writes no task outcome. */
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}

	async #create(target: CreateTarget, init: ConversationInit | undefined, context: Context): Promise<Conversation> {
		this.#assertOpen();
		const id =
			target.kind === "root"
				? await this.commitWith(async (tx) => {
						if ((await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) return ROOT_CONVERSATION_ID;
						return this.#stageConfiguration(tx, await tx.createRootConversation(), false, init);
					}, context)
				: await this.commitWith(async (tx) => {
						const record =
							target.kind === "fork"
								? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
								: await tx.createConversation({ ownership: target.ownership });
						return this.#stageConfiguration(tx, record, target.kind === "fork", init);
					}, context);
		return new ConversationImpl(id, this.#host);
	}

	/**
	 * Stage a new conversation's configuration and `init` writes. Independent conversations start with every
	 * registered tool active; forks keep the configuration copied from their fork entry.
	 */
	async #stageConfiguration(
		tx: Tx,
		record: ConversationRecord,
		forked: boolean,
		init: ConversationInit | undefined,
	): Promise<ConversationId> {
		const snapshot = this.#registry.snapshot();
		if (!forked) (await tx.doc(ConversationConfig, record.id)).activeTools = [...snapshot.toolNames()];
		if (init === undefined) return record.id;
		const baseline = [...(await tx.doc(ConversationConfig, record.id)).activeTools];
		await init(tx, record.id);
		// `init` writes are trusted like any raw write; only names it newly activates must be registered.
		requireRegistered(snapshot, (await tx.doc(ConversationConfig, record.id)).activeTools, baseline);
		return record.id;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Harness is closed");
	}
}

/** Reject names newly added relative to `previous` that `snapshot` does not register; existing names are never rechecked. */
function requireRegistered<Tool extends ToolRegistration>(
	snapshot: RegistrySnapshot<Tool>,
	names: readonly string[],
	previous: readonly string[],
): void {
	const existing = new Set(previous);
	const registered = new Set(snapshot.toolNames());
	const missing = names.filter((name) => !existing.has(name) && !registered.has(name));
	if (missing.length > 0) throw new Error(`Tools are not registered: ${missing.join(", ")}`);
}

/** Durable agent harness over one Session. */
export type Harness = HarnessType;

export const Harness = {
	/** Open a Harness over storage. The registry may keep changing while the Harness runs. */
	async open<Tool extends ToolRegistration>(
		storage: Storage,
		options: HarnessOptions<Tool>,
		context: Context,
	): Promise<Harness> {
		context.abortSignal?.throwIfAborted();
		const harness = new HarnessImpl(storage, options, context);
		try {
			await harness.openTasks(context);
		} catch (error) {
			await harness.close(context);
			throw error;
		}
		return harness;
	},
};
