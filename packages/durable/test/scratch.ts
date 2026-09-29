// A tour of the durable Session and Harness APIs in fourteen small examples.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/scratch.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	createModels,
	type Message,
	type StopReason,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	ConversationConfig,
	type ConversationId,
	createRegistry,
	createSession,
	defineDoc,
	defineEntry,
	defineTask,
	type EntryRecord,
	Harness,
	MemoryStorage,
	type PromptInput,
	type ToolRegistration,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

// A Session stores conversations, transcript entries, tasks, and documents.
// MemoryStorage keeps everything in memory; other storage backends keep it on disk.
const session = createSession(new MemoryStorage());

// Every Session call takes a context, which is used for cancellation.
// BACKGROUND_CONTEXT means "never cancel".
const context = BACKGROUND_CONTEXT;

// ─── 1. Create a standalone conversation ────────────────────────────────────
// All writes happen inside session.commit(). The callback receives a
// transaction `tx`; everything it writes is saved together when the callback
// returns, or discarded if it throws.
// "ownerless" means no task created this conversation.
const standalone = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
console.log("1. standalone conversation:", standalone);

// ─── 2. Store document state next to transcript entries ─────────────────────
// A document is a JSON object attached to something; here, one per conversation.
// "rewindable" keeps old values readable, so you can ask what the document
// looked like when a particular entry was written.
// `fork` says what a forked copy of the conversation starts with (see example 3).
const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf", // a fork starts with the value these notes had at the fork entry
	initial: () => ({ text: "" }),
});

const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

// tx.doc() returns an editable copy of the document (created on first use).
// Plain assignments to it are saved when the commit finishes.
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);

const secondEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
	return entry;
}, context);

// snapshot() reads the latest value. snapshotAsOf() reads the value that was
// saved in the same commit as the given entry.
console.log("2. latest notes:", await session.snapshot(Notes, chat.id, context));
console.log("2. notes at first entry:", await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context));
console.log("2. notes at second entry:", await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context));

// ─── 3. Fork a conversation ─────────────────────────────────────────────────
// A fork is a new conversation that continues from one entry of another. It
// sees the parent's transcript up to that entry, and each document follows its
// own `fork` setting. Notes uses "asOf", so the fork starts with the notes
// value from the fork entry.
const branch = await session.commit(
	(tx) => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
	context,
);

// scanEntries() pages through visible entries, newest first. The fork sees
// "hello" (inherited from the parent) but not "goodbye", which came later.
const branchEntries = await session.commit((tx) => tx.scanEntries({ conversationId: branch.id }, 10), context);
console.log(
	"3. fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
console.log("3. fork notes:", await session.snapshot(Notes, branch.id, context));

// The fork's copy is independent: editing it leaves the parent unchanged.
await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("3. fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("3. parent notes after edit:", await session.snapshot(Notes, chat.id, context));

// ─── 4. Background task that owns a child conversation ──────────────────────
// A typical agent setup: a background task supervises a helper conversation,
// and the main conversation keeps a registry that maps agent names to their
// conversations. All three are created in one commit, so after a crash either
// all of them exist or none do.

// A task definition needs a name, a version, the task's starting state, a
// handler for every phase, and an abort handler (example 13 runs a task).
// This example only creates the task record; a plain Session never runs it.
const Supervisor = defineTask<null, { phase: "ready" }, null>({
	name: "example.supervisor",
	version: 1,
	initial: () => ({ phase: "ready" }),
	phases: { ready: async () => {} },
	abort: async () => {},
});

// "latest" keeps only the current value. "initial" means forks of this
// conversation start without a registry, so a child doesn't inherit its
// parent's list of agents.
const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	kind: "example.agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

const main = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

const setup = await session.commit(async (tx) => {
	// `background: true` means the task is side work: waiting for the main
	// conversation to finish does not wait for it.
	const supervisorId = await tx.createTask(Supervisor, null, { conversationId: main.id, background: true });

	// The child records that it belongs to the supervisor task. The task was
	// created a few lines above in this same commit, which is allowed.
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });

	// requestId is a fixed name for the child's first message. Later code sends
	// that message using this requestId, so a retry after a crash cannot
	// deliver it twice.
	(await tx.doc(AgentRegistry, main.id)).agents.researcher = {
		conversationId: child.id,
		requestId: `researcher:first-message:${supervisorId}`,
	};
	return { supervisorId, child };
}, context);

console.log("4. supervisor task:", setup.supervisorId);
console.log("4. child conversation:", setup.child);
console.log("4. registry:", await session.snapshot(AgentRegistry, main.id, context));

// ─── 5. Expose a document through Chord ─────────────────────────────────────
// documentState() never creates a document. It returns a hydrated read-only
// Chord state bound to the current concrete incarnation.
const notesState = await session.documentState(Notes, chat.id, context);
if (notesState === undefined) throw new Error("notes are absent");
const stopNotes = notesState.subscribe((value, _deliveryContext, delivery) => {
	console.log("5. Chord notes:", delivery.kind, delivery.sequence, value);
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "published through Chord";
}, context);
stopNotes();
notesState.dispose();

// ─── 6. Serialize asynchronous document work ────────────────────────────────
// A watch starts from one stable acquisition revision. Slow callbacks never
// overlap; exact committed frames buffer, with a full-value reset after 100.
const notesWatch = await session.watchDoc(Notes, chat.id, context);
if (notesWatch === undefined) throw new Error("notes are absent");
console.log("6. watch baseline:", notesWatch.value);
const delivered = new Promise<void>((resolve) => {
	notesWatch.start(async (value, _ops, _deliveryContext) => {
		console.log("6. watch update:", value);
		resolve();
	});
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "observed asynchronously";
}, context);
await delivered;
await notesWatch.stop();

await session.close(context);

// ─── 7. Open a Harness with a registry ──────────────────────────────────────
// A Harness is a Session plus conversation handles. Extension code (tools,
// hooks, tasks, system prompt sections) lives in a registry the
// application owns. Nothing in the registry is saved; it is this process's code.
// Apps may attach their own metadata to tools, such as a prompt snippet.
type AppTool = ToolRegistration & { readonly snippet?: string };

function exampleTool(name: string, description: string): AppTool {
	return {
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		snippet: `Use ${name} for files.`,
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }),
	};
}

const registry = createRegistry<AppTool>();
registry.tools.add(exampleTool("read", "Read a file"));
const writeRegistration = registry.tools.add(exampleTool("write", "Write a file"));
const grepRegistration = registry.tools.add(exampleTool("grep", "Search files"));

// `models` is pi-ai's model access; generation uses it in later packages.
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);

// The root conversation always has ID 1. The first root() call creates it,
// its configuration, and whatever `init` writes, all in one commit. Later
// calls, including after a restart, return it and ignore `init`.
const root = await harness.root(context, {
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
		(await tx.doc(ConversationConfig, rootId)).thinkingLevel = "low";
	},
});
console.log("7. root:", root.id, await harness.snapshot(Notes, root.id, context));
console.log("7. root config:", root.id, await harness.snapshot(ConversationConfig, root.id, context));

// ─── 8. Conversation configuration ──────────────────────────────────────────
// Model, thinking level, and active tool names live in the built-in
// ConversationConfig document. New conversations start with every registered
// tool active. Each setter is one commit.
console.log("8. active tools:", await root.getActiveTools(context));
await root.setModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" }, context);
await root.setThinkingLevel("high", context);
await root.setActiveTools(["write", "read"], context);
console.log("8. snippet kept on the app tool:", registry.tools.list()[0]!.snippet);
console.log("8. model:", await root.getModel(context), "thinking:", await root.getThinkingLevel(context));

// Adding a name that is not registered is rejected, and nothing is written.
await root
	.setActiveTools(["read", "find"], context)
	.catch((error: Error) => console.log("8. rejected:", error.message));

// Names that were already active are never rechecked. After "write" is
// unregistered it stays in the configuration; requests just stop offering it
// until it is registered again.
writeRegistration.dispose();
await root.setActiveTools(["write", "read", "grep"], context);
console.log("8. active tools without a registered write:", await root.getActiveTools(context));
console.log(
	"8. registered tools:",
	registry.tools.list().map((entry) => entry.name),
);

// ─── 9. Conversations and forks ─────────────────────────────────────────────
// Conversation handles are stateless; compare them by id. They bind commits
// to their conversation.
const MessageEntry = defineEntry<EntryRecord & { readonly kind: "message" }>("message");
const hello = await root.commit(
	(tx) => tx.appendEntry(root.id, { kind: "message", model: [{ role: "user", content: "hello", timestamp: 1 }] }),
	context,
);
console.log("9. typed entry:", MessageEntry.is(hello));

// createConversation() and fork() run `init` in the creating commit. A fork
// starts with the configuration the parent had at the fork entry.
const helper = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		init: async (tx, id) => {
			(await tx.doc(ConversationConfig, id)).activeTools = ["read"];
		},
	},
	context,
);
const retry = await root.fork(hello.id, { ownership: { kind: "ownerless" } }, context);
console.log("9. helper tools:", await helper.getActiveTools(context));
console.log("9. fork thinking:", await retry.getThinkingLevel(context));
console.log("9. lookup:", (await harness.conversation(retry.id, context))?.id === retry.id);

// ─── 10. Transcript history and model context ───────────────────────────────
// Entries are immutable. `model` holds the messages an entry contributes to
// the next model request; `data` is for the app only. context() turns the
// stored transcript into those request messages:
//   - an entry with `head` starts a new context; older entries stay stored,
//   - `edits` replace or omit what an earlier entry contributes,
//   - aborted, error, and deferred assistant messages are not sent,
//   - tool results are sent right after their call, in call order,
//   - a call without a result gets a synthesized error result.
function assistantMessage(text: string, calls: readonly string[] = [], stopReason?: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...calls.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "example",
		provider: "example",
		model: "example",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		timestamp: 2,
	};
}

function toolResultMessage(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `file ${id}` }],
		isError: false,
		timestamp: 3,
	};
}

function show(message: Message): string {
	switch (message.role) {
		case "user":
			return `user: ${message.content as string}`;
		case "system":
			return `system: ${JSON.stringify(message.sections)}`;
		case "assistant":
			return `assistant: ${message.content
				.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `call(${part.id})` : ""))
				.join(" ")}`;
		case "toolResult":
			return `result(${message.toolCallId})${message.isError ? " error" : ""}`;
	}
}

const transcript = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const say = (kind: string, ...model: Message[]) =>
	transcript.commit((tx) => tx.appendEntry(transcript.id, { kind, model }), context);

const question = await say("message", { role: "user", content: "read a and b", timestamp: 1 });
await say("message", assistantMessage("I crashed", [], "aborted")); // stored, never sent
const calls = await say("message", assistantMessage("reading", ["a", "b"]));
await say("message", toolResultMessage("b")); // results finish out of order
await say("pi.system", { role: "system", content: "", sections: { cwd: "<cwd>/repo</cwd>" }, timestamp: 4 });
await say("message", toolResultMessage("a"));
await say("message", assistantMessage("a and b look fine"));
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "edit",
			data: "user fixed a typo",
			edits: [
				{
					target: question.id,
					action: "replace",
					messages: [{ role: "user", content: "read files a and b", timestamp: 1 }],
				},
			],
		}),
	context,
);
await transcript.commit((tx) => tx.appendEntry(transcript.id, { kind: "note", data: "display only" }), context);

let transcriptView = await transcript.context(context);
console.log(
	"10. raw active entries:",
	transcriptView.entries.map((entry) => entry.kind),
);
console.log("10. request messages:", transcriptView.messages.map(show));

// A fork at the tool call has no results yet; context() fills them in.
const cut = await transcript.fork(calls.id, { ownership: { kind: "ownerless" } }, context);
console.log("10. fork messages:", (await cut.context(context)).messages.map(show));

// A headed summary replaces everything before the entry it points at.
// "self" points the head at the summary entry itself.
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "summary",
			head: "self",
			model: [{ role: "user", content: "Summary: a and b are fine.", timestamp: 5 }],
		}),
	context,
);
transcriptView = await transcript.context(context);
console.log("10. after summary:", transcriptView.head?.kind, transcriptView.messages.map(show));

// entries() pages the stored transcript, newest first, including inherited
// parent entries. Nothing is ever deleted by heads or edits.
const history = await transcript.entries({}, 3, undefined, context);
console.log(
	"10. newest stored entries:",
	history.items.map((entry) => entry.kind),
	"more:",
	history.next !== undefined,
);

// ─── 11. Reload extension code ──────────────────────────────────────────────
// batch() publishes a replacement at once, so no snapshot ever sees the tool
// missing. Work that already started keeps using the snapshot it took.
registry.batch(() => {
	grepRegistration.dispose();
	registry.tools.add(exampleTool("grep", "Search files, faster"));
});
console.log(
	"11. tools after reload:",
	registry.tools.list().map((entry) => `${entry.name}: ${entry.description}`),
);

// ─── 12. Register system prompt sections ────────────────────────────────────
// Pico stores no prompt state. Before each model request, the registry's
// sections render the desired prompt, and only the difference to what the
// model already saw is appended to the transcript as a `pi.system` entry.
// Sections read per-conversation data through `input.read`; here a coding
// agent keeps its own profile document.
const AgentProfile = defineDoc<{ role: "main" | "subagent"; cwd: string }>({
	kind: "example.agent-profile",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ role: "main", cwd: "/" }),
});
await root.commit(async (tx) => {
	(await tx.doc(AgentProfile, root.id)).cwd = "/repo";
}, context);

const prompt = registry.batch(() => {
	// `tag: false` sends the text as is; by default it is wrapped in <key>...</key>.
	registry.systemPrompt.section("preamble", () => "You are a coding agent.", { tag: false });
	registry.systemPrompt.section("cwd", async (input, renderContext) => {
		return (await input.read.snapshot(AgentProfile, input.conversationId, renderContext))?.cwd;
	});
	// Returning undefined omits the section, here for subagents.
	registry.systemPrompt.section("agents_md", async (input, renderContext) => {
		const profile = await input.read.snapshot(AgentProfile, input.conversationId, renderContext);
		return profile?.role === "subagent" ? undefined : "Run npm run check after changes.";
	});
	// Sections see the offered tools, including the app's own metadata.
	registry.systemPrompt.section("tools", (input) =>
		input.tools.length === 0
			? undefined
			: input.tools.map((entry) => `- ${entry.name}: ${entry.snippet ?? entry.description}`).join("\n"),
	);
});

// Another extension decorates a section without replacing it.
registry.systemPrompt.wrap("preamble", "tone", (section) => ({
	...section,
	render: async (input, renderContext) => `${await section.render(input, renderContext)} Be terse.`,
}));

// Package 15's request preparation runs these for every request. This loop
// only stands in for it to show the output.
const promptSnapshot = registry.snapshot();
const input: PromptInput<AppTool> = {
	conversationId: root.id,
	tools: promptSnapshot.tools(),
	shown: {},
	thinkingLevel: await root.getThinkingLevel(context),
	read: harness,
};
const rendered: string[] = [];
for (const section of promptSnapshot.sections()) {
	const text = await section.render(input, context);
	if (text === undefined) continue;
	rendered.push(section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
}
console.log(`12. rendered prompt:\n${rendered.join("\n")}`);

prompt.dispose();

// ─── 13. Run a durable task ─────────────────────────────────────────────────
// A task is a small state machine. Its state, the checkpoint, is saved after
// every step, so after a crash the next open continues from the last saved
// step. The usual pattern: save what you are about to do, do it, then save
// the result. A crash between doing and saving reruns that step, so the step
// must be safe to repeat; here the fake payment service ignores a repeated key.
const payments = new Map<string, number>();
type PaymentState = { phase: "prepare" } | { phase: "charge"; key: string };
const Payment = defineTask<{ amount: number }, PaymentState, { receipt: number }>({
	name: "example.payment",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	// One handler per phase. Each must save progress through runtime.commit():
	// its callback returns the next checkpoint or the final outcome, and that
	// state is saved in the same commit as everything else the callback wrote.
	phases: {
		prepare: async (task, runtime, taskContext) => {
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "charge", key: `payment-${task.id}` } }),
				taskContext,
			);
		},
		charge: async (task, runtime, taskContext) => {
			const key = task.state.checkpoint.key;
			if (!payments.has(key)) payments.set(key, task.input.amount * 100);
			const receipt = payments.get(key)!;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { receipt } } }),
				taskContext,
			);
		},
	},
	// Runs instead of the phases after harness.abortTask(); it decides the outcome.
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// The Harness finds task code by name in the registry. Nothing runs until
// resume(); a host calls it once it is ready for work to start.
registry.tasks.add(Payment);
const paymentId = await root.commit((tx) => tx.createTask(Payment, { amount: 5 }), context);
harness.resume();
// The finished task record is the durable receipt; waitForTask() knows its result type.
const paid = await harness.waitForTask(paymentId, context);
console.log("13. payment outcome:", paid.state.outcome);

await harness.close(context);

// ─── 14. Close, reopen, and continue where the task stopped ─────────────────
// Everything a task needs to continue is in storage, so a new Harness over the
// same storage picks up where the last one stopped. This example keeps its
// storage in a SQLite file so it survives closing.
const directory = await mkdtemp(join(tmpdir(), "pi-durable-scratch-"));
const databasePath = join(directory, "session.sqlite");

let reachedTick = (_n: number): void => {};
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
	name: "example.ticker",
	version: 1,
	initial: () => ({ phase: "tick", n: 1 }),
	phases: {
		tick: async (task, runtime, taskContext) => {
			const n = task.state.checkpoint.n;
			// Save the intent before the effect. A memo keeps the first value
			// written under its name, so if the process dies after printing but
			// before the next checkpoint is saved, the rerun sees the memo and
			// does not print the same tick twice.
			if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
				await runtime.memo(`printed-${n}`, true, taskContext);
				console.log(`14. tick ${n}`);
			}
			reachedTick(n);
			// Save the outcome: the next tick, or the final result.
			await runtime.commit(
				() =>
					n === task.input.to
						? { status: "terminal", outcome: { status: "completed", result: `counted to ${n}` } }
						: { status: "running", checkpoint: { phase: "tick", n: n + 1 } },
				taskContext,
			);
			// Wait a little between ticks. Closing the Harness cancels this wait;
			// the checkpoint saved above is where the next Harness continues.
			await runtime.sleep(Date.now() + 50, taskContext);
		},
	},
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});
registry.tasks.add(Ticker);

// First run: start counting to 5, and close the Harness right after tick 2 is
// printed, before its next checkpoint is saved. That is the same situation as
// a crash between the effect and saving its outcome.
const firstRun = await Harness.open(
	await openNodeSqliteStorage(databasePath),
	{ models: createModels(), registry },
	context,
);
const tickerId = await (await firstRun.root(context)).commit((tx) => tx.createTask(Ticker, { to: 5 }), context);
const tickTwo = new Promise<void>((resolve) => {
	reachedTick = (n) => {
		if (n === 2) resolve();
	};
});
firstRun.resume();
await tickTwo;
await firstRun.close(context);
reachedTick = () => {};
const saved = await readTicker();
console.log("14. closed; saved checkpoint:", saved.state, "memos:", saved.memos);

// Second run: nothing to restart by hand. Opening the storage finds the
// unfinished task and resume() continues it. Tick 2 runs again because its
// outcome was never saved, but its memo says it was already printed.
const secondRun = await Harness.open(
	await openNodeSqliteStorage(databasePath),
	{ models: createModels(), registry },
	context,
);
secondRun.resume();
const counted = await secondRun.waitForTask(tickerId, context);
console.log("14. after reopen:", counted.state.outcome);
await secondRun.close(context);
await rm(directory, { recursive: true, force: true });

/** Read the ticker record through a short-lived Harness over the same file. */
async function readTicker() {
	const reader = await Harness.open(
		await openNodeSqliteStorage(databasePath),
		{ models: createModels(), registry },
		context,
	);
	const record = await reader.getTask(tickerId, context);
	await reader.close(context);
	return record!;
}
