# Changelog

## [Unreleased]

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.
- Split `Tx.createConversation()` from `Tx.forkConversation()`, replaced raw conversation-record input, and require explicit ownerless or task ownership.
- Replaced untyped numeric record IDs and the `TaskRef` wrapper with erased branded numeric ID types, including result-typed `TaskId<R>`, separately branded commit sequences, and generic `Storage.mintId()`.
- Made task conversation membership immutable after task creation.
- Added `ConversationQuery` to Storage and transaction conversation scans.
- Added required `StoredDocument.deltasSinceBase` to Storage document reads.
- Task definitions now require an exhaustive `phases` map and an `abort` handler; define them with `defineTask()`.
- `RegistryReader` now requires `subscribe()`.
- Removed `Tx.setTask()`; a task changes its own state by returning the next state from its `runtime.commit()` callback.
- `Session.subscribeClose()` listeners now run synchronously when close begins, after admission is sealed.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.
- Added policy-driven backend-side conversation document copying when creating forks.
- Added indexed conversation ownership queries and guaranteed no-effect Storage rejection handling.
- Added incarnation-bound read-only Chord document states and serialized asynchronous document watches with bounded exact-frame buffering.
- Added `deltasSinceBase` checkpoint predicate information so definitions can bound replay without value counters.
- Added `Harness.open()` with lazy root creation, atomic conversation creation and forks with `init`, conversation-bound commits, fork-aware entry pagination, model context derivation, and the built-in `ConversationConfig` document with model, thinking level, and active tool accessors.
- Added `createRegistry()` for tools, tool wrappers, hooks, tasks, and system prompt sections with batched publication and stable keyed ordering.
- Added `defineEntry()` typed entry kinds.
- Added the durable task runtime: `defineTask()`, registry-resolved phase handlers with checkpoint progress rules decided on the Session line, migration at reservation, typed runtime commits, memos, `sleep()`, and invocation-owned watches, plus `Harness.resume()`, `getTask()`, `waitForTask()`, `abortTask()`, and task-aware `waitForIdle()` on the Harness and conversations. Open reconciles running tasks to pending; tasks without a fitting definition stay blocked until registration, and aborting them settles them as `orphaned`.

### Fixed

- Fixed cached documents skipping migration when accessed with a newer definition version, and older definitions reading values migrated only in memory. Document states and watches hydrated under another definition version receive the new value as a root replacement.

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.
