# Pico5 specification

Pico5 is a durable, extensible agent harness. This document is normative.
Pico5 uses existing package types as follows:

```ts
import type {
  AttachedReplicatedState,
  Context,
  Draft,
  JsonValue,
  ReplicatedState,
} from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type {
  Message,
  Models,
  ModelThinkingLevel,
  TextContent,
  Tool,
  ToolReference,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

type JsonObject = { [key: string]: JsonValue };
type TaskOutcomeError = { message: string; detail?: JsonValue };
```

Pico5 targets the transcript `SystemMessage` contract from pi-ai PR
[#9548](https://github.com/earendil-works/pi/pull/9548). `Message` includes that
type once the PR lands.

The core rule is:

> A Session atomically commits immutable entries, full task records, and
> Chord-tracked documents. Only committed state is observable.

## 1. Terms and invariants

- A **Session** owns one mutation line, conversations, entries, tasks,
  submissions, and documents.
- A **conversation** is a transcript scope. It may fork another conversation.
- An **entry** is an immutable transcript record.
- A **task** is a durable state machine attached to one conversation.
- A **document** is mutable JSON state represented by Chord operations and
  occasional complete bases.
- A **definition** is a typed token describing one document or document family.
- A **source** exposes committed document changes to Chord without exposing a
  mutable object.

Required invariants:

1. One Session commit is atomic across all record and document writes.
2. A document update is published only after its storage commit succeeds.
3. All visible progress is durable. There is no volatile publication path.
4. External effects do not run inside the Session mutation transaction.
5. Entries and IDs are immutable and never reused after a committed write.
6. Document drafts are fully revoked when their transaction callback settles:
   the Session synchronously prepares or aborts every open change at that point.
   Values assigned into a draft are copied by value and must be strict JSON.
7. The mutation line remains held through storage settlement and committed-state
   adoption. Commit/close observers run synchronously only to capture immutable
   state; document-state and watch user callbacks run later, off the line.
8. An uncertain storage failure is fatal to the open Session. It publishes
   nothing and must be reopened. Preparation and checkpoint failures occur before
   storage admission and roll back normally.

## 2. Core records

The concrete JSON representations may add bookkeeping fields, but must preserve
these contracts.

```ts
declare const idBrand: unique symbol;
type Id<Kind extends string, Type = unknown> = number & {
  readonly [idBrand]: {
    readonly kind: Kind;
    readonly type: Type;
  };
};
type ConversationId = Id<"conversation">;
type EntryId = Id<"entry">;
type TaskId<Result = unknown> = Id<"task", Result>;
type SubmissionId = Id<"submission">;
type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;
/** Strictly increases between commits; gaps are permitted. */
type Seq = number & { readonly [seqBrand]: "sequence" };
const ROOT_CONVERSATION_ID = 1 as ConversationId;

type ConversationOwnership =
  | { readonly kind: "ownerless" }
  | { readonly kind: "task"; readonly taskId: TaskId };

type ConversationRecord = {
  readonly id: ConversationId;
  readonly parent?: {
    readonly conversationId: ConversationId;
    readonly at: EntryId;
  };
  readonly owner?: {
    readonly conversationId: ConversationId;
    readonly taskId: TaskId;
  };
};
```

The referenced pi-ai member is:

```ts
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

In pi-ai, `content` is the base prompt on the leading message and additional
instruction text on later messages. `sections` is an ordered named patch: a
string adds or replaces a section, while `null` removes it. `toolsRemoved` is
applied before `toolsAdded` within one message. Replaying every system message
in transcript order yields the effective prompt and tool set.

Pico always writes `content: ""`. Every prompt part, including the preamble, is
a named section produced by the registry's system prompt slot (section 7.4).

```ts
type ContextEdit = {
  readonly target: EntryId;
} & (
  | { readonly action: "omit"; readonly messages?: never }
  | { readonly action: "replace"; readonly messages: readonly Message[] }
);

type EntryRecord = {
  readonly id: EntryId;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly model?: readonly Message[];
  readonly data?: JsonValue;
  readonly head?: EntryId;
  readonly edits?: readonly ContextEdit[];
  readonly byTaskId?: TaskId;
};

type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
  readonly head?: EntryId | "self";
};

type SubmissionRecordBase = {
  readonly id: SubmissionId;
  readonly conversationId: ConversationId;
  readonly requestId?: string;
};

type SubmissionRecord =
  | (SubmissionRecordBase & {
      readonly type: "input";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "placed";
          readonly entry: EntryId;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: EntryId;
          readonly answer: EntryId;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: EntryId;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ))
  | (SubmissionRecordBase & {
      readonly type: "write";
    } & (
      | {
          readonly status: "queued";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "done";
          readonly entry: EntryId;
          readonly answer?: never;
          readonly reason?: never;
          readonly detail?: never;
        }
      | {
          readonly status: "unanswered";
          readonly entry?: never;
          readonly answer?: never;
          readonly reason: string;
          readonly detail?: JsonValue;
        }
    ));

type SubmissionCreate = SubmissionRecord extends infer Record
  ? Record extends SubmissionRecord
    ? Omit<Record, "id">
    : never
  : never;
```

ID brands are compile-time only. IDs and sequences remain ordinary numbers in
memory, JSON, JSONL, and SQLite. Code applies a brand only at a trusted creation
or decoding boundary. The distinct sequence brand prevents an entity ID from
being used as a document commit point.

Conversation history parenting and task ownership are separate:

- `parent` controls inherited entries and historical documents.
- `owner` records task attribution and connects scopes for subtree abort and idle traversal. It is not an access-control capability.
- Creation always supplies `ConversationOwnership` explicitly. The Session
  derives the persisted owner's conversation from the named task; callers never
  construct the persisted owner pair.

A conversation's owner remains recorded after the owning task becomes terminal.

### 2.1 Entries and context

Entry IDs are Session-global and ordered. `parent.at` is an entry in the parent
history visible to the child.

The active transcript is the raw entry range from the newest applicable `head`
through the tail. A head on an entry changes subsequent context; it does not
remove older entries from storage. Fork traversal is child entries followed by
parent entries through each `parent.at` cap.

Context derivation:

1. Find the newest visible entry `H` at or before the cutoff that has `head`.
2. Let `from = H.head`, or transcript start when `H` is absent.
3. Scan visible entries from `from` through the cutoff.
4. For each target, the newest edit in that range wins. `omit` contributes no
   model messages; `replace` contributes its `messages` instead of the target's.
5. If `H` exists, context entries are `H` followed by non-head entries in the
   range. Otherwise they are the range.
6. Keep every positional system message and its tool/section changes.
7. Move each assistant's tool results, found before the next assistant message,
   directly after it in tool-call order, ahead of any intervening user or system
   message. The provider protocol requires results to follow their call.
8. Synthesize an error result for every call without one, for example after a
   fork cut or at an interrupted tail. Drop tool results with no preceding call.
9. Exclude model-less entries and assistant messages with `aborted`, `error`, or
   `deferred` stop reasons from future provider requests.

Views carry raw active entries. UI reduction and model-context reduction are
separate consumers. Older stored history is available through the owning
`Conversation` object's cursor-based `entries()` scan.

### 2.2 Public Harness surface

This is the v1 host-facing API. Pico5 is not implemented yet, but implementations
must expose this shape rather than inventing a different facade during package
24.

```ts
type ModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

type UserInput = UserMessage["content"];

type SubmissionDraft = {
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

type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

/** Runs inside the creating commit, after the conversation and its configuration exist. */
type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

type ConversationCreateOptions = {
  readonly ownership: ConversationOwnership;
  readonly init?: ConversationInit;
};

type AnyTask = {
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

type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
  readonly models: Models; // the pi-ai Models interface
  readonly registry: RegistryReader<Tool>; // section 7.1
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

type ConversationConfigState = {
  model?: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  activeTools: string[];
};

/** Built-in rewindable configuration document; see below. */
declare const ConversationConfig: RewindableConversationDocToken<ConversationConfigState>;

interface Entry<E extends EntryRecord = EntryRecord> {
  readonly kind: string;
  is(entry: EntryRecord | undefined): entry is E;
}

function defineEntry<E extends EntryRecord>(kind: string): Entry<E>;

type ContextView = {
  readonly head: EntryRecord | undefined;
  readonly entries: readonly EntryRecord[];
  readonly messages: readonly Message[];
};

type SettledSubmissionRecord = SubmissionRecord & {
  readonly status: "done" | "unanswered";
};

interface Submission {
  readonly id: SubmissionId;
  status(context: Context): Promise<SubmissionRecord>;
  wait(context: Context): Promise<SettledSubmissionRecord>;
  abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
  readonly state: Extract<TaskState<JsonValue, R>, { status: "terminal" }>;
};

type ConversationWatch = WatchHandle<ConversationView>;

type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H>
  ? H
  : never;

interface Conversation {
  readonly id: ConversationId;
  submit(submission: SubmissionDraft, context: Context): Promise<Submission>;

  getModel(context: Context): Promise<ModelRef | undefined>;
  setModel(model: ModelRef | undefined, context: Context): Promise<void>;
  getThinkingLevel(context: Context): Promise<ModelThinkingLevel>;
  setThinkingLevel(level: ModelThinkingLevel, context: Context): Promise<void>;
  getActiveTools(context: Context): Promise<readonly string[]>;
  setActiveTools(names: readonly string[], context: Context): Promise<void>;

  commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    context: Context,
  ): Promise<T>;
  context(context: Context): Promise<ContextView>;
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
  fork(
    at: EntryId,
    options: ConversationCreateOptions,
    context: Context,
  ): Promise<Conversation>;
  collapse(instructions: string | undefined, context: Context): Promise<TaskId>;
  reset(handoff: string | undefined, context: Context): Promise<void>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
  viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
  watch(context: Context): Promise<ConversationWatch>;
}

interface Harness extends Session {
  resume(): void;

  root(
    context: Context,
    options?: { readonly init?: ConversationInit },
  ): Promise<Conversation>;
  conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
  createConversation(
    options: ConversationCreateOptions & { readonly input?: UserInput },
    context: Context,
  ): Promise<Conversation>;

  getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
  submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
  abortSubmission(
    id: SubmissionId,
    context: Context,
    conversationId?: ConversationId,
  ): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
  abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
  waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
  waitForIdle(context: Context): Promise<void>;
}

declare const Harness: {
  open<Tool extends ToolRegistration>(
    storage: Storage,
    options: HarnessOptions<Tool>,
    context: Context,
  ): Promise<Harness>;
};
```

This intentionally retains the useful Pico3 host shape. It removes Pico3's
fixed `rewindable()`/`sticky()` accessors, namespace router, semantic view events,
and manual Chord view bridge. Typed Pico5 documents and the structural
conversation watch replace those surfaces. `submit()` durably admits either a
user input or passive entry write and returns one `Submission` that tracks its
settlement.

`Harness.open()` binds the Session to one application-owned registry (section
7.1). Built-in task definitions live outside that registry.
Open changes surviving `running` tasks to `pending` and does nothing else to
task records: it never migrates or terminalizes a task because its definition
is missing or unmigratable. Such a task stays `pending` and is **blocked**: the
scheduler skips it and reconsiders it whenever the registry changes (section
5.4). Any built-in document touched by recovery migrates through its ordinary
typed access path. Open does not scan or migrate other documents. No handler
dispatches during open. Applications should register tasks before open so
recovered work can resume immediately; registration after open also unblocks it.

The root conversation always has reserved ID `ROOT_CONVERSATION_ID` (`1`).
`root(context, { init })` creates it lazily: when the root is absent, one commit
on the Session line creates the ownerless root, its default configuration, and
runs `init(tx, rootId)`. When the root already exists, `init` is ignored and no
write occurs. Reopen finds the same root by its reserved ID. A conversation with
no configured model produces a durable `no_model` generation failure.

`resume()` is idempotent while running and only enables scheduling. It does not
repeat open-time reconciliation, and it throws after close. Work that must happen
before any task runs, such as registration or seeding, happens before
`resume()`.

`createConversation({ ownership, init, input })` and
`fork(at, { ownership, init })` commit atomically: the conversation, its
explicitly selected ownership, its configuration, every write made by `init`,
and an optional input submission. Host callers must choose ownerless or task
ownership; neither the Harness nor a conversation handle infers ownership from
call context. A new independent conversation receives the default configuration
before `init` runs. A fork receives the configuration visible at `at` through
the ordinary `asOf` fork policy; `init` may then override it with
`tx.doc(ConversationConfig, id)`. Other documents follow their own definitions
without special handling.

Raw `tx.createConversation()` and `tx.forkConversation()` remain available.
They write no configuration of their own; a conversation without a configuration
document reads as `ConversationConfig.definition.initial()` until something
writes it. Callers that want Harness defaults use the Harness conveniences or
write the document in the same commit.

The built-in conversation configuration document is final at version 1:

| field | value |
|---|---|
| kind | `pi.conversation.config` |
| version | `1` (no migration) |
| scope/history/fork | conversation, `rewindable`, `asOf` |
| schema | `ConversationConfigState` |
| `initial()` | `{ thinkingLevel: "off", activeTools: [] }` |
| checkpoint | complete base on every change |
| view mount | `docs["pi.conversation.config"]` |

It has no prompt sections: prompt text is produced per request by the registry
(section 7.4). Any code may edit it with
`tx.doc(ConversationConfig, id)`, including in the same commit as a create or
fork. The getters return immutable committed values, falling back to
`initial()` when the document is absent; they never write. Each setter performs
one ordinary Session commit against the document. A setter does not start
generation or append a system entry. Request preparation later compares the
desired configuration with transcript history and appends the required
positional system baseline or delta.

Default active tools for a root or independent conversation are the names of
every tool registered when its creation commit runs, in registry order.
`setActiveTools()` rejects the whole operation without a write when a name is
duplicated or when a name that was not already active in that conversation is
not registered. The create/fork conveniences check only one thing about `init`
writes: names that `init` newly activates must be registered. Names that were
already active are never revalidated, so stale unregistered names survive every
edit. All other raw document writes are trusted and unchecked, so other writers,
such as post-tools `addTools`, never fault because of registry movement. Readers tolerate what raw
writes can produce: request preparation offers the first occurrence of a
duplicated name, and post-tools `addTools` appends only names not already
active.

`init` runs after the conversation creation, which is a table write, so table
reads inside it throw `ReadAfterWrite` (section 4). Document access remains
available.

The configuration document records the desired loadout; the registry records
what this process can execute now. An active name may therefore be unregistered,
for example during extension reload, after restart before registration, or in a
fork opened by a process that lacks an extension. The document is never
rewritten because of registry movement, so a re-registered tool becomes available
again without host action. Hosts derive current availability as active names
that are currently registered.

A missing tool implementation never fails a request. Request preparation offers
only active names that are currently registered. If the replayed tool state still
offers an unregistered name, the appended system delta lists it in
`toolsRemoved`; when the name is registered again, a later delta adds its current
declaration. When the model calls a tool that is not offered or whose
implementation is unavailable at execution time, the tool task appends an error
tool result with `details: { code: "tool_unavailable" }` stating that the tool is
not available, and the turn continues so the model can react.

A `Conversation.commit()` is a Session commit bound to that conversation.
`tx.createTask()` defaults `TaskOptions.conversationId` to the bound conversation.
`Conversation.entries()` binds the query to that conversation and paginates its
fork-aware stored history; callers cannot substitute another conversation ID.
Generic Session-wide document operations remain available directly on `Harness`
because `Harness extends Session`.

`fork()` requires a concrete visible parent entry and explicit ownership, then
applies section 3.7.
`collapse()` returns the newly admitted background collapse task ID, not its
future summary entry. `reset()` durably admits a passive self-head reset or
handoff write and then resolves; while busy, placement follows section 6 and may
occur later. Observe its placement through the conversation watch. An idle wait
does not guarantee placement of queued passive writes.

`abortTask()` commits `abortRequested` and the durable foreground-subtree
cascade, then signals and joins the active run; the scheduler then starts the
abort invocation. Marking without signalling is internal: the cascade marks
owned tasks in the same commit. `Conversation.abort()` withdraws queued
input submissions, marks non-background tasks selected by ordinary ownership
traversal, signals them, and resolves only after that scope is ordinarily idle.
Passive writes and background subtrees survive. Conversation idle means no live
non-background task selected from that conversation. Harness idle applies the
same traversal from every ownerless conversation root. Pending dependency- or
deadline-blocked work is still live and therefore not idle. Cancelling an idle
wait aborts only that waiter.

Conversation handles are stateless; compare them by `id`. Hosts discover
conversations through lookups and scans. An activity view that lists active
conversations and reports conversations becoming active or idle is specified
with turn control (Package 17); there is no creation listener.

`submit()` returns after durable admission, not settlement. An input submission
creates a user message with the admission timestamp; `whenBusy` defaults to
`followUp`. A write submission uses the ordered passive path in section 6 and
never starts generation. `Submission.wait()` settles an input only after its
answer or terminal failure; it settles a write when the entry is placed or the
write becomes terminally unplaceable. Cancelling `wait()` only cancels that wait.
It does not withdraw the submission; `Submission.abort()` is the explicit queued
withdrawal operation. `Harness.submission()` reacquires a submission after
reopen; records remain queryable after settlement.

`abortTask()` durably requests cancellation and returns `marked` after the mark
is committed, any active run invocation has joined, and an abort invocation has
been scheduled, or a blocked task has been settled as `orphaned` (section 5.4);
it does not await terminal settlement. `waitForTask()` observes
the terminal receipt. Aborting an already terminal task returns `terminal`; an
unknown ID rejects. Explicit task abort includes a background task. Cancelling a
task or idle wait does not abort work.

`Conversation.viewState()` returns its current structural mount as a disposable
read-only Chord state. `Conversation.watch()` atomically captures that immutable
revision and registers for later exact complete-commit frames. Its `WatchHandle`
uses the same serialized asynchronous, bounded-buffer contract as `watchDoc()`
in section 9.2. Neither carries semantic events or owns a second persistence
authority.

`close()` seals mutation admission and
task reservation, signals invocations, and stops future watch deliveries. Outside
the Session line it lets already-admitted storage commits settle, joins
task/tool/hook invocations, then closes states and storage. Already-running watch
callbacks remain caller-owned and may finish independently. Close writes no task
outcome. Handles belong to that open Harness and must be reacquired after reopen.

## 3. Documents

### 3.1 Definitions

Scope directly determines document ownership and lifetime. Only conversation
documents declare history and fork behavior.

```ts
type LatestConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "latest";
  readonly fork: "current" | "initial";
};

type RewindableConversationSemantics = {
  readonly scope: "conversation";
  readonly history: "rewindable";
  readonly fork: "asOf" | "current" | "initial";
};

type DocumentSemantics =
  | { readonly scope: "session" }
  | LatestConversationSemantics
  | RewindableConversationSemantics
  | { readonly scope: "task" };

type CheckpointInfo = {
  /** Deltas already stored after the newest base, excluding this change. */
  readonly deltasSinceBase: number;
};

type CommonDocDefinition<T extends JsonObject> = {
  readonly kind: string;
  readonly version: number;
  initial(): T;
  migrate?(value: JsonObject, fromVersion: number): T;
  checkpointWhen?(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

type DocDefinition<T extends JsonObject> =
  CommonDocDefinition<T> & DocumentSemantics;

type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> =
  Omit<CommonDocDefinition<T>, "initial"> & DocumentSemantics & {
    readonly family: true;
    initial(seed: I): T;
  };

declare const docType: unique symbol;
interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
  readonly definition: D;
  readonly [docType]?: T;
}
interface DocFamilyToken<
  T extends JsonObject,
  I extends JsonValue,
  D extends DocFamilyDefinition<T, I>,
> {
  readonly definition: D;
  readonly [docType]?: T;
}

type SessionDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "session" }
>;
type ConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & RewindableConversationSemantics
>;
type TaskDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & { readonly scope: "task" }
>;

type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;

function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "session";
    initial(seed: I): T;
  },
): SessionDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & LatestConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): ConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & RewindableConversationSemantics & {
    readonly family: true;
    initial(seed: I): T;
  },
): RewindableConversationDocFamilyToken<T, I>;
function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: Omit<CommonDocDefinition<T>, "initial"> & {
    readonly family: true;
    readonly scope: "task";
    initial(seed: I): T;
  },
): TaskDocFamilyToken<T, I>;
```

Validation rules:

- Versions are positive integers.
- Typed access rejects when the token's scope or conversation history/fork policy
  disagrees with the persisted incarnation. A migration cannot reinterpret those
  lifetime semantics.
- Session documents are current-only and belong to the Session. Closing and
  reopening the Session does not retire them.
- Conversation documents declare `history` and `fork`; `fork: "asOf"` requires
  `history: "rewindable"`.
- Task documents are current-only, are never copied by a conversation fork, and
  retire atomically when their task becomes terminal.
- `initial()` and `migrate()` return JSON objects.

`checkpointWhen()` only selects complete storage bases to bound replay. It does
not change scope, lifetime, history, or fork semantics.

Concrete built-in document grouping and semantics are declared when the built-in
definitions are implemented. The generic document mechanism does not special
case model, tool, inbox, or presentation state.

### 3.2 Records and lifetimes

A persisted document instance has one `DocumentRecord`:

```ts
type DocumentRecord = {
  readonly id: DocumentId;      // unique incarnation
  readonly kind: string;        // stable definition kind
  readonly key?: string;        // families only
  readonly createdAt: Seq;      // stamped by the committing storage
  readonly retiredAt?: Seq;
} & (
  | { readonly scope: { readonly kind: "session" } }
  | ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
      | { readonly history: "latest"; readonly fork: "current" | "initial" }
      | {
          readonly history: "rewindable";
          readonly fork: "asOf" | "current" | "initial";
        }
    ))
  | { readonly scope: { readonly kind: "task"; readonly taskId: TaskId } }
);

type DocumentCreate = DocumentRecord extends infer Record
  ? Record extends DocumentRecord
    ? Omit<Record, "createdAt" | "retiredAt">
    : never
  : never;
```

`id` is never reused. Retiring and recreating the same logical kind, scope, and
family key creates a new incarnation. Membership is the half-open interval
`createdAt <= at < retiredAt`; an unretired incarnation has no upper bound. A
creation retired in the same commit has an empty lifetime.

A singleton is identified logically by kind and scope. A family is identified
logically by kind, scope, and `key`. The record preserves scope and conversation
history/fork semantics so unavailable extension code does not make existing data
disappear. Definition versions belong to stored bases and deltas because one
incarnation may contain records written by multiple definition versions.
`DocumentCreate` is not another persisted record; it is the same scoped union
without storage-assigned lifetime fields.

### 3.3 Access and creation

There is no mutable `session.document()` API.

```ts
interface Session extends DocumentObserver {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
  close(context: Context): Promise<void>;
  subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void;
  subscribeClose(listener: () => void): () => void;

  snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<Readonly<T> | undefined>;

  snapshotAsOf<T extends JsonObject>(token: RewindableConversationDocToken<T>, conversationId: ConversationId, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;
  snapshotAsOf<T extends JsonObject, I extends JsonValue>(token: RewindableConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, at: EntryId, context: Context): Promise<Readonly<T> | undefined>;

  documentState<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
  documentState<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentState<T> | undefined>;
}

interface Tx {
  conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
  entry(id: EntryId): Promise<EntryRecord | undefined>;
  task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor): Promise<Page<ConversationRecord, Cursor>>;
  scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
  scanTasks(query: TaskQuery, limit: number, cursor?: Cursor): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
  forkConversation(
    parentConversationId: ConversationId,
    at: EntryId,
    options: { readonly ownership: ConversationOwnership },
  ): Promise<ConversationRecord>;
  appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
  createTask<I, S extends { phase: string }, R, H extends object>(
    task: Task<I, S, R, H>, input: I, options?: TaskOptions,
  ): Promise<TaskId<R>>;

  doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
  doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, seed: I): Promise<Draft<T>>;
  doc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, seed: I): Promise<Draft<T>>;

  retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
  retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
  retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string): Promise<void>;
  retireDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string): Promise<void>;
}
```

ID-creating transaction methods are asynchronous because remote storage may
allocate globally unique numeric IDs durably. Conversation creation always
requires explicit ownership; no transaction wrapper injects the executing task.
For task ownership, the caller supplies only a typed task ID. The Session derives
the persisted owner conversation from the task's final candidate record.

An owner task may be committed or staged earlier in the same transaction. Before
Storage admission, the Session rejects a missing, terminal, or abort-marked owner,
including one made terminal or abort-marked later in that transaction. Existing
owner edges remain valid when their owners terminalize afterward. Conversation
creation returns an inert record, never an operational handle.
`forkConversation()` additionally validates one visible entry and applies section
3.7. Only public typed `tx.doc()` is get-or-create. Internal fork copying may create
new incarnations directly from stored values without a definition. `tx.doc()`
receives the definition token that supplies
its static type, initializer, migration, and checkpoint policy. Scope-preserving
token overloads require callers to supply only the concrete conversation/task ID
and, for a family, its key and creation seed. Ordinary definitions are not
registered and ordinary documents are not scanned at open.

- Existing instances are reconstructed and migrated lazily according to section
  3.6. A migration reached through `tx.doc()` is staged in its enclosing
  transaction.
- A missing singleton calls the token's `initial()`. A missing family member calls
  `initial(seed)`. Creation stores an initial base.
- The first acquisition of one logical address is memoized before awaiting. Later
  acquisitions in that transaction return the same draft; for a missing family,
  the first call's detached seed wins and later seeds are ignored.
- `snapshot()`, `snapshotAsOf()`, `documentState()`, and `watchDoc()` never create
  or persist migration. They return `undefined` when the requested incarnation is
  absent and migrate a reconstructed value only in memory.
- Task-scoped `tx.doc()` validates against the transaction's latest candidate task
  record, falling back to committed state. This internal validation is not a
  caller table read and does not trigger `ReadAfterWrite`. Its conversation is
  derived from the task record.
- `retireDoc()` resolves the logical address without creating it. Retirement of
  an acquired draft persists its final content before retirement. A later
  `tx.doc()` at that address in the same transaction creates a new incarnation
  with a new draft and ID.
- A terminal candidate rejects later task-document access. Terminal settlement
  retires both existing task documents and task documents created earlier in the
  same transaction.
- `snapshot()` returns the current shareable immutable revision. Mutation of it
  or any retained descendant is unsupported; callers that need mutable ownership
  must copy it first.
- `documentState()` returns a disposable read-only Chord state bound to one committed incarnation.
- `tx.doc()` returns one revocable Astra overlay `Draft<T>` for the transaction.
- Historical reads never create documents in the past.

`snapshotAsOf()` is available only for rewindable conversation documents. It
validates that `at` is visible through the requested conversation's ancestry,
selects the ancestor conversation that owns that entry, then finds the logical
singleton/family incarnation whose creation/retirement interval contains the
entry's commit. It never starts from today's incarnation and never creates an
instance. It returns `undefined` when no such instance existed.

After `B` forks `A` at entry `E`, asking for `B`'s state at inherited `E` reads
`A`'s historical instance; `B`'s copied incarnation was created later. If an
instance was retired and recreated, historical lookup selects the incarnation
alive at the target commit.

### 3.4 Mutation ownership

Pico uses Chord Delta's Astra-immutable transaction shape directly:

```ts
interface Prepared<T extends object> {
  readonly base: T;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly baseRevision: number;
  abort(): void;
}
interface Change<T extends object> {
  readonly state: Draft<T>;
  prepare(): Prepared<T>;
  abort(): void;
}
interface Tracker<T extends object> {
  readonly value: T;
  readonly revision: number;
  beginChange(): Change<T>;
  prepareReplace(value: T): Prepared<T>;
  adopt(prepared: Prepared<T>): void;
}
```

Each loaded document owns one tracker whose `value` is its current immutable
revision. Immutability is a trusted ownership contract, not runtime freezing:
a revision and its descendants must never be mutated after transfer to the
tracker. `prepare()` revokes the draft, emits detached self-contained
operations, and computes `value` with the optimized immutable applier before
Storage admission. Unchanged subtrees are structurally shared with `base`.
Operation placement payloads may also be shared with `value`; mutating either a
prepared operation or an immutable revision is unsupported. Astra preserves an
empty operation batch for changes it proves are no-ops, but Pico performs no
additional whole-value equality pass for nonempty structural batches.

`abort()` is idempotent. `adopt()` accepts only a prepared result from that
tracker at its current revision, then performs only a synchronous pointer swap
to the already-computed immutable `value`. It performs no diffing, application,
allocation, or callback. The Session line permits at most one open change per
tracker and ensures no result becomes stale between preparation, Storage
settlement, and adoption.

The first `tx.doc()` acquisition calls `tracker.beginChange()` and memoizes that
change's draft for the rest of the possibly async Session callback.

Transaction behavior:

```text
begin transaction
  acquire and memoize document changes by logical address
  mutate revocable Astra overlay drafts
callback settles
  seal Tx; synchronously prepare or abort every open change, revoking every draft
  if any acquisition is pending: abort open changes, reject, then drain and abort it
callback fails with no pending acquisition
  abort every open change; persist and publish nothing
callback succeeds with no pending acquisition
  prepare every open change -> immutable next revision + self-contained Chord Op[]
  Session evaluates each required/ordinary document write exactly once
  prepare every affected loaded conversation mount revision
  Storage.commit persists the atomic batch while the Session line remains held
storage succeeds
  adopt every prepared change by pointer swap and enqueue immutable revision/ops publication
  release the line; invoke listeners later
storage fails
  abort every prepared change, poison Session, and publish nothing
```

A pending acquisition that resolves after sealing never exposes a draft; its
change is aborted and its promise rejects. The Session observes every such
settlement before releasing the line. Initializer, migration, and replacement
roots come from caller code: the Session copies each one into exclusive kernel
ownership, rejecting any value that is not strict JSON, before it becomes an
immutable tracker revision. Loaded and fork-copy roots are already detached
strict JSON from Storage and enter the tracker without another copy. Chord's
`track()` and `prepareReplace()` take ownership in O(1) without traversal, so
every root they receive must come from one of these sources. Migration callbacks
never receive a live tracker revision.

Preparation, validation, checkpoint, or mounted-view preparation failure occurs
before Storage admission and rolls back normally. The Session performs no
strict-JSON walk of prepared operations or selected bases: roots are checked on
entry and Chord checks every draft placement, so every revision, operation
payload, and base is strict JSON by construction. Tracker branding and `baseRevision` enforce ownership and staleness; the
Session never substitutes caller-created prepared values. The prepared immutable
candidate itself becomes the adopted and published value. Storage receives that complete value only when the
Session selects a base; otherwise it receives only the prepared operation batch.
An existing current-version document with an empty batch writes and publishes
nothing. A nonempty structural batch whose final value is deeply equal to its
base remains a valid durable change and publication. Creation and required
version transitions still write a base when their prepared batch is empty; an
equal-value version base does not emit a watch update.

Values assigned into a draft are copied immediately by value. Repeated
placements are independent. Chord checks each placement while copying it and
throws at the offending assignment, before the draft changes, when the value is
not strict JSON: `undefined` array elements or nested object values, non-finite
numbers, functions, symbols, bigints, accessors, symbol keys, sparse arrays, or
objects whose prototype is neither `Object.prototype` nor `null`. Assigning
`undefined` directly to an object property deletes that property. Draft reads, draft writes, and all `Tx` operations
reject after the callback settles. The prepared immutable value remains readable
by Session-owned checkpoint and Storage preparation.

```ts
let escaped: Draft<LiveState>;
await session.commit(async tx => {
  escaped = await tx.doc(LiveDoc, conversationId);
});
escaped.message = message; // throws: the draft was revoked
```

Fire-and-forget work that mutates a draft before the owner callback settles may
silently enter that transaction and is unsupported.

### 3.5 Bases and checkpoints

Creation always stores a complete base.

For an ordinary later mutation, the definition alone decides whether the
storage record is a base:

```ts
const useBase = definition.checkpointWhen?.(candidateValue, ops, { deltasSinceBase }) ?? false;
```

The Session evaluates this predicate exactly once after tracker preparation.
`deltasSinceBase` counts the deltas already stored after the incarnation's newest
base, excluding the change being evaluated. Storage reports it when it
materializes the current value; the Session advances it after each adopted write
and resets it after every base, so evaluation performs no Storage read.
Creation and version transitions require bases and do not call it. The Session
then gives Storage only the selected representation:

```text
required or predicate true -> base with complete value
otherwise                  -> delta with the prepared Chord operation batch
```

A Chord root-replacement operation remains a delta unless the definition selected
a checkpoint; it does not authorize reclamation. Predicate failure aborts the
prepared transaction before Storage admission. Storage executes no definition
code and never receives an unused complete candidate with a selected delta.

- For Session, task, and latest conversation documents, a committed base permits
  physical reclamation of older records.
- For rewindable conversation documents, bases bound replay but never permit
  removal of addressable history.
- A definition that never checkpoints may create an unbounded replay tail. That
  is a definition bug, not a backend heuristic.
- Storage does not count encoded bytes, compare against `initial()`, or invent
  checkpoints.

A definition can bound replay directly:

```ts
checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31
```

A high-churn live document can checkpoint when it becomes empty:

```ts
checkpointWhen: (value, _ops) =>
  value.message === undefined &&
  value.tools.length === 0
```

### 3.6 Versions and migrations

One migration callback handles every supported older version.

```text
stored == token -> use value
stored < token  -> call migrate(value, storedVersion)
stored > token  -> reject typed access
no migrate      -> reject older stored version
```

`migrate()` is pure and returns a complete current-version value. Migration is
access-driven: `tx.doc()`, `snapshot()`, `snapshotAsOf()`, `documentState()`, and
`watchDoc()` reconstruct and migrate through the token supplied to that call.
Harness open does not sweep ordinary documents.

- Read-only access migrates only in memory and never writes. It may cache a
  tracker over that migrated immutable revision together with the older stored
  version marker; the next successful `tx.doc()` access still writes the required
  current-version base. A cached tracker serves only tokens of the version its value was
  materialized for. Access with any other version, such as a token from reloaded
  extension code, drops it and reloads the stored value, so each token migrates
  from the stored version or rejects a newer one. Migration always starts from a detached stored value.
  `tx.doc()` stages migration in its enclosing transaction; callback failure
  persists nothing, and later draft edits coalesce into one final required base.
- Rewindable history is not rewritten. Current and historical reconstructed
  values are migrated after replay.
- The first `tx.doc()` transaction after any stored-version migration writes a
  required current-version base, even when the migrated JSON is deeply equal.
- A fork obtains the selected stored value/version from Storage rather than a
  typed migrated tracker cache. The child copies that stored pair and migrates on
  later typed access.
- Unaccessed documents and documents with unavailable definitions preserve their stored instances,
  versions, and bytes.

### 3.7 Forks

A conversation fork points to one concrete visible entry `E`.

The child transcript includes entries through `E`, even if the same commit also
appended later entries. Document state at `E` is the final state of the commit
containing `E`. Different document states require separate commits.

Each conversation document follows the history/fork policy persisted in its
`DocumentRecord`:

| conversation setting | child value |
|---|---|
| `fork: "asOf"` | parent value at `E`'s commit |
| `fork: "current"` | committed parent value selected when the fork commit runs |
| `fork: "initial"` | no copied instance; initializer on first child access |

`current` and `asOf` copy logically present conversation singleton and family
instances, preserving unknown definitions and their stored versions. Copied
values become independent child instances with new IDs and initial bases.
`initial` copies no instance; first access in the child creates it from the
supplied definition. Task documents and tasks are never copied. Session documents
remain shared and are not rewindable.

Fork copying reads committed stored values rather than typed tracker caches. A
transaction that creates a fork therefore rejects if it also writes one of the
parent's `fork: "current"` documents; commit the parent change first so the fork
has one unambiguous stored source revision.

Forks stage backend-side `document.copy` commands carrying the child create
record and an exact source incarnation/point. Storage materializes each source
and persists its stored value/version as the child's independent initial base;
remote Storage performs this server-side. Every copy reads committed pre-batch
source state independent of write-array order. A selected source may not be
created, changed, or retired in the same batch. Copying remains atomic with the
conversation, overrides, registry writes, and other mutations.

An unaccessed copy retains only its descriptor in Session memory. Typed access
inside the creating transaction lazily reads the detached source, migrates when
required, and replaces the copy with one ordinary child create containing the
final prepared value. Definition-free copies publish explicit `document.copy`
metadata rather than a value. That metadata announces Storage-backed initial
state and is never interpreted as a document value. Document states, watches,
and mounted views hydrate by capturing their baseline and subscription
atomically on the Session line: a later commit already present becomes the
baseline, while one committed after registration is delivered. Publications
and watches are convergence mechanisms, not audit streams. A mounted aggregate
must acquire all of its document baselines and commit subscription in one
Session-line operation so it never exposes a mixture from one commit.

## 4. Transactions and storage ownership

A Session commit callback may be asynchronous. It owns the Session mutation
line through callback execution, preparation, storage settlement, committed
baseline adoption, and publication enqueue. Commit observers run on the
line; document-state and watch user callbacks run later.
External model, process, tool, network, and human effects run outside it.
`subscribeCommits()` observes complete immutable publications synchronously on
the line after adoption. `subscribeClose()` observes close synchronously when it
begins, after admission is sealed; the Harness stops watches and signals task
invocations there. Both return idempotent disposers; their listeners must not
throw, block, or call Session APIs. Document-state subscribers and watch
listeners still run later, off the line.

```ts
await session.commit(async tx => {
  const conversation = await tx.conversation(conversationId); // table read
  const live = await tx.doc(LiveDoc, conversationId);

  await tx.appendEntry(conversationId, message);     // first table write
  delete live.message;                               // document mutation remains valid
  await tx.createTask(Follow, { after: message.id }); // further table writes are fine
}, context);
```

Mutation admission occurs on the Session line before a commit callback starts. Closing seals mutation admission and task
reservation. Already-admitted commits settle before storage closes. Once a
commit is admitted, caller cancellation does not interrupt storage settlement or
undo the commit. Cancelling a close wait does not reopen admission.

Table rules:

- Tables are conversations, entries, tasks, and submissions.
- Table reads are allowed before the first table write.
- Any table read after the first table write throws `ReadAfterWrite`.
- Document access and read-your-writes remain available after table writes.
- Creation methods return their created ID/record; callers do not read it back.

Storage ownership:

- Commit arguments are borrowed until `Storage.commit()` settles.
- Anything retained after settlement is detached first.
- Memory storage recursively copies retained JSON containers.
- JSONL and SQLite detach through serialization and decoded indexes.
- Every storage read returns a detached JSON value.
- Immutable strings may be shared; mutable arrays and objects may not.

## 5. Tasks

### 5.1 Definition

```ts
type TaskOutcome<R> =
  | { readonly status: "completed"; readonly result: R }
  | { readonly status: "failed"; readonly error: TaskOutcomeError; readonly result?: R }
  | { readonly status: "aborted"; readonly reason?: string; readonly result?: R }
  | { readonly status: "orphaned"; readonly reason: string }
  | { readonly status: "faulted"; readonly error: TaskOutcomeError };

type TaskState<S, R> =
  | { readonly status: "pending"; readonly checkpoint: S }
  | { readonly status: "running"; readonly checkpoint: S }
  | { readonly status: "terminal"; readonly outcome: TaskOutcome<R> };

type TaskRecord<I, S, R> = {
  readonly id: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly kind: string;
  readonly version: number;
  readonly input: I;
  readonly after: readonly TaskId[];
  readonly background: boolean;
  readonly abortRequested: boolean;
} & (
  | {
      readonly state: Extract<TaskState<S, R>, { status: "pending" | "running" }>;
      readonly memos?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly state: Extract<TaskState<S, R>, { status: "terminal" }>;
      readonly memos?: never;
    }
);

type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
  readonly state: Extract<TaskState<S, R>, { status: "running" }>;
};

/** State a task commits for itself: a replacement checkpoint or its terminal outcome. */
type NextTaskState<S, R> = Extract<TaskState<S, R>, { status: "running" | "terminal" }>;

interface HookRunner<H extends object> {
  each<K extends keyof H>(name: K, invoke: (handler: H[K]) => void | Promise<void>): Promise<void>;
}

type PhaseHandler<I, P, S, R, H extends object> = (
  task: RunningTask<I, P, R>,
  runtime: TaskRuntime<I, S, R, H>,
  context: Context,
) => Promise<void>;

interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver {
  readonly taskId: TaskId<R>;
  readonly conversationId: ConversationId;
  readonly signal: AbortSignal;
  /** Registry snapshot of the current phase; refreshed at every phase boundary. */
  readonly registry: RegistrySnapshot<ToolRegistration>;
  readonly models: Models;
  readonly hooks: HookRunner<H>;

  commit(
    change: (
      tx: Tx,
      current: RunningTask<I, S, R>,
    ) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
    context: Context,
  ): Promise<void>;

  memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  sleep(until: number, context: Context): Promise<void>;
}

type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
  readonly name: string;
  readonly version: number;
  initial(input: I): S;
  readonly phases: {
    [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
  };
  abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
  migrate?(input: JsonValue, checkpoint: JsonValue, fromVersion: number): {
    input: I;
    checkpoint: S;
  };
  readonly hooks?: H;
};

interface Task<I, S extends { phase: string }, R, H extends object> {
  readonly definition: TaskDefinition<I, S, R, H>;
}

type TaskOptions = {
  readonly conversationId?: ConversationId;
  readonly after?: readonly TaskId[];
  readonly background?: boolean;
};

function defineTask<I, S extends { phase: string }, R, H extends object = {}>(
  definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H>;
```

`TaskId<R>` is the numeric task ID itself with an erased result-type brand. It
replaces a separate task-reference wrapper: `createTask()` returns `TaskId<R>`,
typed waits infer `R` from that ID, and result-agnostic operations accept
`TaskId<unknown>`. A task's `conversationId` is immutable after creation; a
replacement that moves an existing task to another conversation rejects before
Storage admission so persisted conversation-owner edges cannot become stale.

The phase map is exhaustive and phase-narrowed. A handler may perform several
commits around one effect, but each durable checkpoint is a full replacement.
`TaskRuntime.commit()` rereads and gates the current durable task on the Session
line before invoking its callback. It rejects when the invocation has ended, the
Harness is closing, the task is terminal, or a run invocation's task carries an
abort mark. Its `tx.createTask()` defaults to the task's conversation. When the
callback returns a state, the runtime replaces the task's state in the same
commit, so the checkpoint or outcome is atomic with the callback's entries,
documents, and child tasks and is type-checked against the task's checkpoint and
result types. Returning nothing leaves the state unchanged. A terminal state
drops the memos. `pending` is never returned; only reconciliation and handover
write it.

`Tx` has no task replacement operation. A task changes only its own state,
through its runtime. The scheduler owns reservation, reconciliation, handover,
faults, and orphaning; `abortTask()` owns abort marks. Other code
stops a task with `abortTask()` and reads its result with `waitForTask()`.

```ts
// Intent, effect, outcome.
prepare: async (task, runtime, context) => {
  await runtime.commit(() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }), context);
},
charge: async (task, runtime, context) => {
  const receipt = await payments.charge(task.state.checkpoint.key); // idempotent by key
  await runtime.commit(async (tx, current) => {
    const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
    return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
  }, context);
},
// The abort handler decides the outcome; returning without one faults the task.
abort: async (task, runtime, context) => {
  await payments.cancel(task.state.checkpoint);
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }), context);
},
```
`memo(name, candidate)` is one gated commit; `memo(name)` reads the committed
record. `sleep(until)` compares against the Harness `now` clock and rejects when
the invocation is signalled or its context is cancelled. Watches acquired through
the runtime stop when the invocation ends.

Reservation durably changes `pending` to `running`. One invocation runs phase
handlers in sequence; checkpoint commits retain `running`. Before every phase,
including the first, the scheduler runs one synchronous step callback on the
Session line. It reads the committed task, applies the first matching rule
below to the phase that just returned, writes any fault or handover in the same
commit, and ends the invocation there when a rule stops it. A runtime commit the
invocation queued earlier therefore either lands before the step and counts, or
reaches the line after it and rejects. Before the first phase only rules 1–3
apply:

1. Terminal: stop.
2. Session closing: stop; preserve the checkpoint and any abort mark for reopen.
3. Run mode with a durable abort mark: end and join the run invocation, then
   dispatch a fresh abort invocation.
4. Uncaught error: write terminal `faulted`.
5. Checkpoint changed, including progress within the same phase: refresh the
   registry snapshot and either hand over (section 5.4) or invoke the phase
   handler in the same task invocation.
6. Checkpoint unchanged: write terminal `faulted` because no durable progress
   was made.

An abort invocation runs its abort handler once. After it settles, a step
applies rules 1, 2, and 4; a handler that returns without a terminal outcome
faults the task. When Storage rejects a step's fault or handover write, the
invocation still ends; the task stays `running` and the next reservation runs it
again.

On open, running-task reconciliation changes surviving `running` tasks back to
`pending`, preserving their checkpoint and abort mark. Task migration runs at
reservation, atomically with `pending -> running`. One callback handles every
supported older version. A task whose definition is missing, older than the
stored version, or fails migration stays `pending` and blocked until a fitting
definition is registered or the task is aborted (section 5.4).
`close()` marks the runtime closing, seals admission and reservation, signals
invocations, and stops watches. Outside the Session line it settles admitted
commits and joins invocations before closing storage. Already-running watch callbacks remain
caller-owned. Later runtime commits reject, and close writes no task outcome. Closing
starts no fresh phase or abort invocation. It does not set abort marks,
terminalize tasks, retire task documents, or publish document retirement. The
hosting layer withdraws services and
detaches clients; reconnecting to a reopened Session hydrates the last committed
state and resumes recovery from its durable checkpoints.

### 5.2 Effect sandwich

```text
commit intent phase
perform external effect
commit outcome or next phase
```

Reopening in an intent phase means the effect may have happened. The phase
handler retries safely, polls an external handle, or records interruption.
Deferred providers are represented by a durable phase containing their handle
and next poll time.

Runtime-owned memos are small first-writer-wins values stored in the live task
envelope. Candidate insertion and reading the winner are one Session commit, so
concurrent candidates return the same durable winner. Memos survive checkpoints
and disappear in the terminal replacement. Bulk progress belongs in a document.

### 5.3 Terminal tasks and dependencies

The terminal task record is the durable result receipt. Its result may directly
contain a small value or reference an entry:

```ts
{ status: "completed", result: { entryId: toolResultId } }
```

A terminal transition atomically:

1. Writes the terminal task record.
2. Appends any result entries.
3. Retires all documents scoped to that task.
4. Resolves any submissions settled by the task.

The execution checkpoint and memos disappear from the terminal representation.
Terminal records remain queryable for dependencies, waiters, inspection, and
reopen. A normal run becomes eligible when every `after` task is terminal. An abort
mark bypasses dependencies so pending work can always reach its abort handler,
or its `orphaned` settlement when its definition is unavailable.

### 5.4 Scheduler, abort, and ownership

The scheduler serially reserves eligible tasks, then runs handlers off the
Session line. One in-memory `TaskInvocation` contains mode, abort controller,
and completion promise.

Abort protocol:

```text
commit abortRequested
signal and join active run invocation
start a fresh abort invocation
abort handler commits terminal outcome
```

A run invocation may not commit after its durable abort mark appears. Every
runtime operation rejects after its owning invocation ends, even while the
Session remains open. Returning from one phase handler does not end an invocation
that continues into another phase. Invocation mode is volatile and derived from
the durable mark on reopen. Cancelling one caller's `Context` only cancels
that call or wait; it does not durably abort shared work unless the invoked API
commits an abort mark.

A task may create owned conversations. Conversations are durable scopes; tasks
are the units of live work counted by idle and marked by abort. History parents
are irrelevant to ownership traversal.

Ordinary traversal starts at an explicitly addressed conversation, visits its
tasks, and follows conversations owned by each non-background task. It follows
owner edges after the owner becomes terminal, but a background owner is a
boundary: ordinary traversal skips that task and its complete owned subtree.
Direct conversation operations start inside that conversation regardless of its
owner. Directly aborting a live background task includes that task and follows
its ordinary owned subtree; nested background owners remain boundaries. Full
teardown crosses every boundary, marks every live task, and must seal new
admission while it gathers the complete indexed ownership subtree.

`Conversation.abort()` withdraws queued inputs and marks live non-background
tasks selected by ordinary traversal. `Conversation.waitForIdle()` waits until
that traversal contains no live non-background task. Harness idle performs the
same traversal from every ownerless conversation root rather than globally
counting tasks, so ordinary work below a background owner does not block it.
Explicit `waitForTask()` waits for its referenced task regardless of the task's
background flag.

An abort mark atomically and idempotently cascades to foreground-owned work,
including conversations, tasks, and submissions staged in the same transaction.
Terminal outcomes `failed`, `faulted`, `orphaned`, and `aborted` record the same
durable cancellation intent; `completed` does not. Conversation records and
owner edges are never retired with the task. Active invocations are signalled
after commit, and a terminal receipt guarantees durable cancellation intent,
not descendant quiescence.

Every run invocation start resolves the task's definition by `TaskRecord.kind`
from the scheduler's current registry snapshot:

```text
definition missing                 -> stay pending, blocked: missing_task
stored version newer than it       -> stay pending, blocked: task_too_old
stored version older than it       -> migrate(input, checkpoint, storedVersion)
  failure                           -> stay pending, blocked: migration_failed
  success                           -> commit migrated record + running atomically
equal version                       -> commit running
```

An abort invocation resolves the definition the same way. When the definition
can take the task, its abort handler runs; otherwise the task is orphaned as
described below.

A failed migration is reported once through `onReport` and retried only after
the registry resolves a different definition object for the task's kind.

The Harness never terminalizes a task merely because registry code is missing or
incompatible, neither at open nor later. A blocked task without an abort mark
keeps its durable record unchanged, remains live, still blocks ordinary idle
waits, and is reconsidered whenever the registry changes. The blocked reason is derived
runtime state, not a persisted task status. Document migration remains
access-driven.

Aborting a blocked task cannot run its abort handler, because that code is
missing or cannot take the task. The Harness therefore settles it as terminal
`orphaned` instead of `aborted`: `aborted` means the task's own abort handler
ran and decided the outcome, while `orphaned` means no task code ran, so external
effects the task started may remain uncleaned. The orphaned `reason` is the
blocked reason (`missing_task`, `task_too_old`, or `migration_failed`). When
`abortTask()` finds no active invocation and the current snapshot
cannot take the task, the marking commit settles it directly; otherwise the
scheduler settles it when it would reserve the abort invocation. Only an abort (direct, by
conversation, or by cascade) orphans a task; a missing definition alone never
does. The orphaning commit performs the cleanup the task's code cannot: affected
input submissions become unanswered with the reason, any matching active turn
control is cleared, and task-scoped documents retire. No transcript entry is
written; the terminal task record and unanswered submissions carry the reason.
Faulting a turn task performs the same control/submission cleanup with a
`faulted` outcome.

At every normal phase boundary (section 5.1, rule 5), the step refreshes the
invocation's registry snapshot. If the task definition resolved by name is a different object
than the one the invocation started with and the new definition can reserve the
task (same version, or a higher version with `migrate`), the invocation hands
over: the step commits the task back to `pending` with its checkpoint, memos,
and abort mark and ends the invocation, and the next reservation starts a fresh invocation under the new
definition, applying the reservation rules above. When the definition is missing
or cannot reserve the task, the invocation keeps running under its old
definition, reports once through `onReport` per resolved definition, and
reconsiders at its next boundary. A handler that
never settles never hands over.

## 6. Submissions and inbox

Submission records back awaitable host objects. Their record transitions use
Session-private transaction operations, not the public `Tx` interface. The inbox
itself is an ordered conversation document containing tagged items:

```ts
type InboxItem =
  | { readonly id: SubmissionId; readonly mode: "steer" | "followUp"; readonly message: Message }
  | { readonly id: SubmissionId; readonly mode: "write"; readonly entry: EntryDraft };
```

A built-in turn-control document has an optional `active` value naming the task
currently responsible for the turn and its placed input-submission IDs. `active !==
undefined` defines `busy`; get-or-create of the idle document does not. The
value remains active while generation, tools, and post-tools hand work to one
another.

Admission and terminal transitions:

| action | submission state | other writes |
|---|---|---|
| idle input submission | `placed`, with user entry | create turn controller/generation |
| busy input submission | `queued` | append steer/follow-up inbox item |
| idle write submission | `done`, with entry | append entry; no turn |
| busy write submission | `queued` | append write inbox item |
| boundary places user item | `placed`, with entry | add ID to current/successor turn |
| boundary places write | `done`, with entry | append entry |
| turn answers | input `done`, with required answer entry | clear/hand off turn controller |
| turn fails or aborts | input `unanswered`, with reason | clear/hand off turn controller |
| withdraw queued item | `unanswered`, reason `aborted` | remove inbox item |
| stale item | `unanswered`, reason `stale` | remove inbox item |

`requestId` deduplicates within one conversation before any write; reusing one
for the other submission type rejects. A busy input with `whenBusy: "reject"`
writes no record and reports `ConversationBusy`. Before an idle input places its
own entry, it runs a final boundary to drain older eligible queued items. A
`Submission` waits until `done` or `unanswered`; abort withdraws only a still-
queued submission, reports `already_placed` for a placed input, and reports
`settled` for any terminal submission. Conversation abort withdraws queued steer/follow-up submissions but keeps writes
for later placement.

Boundary selection is deterministic by item ID:

| boundary | write | steer | follow-up |
|---|---|---|---|
| `postTools` | all | first/all by mode | none |
| `final` | all | first/all by mode | first/all by mode |

A queued self-head write cuts older pending user items: those submissions become
stale, the write is placed, and the current turn terminates. Other head writes
whose target predates the caller's newest known head are stale.

At ordinary `postTools`, generation continues even with no queued trigger;
selected steer IDs join that continuation. A terminating/handoff post-tools
boundary uses final behavior instead. At `final`, the current turn's placed
input submissions settle first; selected user IDs start one successor generation. Writes
never trigger generation by themselves. A final boundary without continuation
or user triggers leaves the conversation idle.

Selected and stale items are removed positionally while retained item order is
preserved. Chord's Astra operation generator must express scattered removals
without carrying retained values; IDs are not substituted for positional inbox
semantics.

## 7. Registry, hooks, tools, and system prompt

### 7.1 Registry

Extension code reaches the Harness through one application-owned registry. The
registry is process-local, may outlive a Harness, and is the only place tools,
tool wrappers, hooks, tasks, and the system prompt are registered. Nothing
in it is persisted; durable state stays in conversations, entries, tasks, and
documents.

```ts
type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

interface Registration {
  /** Idempotent; removes exactly the registrations this token covers. */
  dispose(): void;
}

type ToolWrapper<Tool extends ToolRegistration> = (tool: Tool) => Tool;

type HookScope = {
  readonly conversationId: ConversationId;
  /** Also match conversations owned, transitively, by tasks of this conversation. */
  readonly subtree?: boolean;
};

type PromptInput<Tool extends ToolRegistration> = {
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

type PromptSection<Tool extends ToolRegistration> = {
  readonly key: string;
  render(
    input: PromptInput<Tool>,
    context: Context,
  ): string | undefined | Promise<string | undefined>;
  /** Default true: wrap the text as `<key>\n...\n</key>`. */
  readonly tag?: boolean;
};

type PromptSectionWrapper<Tool extends ToolRegistration> = (
  section: PromptSection<Tool>,
) => PromptSection<Tool>;

interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
  /** Immutable view of the whole current registry. */
  snapshot(): RegistrySnapshot<Tool>;
  /** Called synchronously after every publication; wakes the scheduler to reconsider blocked tasks. */
  subscribe(listener: () => void): () => void;
}

interface RegistrySnapshot<Tool extends ToolRegistration> {
  /** Composed tools in registry order; a tool whose wrapper failed is absent. */
  tools(): readonly Tool[];
  tool(name: string): Tool | undefined;
  /** Base tool names in registry order, including tools whose wrappers fail. */
  toolNames(): readonly string[];
  task(name: string): AnyTask | undefined;
  /** Hooks registered for tasks with `task`'s name, in registry order. */
  hooks<K extends AnyTask>(task: K): readonly {
    readonly handlers: Partial<HooksOf<K>>;
    readonly scope?: HookScope;
  }[];
  /** Composed sections in registry order; a section whose wrapper failed is absent. */
  sections(): readonly PromptSection<Tool>[];
  /** Wrapper failures of this state; the Harness reports them where it uses them. */
  failures(): readonly {
    readonly kind: "tool" | "section";
    readonly name: string;
    readonly error: unknown;
  }[];
}

interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
  readonly tools: {
    add(tool: Tool): Registration;
    wrap(name: string, key: string, wrapper: ToolWrapper<Tool>): Registration;
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
    section(
      key: string,
      render: PromptSection<Tool>["render"],
      options?: { readonly tag?: boolean },
    ): Registration;
    wrap(key: string, wrapperKey: string, wrapper: PromptSectionWrapper<Tool>): Registration;
    sections(): readonly PromptSection<Tool>[];
  };
  batch(register: () => void): Registration;
}

function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool>;
```

The `Tool` parameter lets applications attach metadata such as prompt snippets to
their tools; the Harness only relies on `ToolRegistration`. Pi-ai declarations
derived from a registered tool keep only pi-ai `Tool` fields (`toToolDeclaration`),
so application metadata never enters the transcript.

Registration rules:

- Tool names, section keys, and task names are unique among published
  registrations. Tool wrapper keys are unique per tool name, section wrapper
  keys per section key, and hook keys per task name. Duplicates reject.
  Section keys match `^[a-z][a-z0-9_-]*$`.
- Keyed slots are ordered by the position at which their key was first
  registered. The registry remembers that position forever, so re-registering an
  existing key, as a reload does, keeps its position; a new key appends. Hooks
  without a key append.
- Registered objects are immutable and wrappers are pure: a wrapper returns a
  new object and never mutates its input.
- Every call outside `batch()` publishes immediately. Publication is synchronous,
  invokes no extension callback, and notifies subscribers.

`batch(register)` stages every registration and disposal made while `register`
runs and publishes once when it returns. It validates only the final staged
state, so order inside the block does not matter: disposing an old tool and
adding its replacement is a gapless reload. If `register` throws, returns a
thenable, or the final state is invalid, nothing is published, staged disposals
are rolled back, and `batch()` throws. Only registrations made synchronously
inside `register` belong to the batch; a registration made later by a detached
continuation is an ordinary immediate registration. Calling `batch()` inside a
batch is a programming error and throws. The returned `Registration` covers every
registration added in the batch that was not disposed inside it.

A snapshot is a plain immutable value; nothing is released. The scheduler takes
one per phase-handler invocation and passes it through the runtime; handlers and
hooks read that snapshot and never take their own. At every normal phase boundary
the scheduler takes a fresh one (section 5.4). A tool task keeps the composed tool
it pinned until execution settles. Different phases may observe different
registry states; nothing requires one turn to see a single registry state across
its generation, tool, and post-tools tasks. Host operations, such as the create
conveniences, take one snapshot inside their commit.

```ts
// ToolTask is the built-in tool task's token; its hooks are listed in section 7.2.
const registration = registry.batch(() => {
  registry.tools.add(grep);
  registry.hooks.add(ToolTask, { beforeTool: audit }, { key: "audit" });
});
// later, reload: publish the replacement at once
registry.batch(() => {
  registration.dispose();
  registry.tools.add(grepV2);
  registry.hooks.add(ToolTask, { beforeTool: audit2 }, { key: "audit" });
});
```

The registry does not track which running work still uses a disposed
registration. Work that already started keeps using the code it took, so an
extension that frees resources right after `dispose()` can make a still-running
call fail with an ordinary error result. Extensions that need graceful disposal
manage their resources' lifetime themselves, for example by reference counting.

### 7.2 Hooks

A hook is a typed question asked by a task before it commits a decision. Hooks
are declared by task definition and registered through `registry.hooks.add()`
Session-wide or, with `scope`, for one conversation and optionally its owned
subtree. Subtree matching follows conversation ownership, not history parents.
Registration is typed by the task token, but dispatch matches the task's name,
so hooks survive a reload of their task; keeping hook signatures compatible
across task versions is the task author's responsibility. Hooks run in registry
order off the line; a crash before the consuming commit may rerun them. Abort
errors always propagate.

| hook | composition | ordinary throw |
|---|---|---|
| `beforeRequest` | replacement chain | report, continue |
| `afterResponse` | all observers | report, continue |
| `onYield` | first continuation wins | report, continue |
| `beforeTool` | call replacement chain; first block wins | block tool with error text |
| `afterTool` | result replacement chain | report, continue |
| `afterTools` | all observers | report, continue |
| `beforeCollapse` | first decision wins | report, continue |

Hooks use task memos for durable first-writer-wins decisions. There is no public
semantic event channel; current UI status is document state.

### 7.3 Tools

```ts
type ToolControl = {
  readonly addTools?: readonly string[];
  readonly terminate?: true;
  readonly handoff?: string;
};

type ToolExecutionResult = {
  readonly content?: ToolResultMessage["content"];
  readonly isError?: boolean;
  readonly details?: JsonValue;
  readonly control?: ToolControl;
};

interface ConversationHandle {
  readonly id: ConversationId;
  submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
  abort(context: Context): Promise<void>;
  waitForIdle(context: Context): Promise<void>;
}

interface ToolExecutionApi extends DocumentObserver, DocumentReader {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly callId: string;
  output(chunk: string | Uint8Array): void;
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

type ToolRegistration = Tool & {
  readonly replay?: "safe" | "unsafe";
  readonly outputLimits?: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly retain?: "head" | "tail";
  };
  execute(
    args: JsonValue,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult>;
};
```

Omitted `replay` is `unsafe`. Omitted `outputLimits` are 50 KiB, 2,000 lines,
and `retain: "head"`.

A running tool reports two things to the UI, mirroring the two halves of its
final result:

- `output(chunk)` appends running text output, like stdout. If `execute()` omits
  `content`, the final retained output becomes one text content item; no output
  becomes an empty content list.
- `details(value)` replaces the running details with a complete JSON value; it
  does not merge keys. If `execute()` omits `details`, the last value becomes the
  final `details`, so a renderer handles one details shape from the first
  update through the final result.

Neither is sent to the model while the tool runs. `output()` synchronously
accepts UTF-8 output into that invocation-owned bounded buffer and throws after
invocation end. Throttled commits publish the retained output, dropped
byte/line counts, and the current details in the tool presentation document. Explicit
text in explicit result content is bounded by the same limits before transcript
persistence; non-text content is retained as declared by its pi-ai type.

`output()` never spills complete output to a file because spilling requires a
filesystem, which may be remote or unavailable. A tool that must preserve
complete output spills through the `ExecutionEnv` or `FileSystem` it was given,
such as shell execution with spill capture, and reports the resulting path in its
details.

The `details()` promise resolves after the corresponding or coalesced document
commit. During normal settlement, accepted output updates drain before
the tool-result entry and terminal task record commit. Abort and close obey
invocation and Session admission gates: uncommitted buffered updates may be
discarded, while admitted commits settle. Cancellation, callback, tracker
preparation, and checkpoint failures occur before Storage admission and do not
poison the Session. An uncertain Storage failure follows the fatal Session rule.

Tools are registry entries (section 7.1) with name, description, JSON schema,
replay policy, and execute function. `registry.tools.wrap(name, key, wrapper)`
decorates a tool without replacing it. Each snapshot composes the current base
tool with its wrappers in registry order; a wrapper never captures a base, so
reloading the base keeps its wrappers. A wrapper that throws or returns a tool
with a different name makes that tool absent from the snapshot (fail closed:
not offered, and calls produce `tool_unavailable`) and is reported. A wrapper
without a base contributes nothing. The composite supplies the declaration,
argument validation, replay policy, and execution.

A tool call is accepted only if it was offered in the request's effective
system/tool history. A call to a tool that is not offered or has no registered
implementation produces the `tool_unavailable` error result described in section
2.2 instead of failing the turn. The tool task resolves the composed tool once
from its snapshot before argument validation and pins it until execution
settles, even across later snapshot refreshes. Arguments must satisfy both the offered
declaration and the pinned implementation's schema; they are validated before
and after `beforeTool` hooks.

After hooks and validation, the tool task durably records the final call and
resolved replay policy before execution. Recovery does not rerun `beforeTool`
and passes the same stored arguments to `execute()`. A replay-safe tool may
reconstruct a submission from those arguments when that transformation is pure.
Random values, timestamps, mutable document/configuration reads, or other derived
inputs that must remain stable are first captured in a durable memo, checkpoint,
or task input. A background supervisor receives the final submission draft in
its own durable input so it can finish independently. Recovery does not let a
changed registry declaration alter the stored replay policy.

A tool-acquired conversation handle accepts only input submissions; tools use
ordinary transaction writes for passive entries.

A tool executes in a durable task. It may:

- publish bounded running output and details to its presentation document;
- commit memos;
- create and wait for tasks;
- atomically create or fork explicitly owned conversations through `commit()`;
- observe documents for which it has a token/reference;
- mutate authorized documents through `commit()`;
- return bounded model content and separate diagnostic details.

Tool operations use the invoking task's admission and invocation-lifetime gates.
Task creation defaults to that task's conversation. Trusted document and
conversation access follows sections 3.3 and 9.2; there is no additional subtree
authorization layer. Possession of a Session-global typed ID is sufficient in
trusted code.

Tools have no conversation-creation convenience method. They create or fork a
conversation inside `commit()`, state its ownership explicitly, atomically stage
any related document/task writes, and receive only the inert record. After that
commit settles, `conversation(id)` acquires an invocation-bound operational
handle for submission, explicit abort, and idle waits without changing
ownership. A commit callback must not call `conversation()` or use a previously
acquired handle: nested Session operations and external effects are forbidden
while the mutation line is held. A handle's operations reject after the
invocation ends. A `Submission` returned by its `submit()` is invocation-bound in
the same way; the admitted submission remains durable after those methods reject.
Invocation-owned document watches stop when the invocation ends.

A foreground subagent conversation is explicitly owned by its tool task. One
transaction creates or forks the child and records its durable registry mapping;
after settlement the tool reacquires the child, submits with the registered
request ID, and waits for that submission's result. Aborting or abnormally
terminalizing the tool task cascades through the owned scope.

A background subagent is provisioned in one transaction. After deduplicating by
its durable registry key, the tool stages a background supervisor task `B`, a
child conversation `C` explicitly owned by `B`, and the registry mapping from the
semantic name to `C` plus its stable request ID. `B` may be staged earlier in the
same transaction and used immediately as `C`'s owner. Its durable input contains
the exact submission draft and the registry location/key; it need not contain
`C`'s not-yet-created ID. Once scheduled, `B` resolves `C` from the mapping,
verifies the immutable owner edge, and performs normal `Conversation.submit()`.
A crash before admission makes `B` retry; a crash after admission returns the
existing request-ID-deduplicated `Submission`. The initiating tool may race the
same submit for lower latency and wait only for the durable admission receipt.
The supervisor may complete after setup: its terminal record retains
`background`, so ancestor ordinary abort and idle traversal continue to stop at
its owned scope.

Applications may maintain a conversation document mapping semantic subagent
names to durable conversation IDs and application-minted submission request IDs.
Such a live registry uses `fork: "initial"` so children do not inherit the
parent's agent list and its update is not a selected fork source. Conversation
creation/forking, supervisor creation when applicable, and the registry mapping
commit atomically. The supervisor input, tool's durable final arguments, or a
durable checkpoint must retain enough information to reconstruct the exact
submission draft; the registry itself need not duplicate that payload. Initial
or later input then uses the registered stable request ID with the full
`Conversation.submit()` state machine. A crash before admission leaves a durable
request to submit; a crash after admission retries the same request and receives
the existing `Submission`. A read-only lookup by conversation/request ID can
report absence or return the durable queued/placed/done/unanswered receipt.
Submission admission therefore needs no private transaction shortcut and does
not move onto `Tx`. Kernel ownership indexes independently drive abort and idle
traversal.

A tool result may request `addTools`, `terminate`, or `handoff`. Post-tools
applies added tool names to configured loadout, uses a final boundary for
terminate/handoff, and writes a headed handoff entry when requested.

On reopen, a tool reruns only when both its stored intent policy and the current
registered declaration say `safe`. A current `unsafe` declaration may veto a
stored-safe replay; a current-safe declaration never upgrades stored unsafe. A
tool with no current registration is treated as `unsafe`. Every other orphaned
effect produces an interrupted result containing the
durable partial output. Completed, failed, and aborted
tool terminal outcomes retain their tool-result entry ID for post-tools.

### 7.4 System prompt and dynamic tools

Pico has no durable prompt sections. The registry's system prompt slot produces
the desired sections for each request; the transcript's `pi.system` entries are
the only durable record of what the model saw. Pico stores prompt and tool
changes directly as PR #9548 `SystemMessage` values at their transcript
positions, always with empty `content`:

```ts
type SystemEntry = EntryRecord & {
  readonly kind: "pi.system";
  readonly model: readonly [SystemMessage];
};

const baseline: SystemMessage = {
  role: "system",
  content: "",
  sections: { preamble: renderedPreamble, cwd: renderedCwd },
  toolsAdded: allEffectiveTools,
  timestamp: now,
};

const delta: SystemMessage = {
  role: "system",
  content: "",
  sections: { cwd: nextRenderedCwd, legacy: null },
  toolsRemoved: [{ name: "read" }],
  toolsAdded: [nextRead],
  timestamp: now,
};
```

Generation preparation takes these steps against its phase snapshot:

1. Read the committed configuration and replay the active transcript's system
   messages into the shown sections and offered tools.
2. Compute the desired tools: active names that the snapshot resolves, in
   configured order, as composed by their wrappers.
3. Render every registered section, in registry order, with `PromptInput`: the
   conversation, those tools, the shown sections, the configured model and
   thinking level, and a `DocumentReader` for committed documents. The results
   are the desired sections.
4. Compare desired sections and tool declarations with the replayed state and
   append one positional `pi.system` entry when they differ.
5. The commit appending that entry first checks that the conversation's tail
   entry, active head, and configuration are unchanged since step 1. If any
   changed, preparation reruns from step 1 with the same registry snapshot.

Model and thinking level are request options, not prompt state.

Registered sections are the only source of prompt text; there is no separate
builder. `systemPrompt.section(key, render, { tag })` adds a section, and
`systemPrompt.wrap(key, wrapperKey, wrapper)` decorates one, composed per
snapshot like tool wrappers. Sections render in registry order: the position at
which each key was first registered. A section whose `render` returns
`undefined` is omitted, which is how a section varies by conversation. With
`tag` omitted or true, text is wrapped as `<key>\n...\n</key>`. A section that
throws keeps its shown text, if any, and is reported; the request is still sent.
Abort errors propagate. With no registered sections, the desired section set is
empty.

A minimal prompt is one untagged section:

```ts
registry.systemPrompt.section("preamble", () => "You are a helpful assistant.", { tag: false });
```

Sections read per-conversation data through `input.read`. For example, a
coding agent keeps its own conversation document with the agent kind, preamble,
and working directory; its preamble and cwd sections render from that document,
and its AGENTS.md and skills sections return `undefined` for subagent
conversations.
Renderers must be deterministic for equal inputs: any change in rendered text,
such as an embedded timestamp, appends a system delta and invalidates provider
prompt caches.

Replay applies messages in transcript order. Non-empty `content` appends
instructions. A section string adds or replaces that name without moving an
existing section; `null` removes it, and a later re-addition appends it to the
ordered section map. Within one message, tool removals happen before additions,
so a same-name replacement gets the new declaration and position.

Preparation compares both values and order. If values can be patched without
changing order, it emits the minimal patch. If shown and desired section order
differ, one commit appends two `pi.system` entries: the first removes every
shown section with `null`, and the second re-adds every desired section in
desired order. This makes order-only changes and deletion/re-addition between
requests replay exactly; merely restating equal values is insufficient.

A PR #9548 `SystemMessage` is always a patch, not a reset: it cannot remove
previous `content` or restore section order merely by restating current values.
Therefore, when a head removes the previous request-visible baseline, the new
`pi.system` entry adds `ContextEdit` omissions for every earlier `pi.system`
entry still retained after the cut. Its own message is then a complete baseline
containing every desired section in order and every effective tool declaration.
Model-context replay sees the new baseline instead of the omitted retained
deltas. Head rebaselining takes precedence over ordinary order/value patching.
Without a head cut, an order mismatch uses the two-entry remove/re-add sequence
above; only when order already matches does preparation emit the minimal changed
values, `null` removals, and tool additions/removals. A changed tool declaration
is removed and re-added in the same message. When the offered tool order differs
from the desired order, the message removes every offered tool and re-adds the
desired tools in order.

The rendered strings stored in historical `SystemMessage.sections` remain
authoritative even if the current renderer changes. Pi-ai decides whether to
send the messages positionally to a capable provider or fold them into one
leading system message; Pico does not rewrite its stored transcript for provider
compatibility.

### 7.5 Extension reload

Extension code is reloaded in process through the registry. The host publishes
the new registrations and disposes the old ones in one `batch()`. The Harness
keeps running; no close or reopen is required.

- New phase invocations and tool tasks use the new registrations immediately;
  running invocations see them at their next phase boundary.
- Work already running keeps its snapshot until its phase handler settles, and a
  pinned tool keeps its implementation until its execution settles. Replacement
  never signals or interrupts it. Resources the old code uses are the
  extension's responsibility (section 7.1).
- A task definition replaced by name hands over at its next normal phase boundary
  (section 5.4). A task definition must increase its version when the meaning
  of persisted input or checkpoint state changes and migrate supported older
  state; a failed migration blocks the task rather than terminalizing it.
- Keyed registrations re-registered under the same key keep their position, so a
  reload does not reorder hooks, tools, or sections.
- Document definitions are passed explicitly to typed access and need no
  registration; changed tokens take effect on their next access.

If old extension code ignores cancellation and never settles, new work already
uses the replacement. Harness close still joins every invocation. Safe forced termination of arbitrary
non-cooperative JavaScript requires worker/process isolation; that host
terminates the process and reopens the Session from durable state. Old and new
Harness instances must never own the same Session concurrently.

## 8. Built-in tasks

The initial implementation provides:

| kind | responsibility |
|---|---|
| `pi.generation` | prepare system/loadout, request or poll model, retry, classify response |
| `pi.tool` | validate, hook, execute, persist output and details, append result |
| `pi.post-tools` | wait for tools, apply controls, run boundary, continue generation |
| `pi.collapse` | select a transcript range, summarize, append a headed summary |

Generation uses `HarnessOptions.models` without a Pico-specific model adapter. It
resolves `models.getModel(ref.provider, ref.modelId)`, builds a pi-ai `Context`
from the prepared prompt/messages/tools, and calls `models.streamSimple()` with
the task invocation's abort signal and configured reasoning/options. Deferred
continuation calls `models.fetchDeferred()` and `models.cancelDeferred()` with
that same model and signal. Missing models and synchronous/streamed pi-ai errors
are classified into the durable generation outcomes below.

Generation and tool progress are throttled durable document commits. A crash may
lose only the uncommitted throttle window. Recovery converts committed partials
to normal interrupted/aborted transcript entries, clears presentation state,
and then retries or terminates according to the task phase. Retry deadlines,
attempts, compaction, and tool progress are current document state for late
joiners; completed-attempt usage/accounting is an entry or terminal detail.
Bounded output records whether content was truncated and any retained file path.

Compaction changes model context by appending a summary entry with a head. It
does not delete transcript history.


## 9. Document observation and Chord

### 9.1 Document state

Chord's existing replicated-state layer exposes this source-adoption contract:

```ts
interface ReplicatedStateSourceFrame<T> {
  readonly cursor: number;
  readonly value: T;
  readonly ops: readonly Op[];
  readonly context: Context;
}

interface ReplicatedStateSourceAttachment<T> {
  /** Fixed immutable snapshot captured at the atomic attachment boundary. */
  readonly snapshot: { readonly value: T; readonly cursor: number };
  /** Install the sole listener and synchronously drain every buffered frame. */
  activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
  dispose(): void;
}

interface ReplicatedStateSource<T> {
  /** Atomically capture a snapshot and begin buffering every later commit. */
  attach(): ReplicatedStateSourceAttachment<T>;
}

interface ReplicatedStateSourceOptions {
  readonly onError?: (error: Error) => void;
}

interface AttachedReplicatedState<T> extends ReplicatedState<T> {
  readonly value: T;
  dispose(): void;
}

function replicatedState<T>(
  source: ReplicatedStateSource<T>,
  options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;

type DocumentState<T extends JsonObject> =
  AttachedReplicatedState<Readonly<T> | null>;

type WatchEnd =
  | { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
  | { readonly reason: "listener_error"; readonly error: Error };

interface WatchHandle<T> {
  /** Acquisition revision before start; latest delivered immutable revision afterward. */
  readonly value: T;
  /** Installs the sole serialized asynchronous listener. */
  start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void;
  /** Idempotently stops future callbacks and returns this watch's terminal result. */
  stop(): Promise<WatchEnd>;
  /** Settles when the watch terminates; an already-running callback remains caller-owned. */
  readonly closed: Promise<WatchEnd>;
}

type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

interface DocumentObserver {
  watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: ConversationDocFamilyToken<T, I>, conversationId: ConversationId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
  watchDoc<T extends JsonObject, I extends JsonValue>(token: TaskDocFamilyToken<T, I>, taskId: TaskId, key: string, context: Context): Promise<DocumentWatch<T> | undefined>;
}
```

`documentState()` attaches Pico's committed document stream to Chord before
returning. The returned state is already hydrated with the exact shareable
immutable revision, has no mutation methods, and publishes every later exact
committed revision and operation batch without another tracker, value copy, or
re-diff. Disposing it unregisters only that observation; Pico remains the sole
document mutator.

State and watch acquisition never create; absent lookup returns `undefined`.
Successful acquisition binds one concrete incarnation. Retirement publishes a
JSON `null` root replacement and ends that incarnation's stream. If the state
remains exposed, consumers see `null`, never stale state. A later recreation
requires acquiring a new state or watch.

Each document state assigns its own in-memory contiguous Chord delivery sequence.
Pico does not persist or expose that sequence through `WatchHandle`. States and watches retain immutable revisions independently of the loaded tracker
cache. Reopen creates a new state lifetime and hydration.

Internally, state attachment uses Chord's synchronous atomic snapshot-and-register
boundary: the snapshot includes every commit before attachment, and every later
exact frame is buffered until activation. This prevents a snapshot from being
paired with operations based on a newer unseen revision.

### 9.2 `watchDoc`

Tasks, hooks, and tools may observe any existing document for which their code
has a token and owner/key. There is no additional subtree permission system inside trusted
Session code.

On the Session line, `watchDoc()` resolves one existing concrete incarnation,
captures its current immutable tracker revision in O(1), and registers for every
later exact committed revision and operation batch. It returns `undefined` when
absent. Before `start()`, `watch.value` remains the acquisition revision while
later frames buffer.

```ts
const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
if (watch === undefined) return;
try {
  await initializeConsumer(watch.value, context);
  watch.start(async (value, ops, deliveryContext) => {
    await consume(value, ops, deliveryContext);
  });
} catch (error) {
  await watch.stop();
  throw error;
}
```

`start()` installs the sole listener and schedules delivery; it never invokes
user code inline. Each callback receives the exact immutable committed value and
the exact operation batch that produced it. Immediately before invocation,
`watch.value` advances to that value. The watch awaits the listener before
starting its next callback, but Session commits never wait for callback
settlement.

A watch retains at most 100 pending committed frames, excluding the frame already
being delivered. Adding frame 101 replaces the complete undelivered suffix with
one self-contained root replacement `[["r", newestValue]]`, using the newest
exact immutable revision and that commit's Context. Later exact frames follow
that replacement normally. Another overflow replaces the pending suffix again.
No serialized-byte measurement, value copy, operation replay, or re-diff occurs.
This is convergent observation, not an audit stream; consumers requiring every
transition must persist those facts separately.

`watch.value` and every previously returned revision remain stable forever under
the trusted immutability contract. Consumers must not mutate them or retained
descendants. The selected commit Context's values are preserved without inheriting the
producer's cancellation. A callback owns its own asynchronous work.

A watch remains bound to its original incarnation. Retirement queues the exact
terminal `[["r", null]]` frame, or folds it into an overflow replacement with
value `null`. After that callback settles, the watch closes as `retired` and never
follows a replacement incarnation.

`stop()` is idempotent. It synchronously unregisters, discards pending frames,
prevents another callback from starting, and returns the common terminal promise.
An already-running callback is not aborted or joined and remains caller-owned.
The acquisition `Context` governs watch lifetime. Cancellation during acquisition
cleans up before rejecting; later cancellation and Session close stop future
delivery similarly. Listener failure discards pending work and closes only that
watch as `listener_error`. The first termination reason wins, and every late
rejection is observed.

### 9.3 Conversation view

The public view is a fixed structural mount of selected built-in documents:

```ts
type ConversationView = {
  readonly conversation: ConversationRecord;
  readonly entries: readonly EntryRecord[];
  readonly docs: Readonly<Record<string, JsonObject>>;
};
```

The concrete built-in document IDs and fields are public protocol once their
implementation layer is approved. Third-party documents are initially exposed
through their own Chord services, not automatically mounted.

The mount consumes one complete Session commit and publishes one Chord batch:

```text
document op ["s", ["message"], value]
-> view op ["s", ["docs", "pi.live", "message"], value]
```

Entry appends/head changes and every changed mounted document are included in
the same publication. Before Storage admission, the Session derives the mounted
operation batch and prepares each affected loaded mount's next immutable revision
with the optimized immutable applier. Failure rolls back normally. After Storage
success, finalization only installs the prepared mount pointers/cursors and
enqueues publication. Mounted document revisions may be structurally shared
because they obey the same trusted immutability contract. The mount performs no
semantic projection and owns no second persistence authority. A Chord adapter
assigns a contiguous in-memory delivery sequence per view source lifetime.

`Conversation.viewState()` exposes the mount directly as a disposable read-only
Chord state for facets and UI services. `Conversation.watch()` exposes the same
mount through Package 12's serialized exact-frame watch with bounded pending
frames and full-value overflow replacements. An empty mounted operation batch
creates no revision; a redundant nonempty batch remains a real publication.
Neither API adds another tracker, persistence authority, or semantic event
envelope.

### 9.4 Agent-mode notifications

The Session kernel and Chord structural sources do not maintain a semantic event
journal. Coding-agent JSON/RPC compatibility uses a thin agent-mode adapter
derived from each uncoalesced committed publication before any per-watch
overflow replacement. It owns no tracker or persistence and emits notifications only after
the commit that makes them true.

The adapter protocol covers run start/settlement, committed assistant progress,
message entry settlement, tool intent/progress/result, submission queue/outcome,
retry/deferred/compaction state, configuration changes, and faults. One commit
may produce an ordered batch. Progress notifications represent Pico's throttled
durable partials, not every raw provider frame. The exact legacy `AgentEvent`
wire format is not preserved.

Notifications have no hydration or replay contract. A consumer requiring a
complete lifecycle subscribes before admitting the submission; a late or reconnecting
consumer hydrates structural state and history instead. Product adapters apply
these rules:

- TUI hydrates and renders `ConversationView`, then applies structural updates;
  notifications may drive transient animation but are not its authority.
- Print awaits its input `Submission` and prints that submission's answer.
- JSON/RPC expose correlated commands plus the ordered agent notification
  protocol, with transport backpressure and disconnect policy owned by that
  adapter.

This adapter is allowed even though a public Session-kernel semantic stream is a
non-goal. It must not derive notifications from a lossy, overflow-reset watch
when complete subscribed lifecycle delivery is promised.

## 10. Storage contract

Ordered scans are cursor-based. Exact identity lookups are keyed.

```ts
type Page<T, C> = {
  readonly items: readonly T[];
  readonly next?: C;
};

type Cursor = Readonly<Record<string, JsonValue>>;

type ConversationQuery = {
  readonly ownerConversationId?: ConversationId;
  readonly ownerTaskId?: TaskId;
};

type EntryQuery = {
  readonly conversationId: ConversationId;
  readonly minEntryId?: EntryId; // inclusive
  readonly maxEntryId?: EntryId; // inclusive
};

type TaskQuery = {
  readonly conversationId?: ConversationId;
  readonly kind?: string;
  readonly status?: "pending" | "running" | "terminal";
  readonly abortRequested?: boolean;
  readonly background?: boolean;
};

type DocumentPoint = Seq | "current";

type DocumentAddress = {
  readonly kind: string;
  readonly scope: DocumentRecord["scope"];
  readonly key?: string;
};

type DocumentQuery = {
  readonly scope: DocumentRecord["scope"];
  readonly at: DocumentPoint;
  readonly kind?: string;
};

type DocumentContent =
  | { readonly version: number; readonly kind: "base"; readonly value: JsonObject }
  | { readonly version: number; readonly kind: "delta"; readonly ops: readonly Op[] };

type StoredDocument = {
  readonly record: DocumentRecord;
  readonly version: number;
  readonly value: JsonObject;
  /** Deltas replayed after the selected base to materialize `value`. */
  readonly deltasSinceBase: number;
};

type StorageWrite =
  | { readonly type: "conversation"; readonly value: ConversationRecord }
  | { readonly type: "entry"; readonly value: EntryRecord }
  | { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
  | { readonly type: "submission"; readonly value: SubmissionRecord }
  | {
      readonly type: "document.create";
      readonly record: DocumentCreate;
      readonly content: Extract<DocumentContent, { kind: "base" }>;
    }
  | {
      readonly type: "document.copy";
      readonly record: DocumentCreate;
      readonly source: { readonly id: DocumentId; readonly at: DocumentPoint };
    }
  | {
      readonly type: "document.change";
      readonly id: DocumentId;
      readonly content: DocumentContent;
    }
  | { readonly type: "document.retire"; readonly id: DocumentId };

/**
 * Trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Enforces atomicity, global ID ownership, immutable
 * conversation/entry creation, document record consistency, and detached
 * values; Session serializes commits. Sequences strictly increase but may have
 * gaps. Once commit() resolves, later reads through that Storage observe it.
 */
interface Storage {
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  /** Allocate from the one global numeric namespace; the generic brand is compile-time only. */
  mintId<I extends Id<string>>(): Promise<I>;

  conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;
  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<ConversationRecord, Cursor>>;

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<EntryRecord, Cursor>>;

  task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

  submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;
  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context): Promise<SubmissionRecord | undefined>;

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;
  document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;
  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocumentRecord, Cursor>>;

  close(context: Context): Promise<void>;
}
```

`StorageRejected` means a batch was rejected before any durable effect and is
guaranteed not to have committed. Session rolls such a batch back normally;
unknown failures after Storage admission remain fatal because their commit state
is uncertain. Backends use `StorageRejected` for deterministic `document.copy`
source, replay, and consistency failures only when rollback is guaranteed.

A `document.copy` reads committed pre-batch source state independent of command
order. The source must be an alive conversation document at the selected point,
and kind/key/history/fork must match the child create record. Storage persists
one independent complete child base at the source's stored version. A batch may
not create, change, or retire a selected source. Later source changes,
reclamation, retirement, or backend reopen cannot affect the child.

Cursors are backend-owned JSON objects. Callers only round-trip them to the same
scan on the same storage; cross-storage or cross-query use is unsupported. The
Session owns the mutation line, so storage implementations do not add a second
caller-facing commit mutex. Each backend still makes one admitted batch atomic.

`findLatestHeadMarker()` returns the newest visible entry carrying `head` at or
below its optional inclusive cutoff. The returned entry is the marker; its
`head` value is the actual lower bound for context. `scanEntries()` pages the
inclusive ID range in newest-first order while applying every conversation
ancestry cap. With no bounds it pages complete visible history. To read context
through entry `E`, find the marker at or before `E`, then scan from
`marker?.head` through `E`. For current context the upper bound is omitted.
Conversation owner filters are indexed and conjunctive. They support ownership
traversal without an all-conversation scan; application-maintained registries
are not a substitute for these kernel indexes.

`entry(id)` combines exact global lookup with the commit sequence required by
historical document reads. `entry(conversationId, id)` returns that pair only
when the entry is visible through the requested conversation's ancestry. `limit`
is always the maximum page size.
`findDocument()` resolves one exact logical kind/scope/key address at current or
historical membership. A missing key means the singleton, not every family
member. `scanDocuments()` enumerates only the incarnations alive in one exact
scope at its selected point and may restrict one family/singleton kind. It uses
ascending incarnation IDs. There is no ordinary open-time all-document scan.
Task queries support conversation, kind, live/terminal status, abort mark, and
background status.

`document(id, at)` materializes one specific incarnation and never follows a
replacement at the same logical address. Callers resolve an address with
`findDocument()` when they do not already hold an incarnation ID. It selects the
newest applicable base, applies its ordered Chord delta tail, and returns the detached materialized value, stored
definition version, and number of replayed deltas after that base. Base/delta records are backend-private. The lookup never
scans unrelated documents. An unknown ID returns `undefined`. At `"current"`, a
retired incarnation returns `undefined`. A numeric lookup of a rewindable
conversation incarnation returns `undefined` outside its half-open lifetime and
reconstructs the selected value inside it. A numeric lookup of a known current-
only incarnation rejects rather than depending on reclaimed content. Metadata
membership remains queryable historically. A missing required base, a version
change inside a delta tail, or an operation that cannot be applied inside an
addressable lifetime is storage corruption, not absence.

One normalized batch contains at most one create/change content command per
incarnation and may also retire that incarnation. Storage applies content before
retirement independent of write-array order. Create plus retire stamps both
lifetime bounds with the batch sequence. Retire plus create at one logical
address makes the new incarnation current at that sequence. Deltas cannot cross
a stored version boundary; a version transition must be a base.

The semantic conformance suite covers memory, SQLite, and JSONL.

## 11. Backends

### 11.1 Memory

Memory storage is the reference semantics. It copies retained write values and
all read results. This deliberately simulates the ownership boundary naturally
created by SQLite encoding/decoding and JSONL serialization; it is not defensive
validation. It preserves rewindable records and reclaims latest records only
after a committed base or retirement.

### 11.2 SQLite

One SQL transaction is one Session commit. SQLite stores:

- conversation, entry, task, and submission records;
- document records;
- indexed document bases/deltas by document and commit sequence.

Live task transitions replace one row. Terminal tasks remain as small records.
Document reads use indexed base-plus-tail ranges. The first implementation stores
Chord records directly; it does not translate generic operations to SQLite JSON
functions.

Schema shape, WAL checkpoint cadence, and synchronous defaults are backend
implementation choices validated by conformance, reopen, query-plan, and storage
benchmarks.

### 11.3 JSONL

JSONL depends on the portable `FileSystem` capability, not the broader
`ExecutionEnv`. It uses reclaimable sidecars without exposing them to the
harness. Persistence alone does not provide the ownership boundary: any decoded
indexes, materialized values, or caches retained in memory must be detached from
commit arguments and must not be exposed directly by reads. A JSONL backend
cannot simply add file appends around aliasing memory tables.

```text
main.jsonl       table writes, document records, and one marker per commit
doc-<id>.jsonl   one document incarnation
task-<id>.jsonl  live task replacements
```

Publication protocol:

1. Append complete prepared records to every affected sidecar.
2. Append one complete main marker listing those records.
3. Publish in memory only after the marker write succeeds.

Every commit uses this protocol; there is no standalone-sidecar fast path.
JSONL creation accepts an `fsync` option that defaults to `false`. Without
`fsync`, it guarantees ordinary process-crash consistency, not survival of
power, host, kernel, or filesystem failure. With `fsync: true`, the backend
appends all affected sidecar records, flushes each affected sidecar, and only
then appends the main marker. Ordinary publication does not explicitly flush
`main.jsonl`; an acknowledged tail commit may therefore still disappear, but a
marker that survives should not overtake its sidecar data. A main-only commit has
no sidecars to flush. Before destructive reclamation with `fsync: true`, the
backend flushes `main.jsonl` once so the authorizing marker cannot disappear
while its replacement or removal survives. If that flush fails, the committed
state remains published and reclamation is deferred. A non-empty temporary
replacement is also flushed before rename.

Recovery:

- Remove torn final lines.
- Ignore and remove unconfirmed sidecar tails.
- Apply confirmed records only.
- Missing required confirmed data is corruption and opening fails.
- A later committed latest base or retirement may prove an earlier physical
  record unnecessary.
- Any uncertain append failure poisons the open backend.

Reclamation starts only after the authorizing base/retirement commits. When no
sidecar records remain, it removes the sidecar directly. Otherwise, it writes a
temporary replacement, renames it, and invalidates cached file descriptors so
future appends cannot target an unlinked inode. Flushing `main.jsonl` to
authorize reclamation does not compact it. `main.jsonl` is not compacted in the
initial implementation.

## 12. API footguns

These are contracts, not invitations to add defensive machinery:

- **Detached draft work:** draft reads, draft writes, and all `Tx` operations
  reject after the Session callback settles. Fire-and-forget work that runs
  before callback settlement can still mutate the active transaction and is
  unsupported.
- **Read after write:** read every required table row before the first table
  write. Document drafts remain usable afterward; table reads do not.
- **Long transactions:** an async commit callback holds the Session mutation
  line. Never await models, tools, processes, network calls, humans, a nested
  Session commit, or a Session waiter inside it. Use methods on the current `Tx`.
- **Explicit creation:** only typed `tx.doc()` creates an absent document. Snapshot,
  state, and watch lookup return `undefined` instead.
- **Family initialization:** the first acquisition of an absent family address
  selects its seed. Existing instances and later calls ignore seeds; a seed is
  neither identity nor an update.
- **Checkpoint starvation:** if `checkpointWhen()` never returns true, replay
  and current-only document storage can grow without bound while the document is
  live.
- **Wrong fork setting:** `current`, `initial`, and `asOf` are product semantics,
  not optimizations. Changing one changes child conversation behavior.
- **Schema stability:** document kinds and visible mount paths are
  persisted/public protocol. Value migration cannot rename a kind; a kind
  change requires explicit copy and retirement. Passing incompatible definition
  tokens that claim the same kind is unsupported caller misuse; Session does not
  maintain a document-definition registry to detect it.
- **Trusted immutable revisions:** `snapshot()`, state values, watch values, and
  their descendants may share tracker-owned containers. Never mutate them; copy
  first when mutable ownership is required. Runtime freezing is not provided.
- **Watch activation:** before `start()`, `watch.value` remains the immutable
  acquisition revision. Initialize the consumer from it first. After start, the
  property advances to each delivered immutable revision before its callback;
  every earlier reference remains stable.
- **Buffered watches:** slow or unstarted watches retain up to 100 exact committed
  frames. Overflow replaces the undelivered suffix with one full-value root
  replacement, so intermediate committed states may be omitted. A consumer that
  must audit every transition must persist each fact in an immutable entry or
  journal and scan that history explicitly.
- **Watch stop:** a listener may call and await `stop()`; it prevents future
  callbacks but neither aborts nor joins the callback already running.
- **Durable progress cadence:** clients see only committed progress. A crash may
  lose the current uncommitted throttle window.
- **Large terminal results:** terminal task records remain queryable. Put large
  results in entries or longer-lived documents and retain only their IDs in the
  outcome. Never reference a task-scoped document retired by that same outcome.
- **Raw transcript:** view entries are not model context. Rendering edits,
  display-only entries, and model filtering require the appropriate reducer.
- **Reserved `pi.` names:** task names, document kinds, and entry kinds starting
  with `pi.` belong to built-ins by convention. Nothing enforces it; reusing one
  collides with Harness behavior, such as `pi.system` entries being replayed as
  system messages.
- **Early resource disposal:** disposing a `Registration` only stops new use.
  Freeing resources immediately can fail calls that are still running.
- **Async batches:** `batch()` callbacks are synchronous. A callback that returns
  a promise publishes nothing and throws.
- **Unstable prompt text:** a section renderer whose output changes without a
  real content change, for example by embedding the time, appends system deltas
  and defeats provider prompt caching.
- **Fatal storage errors:** after an uncertain storage failure the Session is
  poisoned. Do not catch the error and continue using it.
- **JSONL durability:** default JSONL ordering handles ordinary process crashes;
  without durable mode it does not promise acknowledged commits survive power or
  host failure.

## 13. Non-goals

Pico5 initially has no:

- whole-Session DOM;
- visible-undurable publication;
- Session-kernel semantic event journal or independently maintained event state;
- session-scoped rewindable documents;
- automatic checkpoint heuristic;
- automatic third-party view mounting;
- CRDT/offline multi-writer merge;
- SQL translation of arbitrary Chord operations;
- JSONL global compaction or automatic corruption repair;
- compatibility layer for removed Pico prototypes;
- forced termination of non-cooperative extension code inside one process.
