import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "@tursodatabase/database/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionDatabase } from "../../src/core/session-database.ts";
import { getDefaultSessionDir, type SessionListProgress, SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-turso-session-"));
	tempDirs.push(dir);
	return dir;
}

function appendConversation(session: SessionManager, text: string): void {
	session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `reply: ${text}` }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local Turso session storage", () => {
	it("stores sessions from different projects in one database and reopens by locator", async () => {
		const storeDir = makeTempDir();
		const projectA = join(storeDir, "project-a");
		const projectB = join(storeDir, "project-b");
		const sessionA = SessionManager.create(projectA, storeDir);
		appendConversation(sessionA, "from A");
		const sessionB = SessionManager.create(projectB, storeDir);
		appendConversation(sessionB, "from B");

		const databasePath = join(storeDir, "sessions.db");
		expect(existsSync(databasePath)).toBe(true);
		expect((await SessionManager.list(projectA, storeDir)).map((session) => session.id)).toEqual([
			sessionA.getSessionId(),
		]);
		expect((await SessionManager.listAll(storeDir)).map((session) => session.id).sort()).toEqual(
			[sessionA.getSessionId(), sessionB.getSessionId()].sort(),
		);

		const reopened = SessionManager.open(sessionA.getSessionFile()!, storeDir);
		expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("returns absolute locators when the custom database directory is relative", async () => {
		const storeDir = makeTempDir();
		const relativeStoreDir = relative(process.cwd(), storeDir);
		const cwd = join(storeDir, "project");
		const session = SessionManager.create(cwd, relativeStoreDir);
		appendConversation(session, "relative database directory");

		const [listedSession] = await SessionManager.list(cwd, relativeStoreDir);
		expect(listedSession?.path).toBe(session.getSessionFile());
	});

	it("migrates legacy search text with the project-scoped schema", async () => {
		const storeDir = makeTempDir();
		const databasePath = join(storeDir, "sessions.db");
		const cwd = join(storeDir, "project");
		mkdirSync(cwd, { recursive: true });
		const timestamp = new Date().toISOString();
		const header = {
			type: "session",
			version: 3,
			id: "search-migration",
			timestamp,
			cwd,
		};
		const entry = {
			type: "message",
			id: "legacy-user-entry",
			parentId: null,
			timestamp,
			message: { role: "user", content: "legacy searchable text", timestamp: Date.now() },
		};
		const legacyDatabase = new DatabaseSync(databasePath);
		try {
			legacyDatabase.exec(`
				CREATE TABLE sessions (
					id TEXT PRIMARY KEY, header_json TEXT NOT NULL, cwd TEXT NOT NULL,
					created_at REAL NOT NULL, modified_at REAL NOT NULL, message_count INTEGER NOT NULL,
					first_message TEXT NOT NULL, all_messages_text TEXT NOT NULL, name TEXT, legacy_path TEXT
				);
				CREATE TABLE session_entries (
					session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_id TEXT NOT NULL,
					parent_id TEXT, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL,
					PRIMARY KEY (session_id, ordinal), UNIQUE (session_id, entry_id)
				);
				CREATE TABLE session_search_text (
					session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL,
					PRIMARY KEY (session_id, ordinal)
				);
			`);
			legacyDatabase
				.prepare(
					`INSERT INTO sessions
					 (id, header_json, cwd, created_at, modified_at, message_count, first_message, all_messages_text, name, legacy_path)
					 VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`,
				)
				.run(
					header.id,
					JSON.stringify(header),
					cwd,
					Date.parse(timestamp),
					Date.now(),
					"legacy searchable text",
					"legacy searchable text",
				);
			legacyDatabase
				.prepare(
					"INSERT INTO session_entries (session_id, ordinal, entry_id, parent_id, type, timestamp, data) VALUES (?, 0, ?, NULL, 'message', ?, ?)",
				)
				.run(header.id, entry.id, timestamp, JSON.stringify(entry));
			legacyDatabase
				.prepare("INSERT INTO session_search_text (session_id, ordinal, text) VALUES (?, 0, ?)")
				.run(header.id, "legacy searchable text");
		} finally {
			legacyDatabase.close();
		}

		const database = new SessionDatabase(databasePath);
		try {
			expect(database.listSessions(cwd, getDefaultSessionDir(cwd, storeDir))[0]?.allMessagesText).toBe(
				"legacy searchable text",
			);
		} finally {
			database.close();
		}

		const locator = await SessionManager.findById(cwd, header.id, storeDir);
		if (!locator) throw new Error("Expected migrated session locator");
		appendConversation(SessionManager.open(locator, storeDir), "new searchable text");
		const [session] = await SessionManager.list(cwd, storeDir);
		expect(session?.allMessagesText).toBe("legacy searchable text new searchable text reply: new searchable text");
	});

	it("filters project summaries in the database query", async () => {
		const storeDir = makeTempDir();
		const projectA = join(storeDir, "project-a");
		const projectB = join(storeDir, "project-b");
		appendConversation(SessionManager.create(projectA, storeDir), "project A transcript");
		appendConversation(SessionManager.create(projectB, storeDir), "project B transcript");
		const listSessions = vi.spyOn(SessionDatabase.prototype, "listSessions");

		const sessions = await SessionManager.list(projectA, storeDir);

		expect(sessions.map((session) => session.cwd)).toEqual([projectA]);
		expect(listSessions).toHaveBeenCalledWith(projectA, expect.any(String));
		expect(listSessions).toHaveBeenCalledTimes(1);
	});

	it("allows the same session id in different projects but rejects it within one project", async () => {
		const storeDir = makeTempDir();
		const projectA = join(storeDir, "project-a");
		const projectB = join(storeDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		const sessionA = SessionManager.create(projectA, storeDir, { id: "shared-id" });
		appendConversation(sessionA, "project A transcript");
		const sessionB = SessionManager.create(projectB, storeDir, { id: "shared-id" });
		appendConversation(sessionB, "project B transcript");

		expect(sessionA.getSessionFile()).not.toBe(sessionB.getSessionFile());
		expect(await SessionManager.findById(projectA, "shared-id", storeDir)).toBe(sessionA.getSessionFile());
		expect(await SessionManager.findById(projectB, "shared-id", storeDir)).toBe(sessionB.getSessionFile());
		expect(SessionManager.open(sessionA.getSessionFile()!, storeDir).getEntries()[0]).toMatchObject({
			message: { content: "project A transcript" },
		});
		expect(SessionManager.open(sessionB.getSessionFile()!, storeDir).getEntries()[0]).toMatchObject({
			message: { content: "project B transcript" },
		});
		const legacyLocator = `pi-session://${Buffer.from(join(storeDir, "sessions.db")).toString("base64url")}/${Buffer.from("shared-id").toString("base64url")}`;
		expect(() => SessionManager.open(legacyLocator, storeDir)).toThrow("ambiguous for duplicate session id");
		expect(() => SessionManager.create(projectA, storeDir, { id: "shared-id" })).toThrow("Session id already exists");
	});

	it("keeps the locator database directory when an explicit directory disagrees", () => {
		const storeDir = makeTempDir();
		const otherDir = makeTempDir();
		const session = SessionManager.create(join(storeDir, "project"), storeDir, { id: "locator-directory" });
		appendConversation(session, "stored in custom database");

		const reopened = SessionManager.open(session.getSessionFile()!, otherDir);
		expect(reopened.getSessionDatabasePath()).toBe(join(storeDir, "sessions.db"));
		expect(reopened.getSessionDir()).toBe(storeDir);
		expect(reopened.getEntries()).toHaveLength(2);
	});

	it("updates the session directory when switching to a locator in another database", async () => {
		const firstStoreDir = makeTempDir();
		const secondStoreDir = makeTempDir();
		const project = join(secondStoreDir, "project");
		const manager = SessionManager.create(join(firstStoreDir, "project"), firstStoreDir);
		const target = SessionManager.create(project, secondStoreDir);
		appendConversation(target, "target database session");

		manager.setSessionFile(target.getSessionFile()!);

		expect(manager.getSessionDatabasePath()).toBe(join(secondStoreDir, "sessions.db"));
		expect(manager.getSessionDir()).toBe(secondStoreDir);
		expect((await SessionManager.list(project, manager.getSessionDir())).map((session) => session.id)).toEqual([
			target.getSessionId(),
		]);
	});

	it("does not overwrite a session created by another process during the first flush", () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const first = SessionManager.create(cwd, storeDir, { id: "racing-id" });
		const second = SessionManager.create(cwd, storeDir, { id: "racing-id" });

		appendConversation(first, "first writer");
		expect(() => appendConversation(second, "second writer")).toThrow("Session id already exists");

		const storedEntries = SessionManager.open(first.getSessionFile()!, storeDir).getEntries();
		expect(
			storedEntries.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "first writer",
			),
		).toBe(true);
		expect(
			storedEntries.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "second writer",
			),
		).toBe(false);
	});

	it("finds an exact ID without loading every session summary", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const session = SessionManager.create(cwd, storeDir, { id: "narrow-lookup" });
		appendConversation(session, "target session");
		const listSessions = vi.spyOn(SessionDatabase.prototype, "listSessions").mockImplementation(() => {
			throw new Error("full session listing should not be used for exact ID lookup");
		});

		expect(await SessionManager.findById(cwd, "narrow-lookup", storeDir)).toBe(session.getSessionFile());
		expect(listSessions).not.toHaveBeenCalled();
	});

	it("imports legacy JSONL without modifying it", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const legacyPath = join(storeDir, "old-session.jsonl");
		const timestamp = new Date().toISOString();
		const source = [
			JSON.stringify({ type: "session", version: 3, id: "legacy-id", timestamp, cwd }),
			JSON.stringify({
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp,
				message: { role: "user", content: "from legacy", timestamp: Date.now() },
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp,
				message: { role: "assistant", content: "legacy reply", timestamp: Date.now() },
			}),
		].join("\n");
		writeFileSync(legacyPath, source);

		const [info] = await SessionManager.list(cwd, storeDir);
		expect(info?.id).toBe("legacy-id");
		expect(info?.path).toMatch(/^pi-session:\/\//);
		expect(readFileSync(legacyPath, "utf8")).toBe(source);
		expect(SessionManager.open(info!.path, storeDir).getEntries()).toHaveLength(2);
	});

	it("fails malformed legacy imports and retries after the archive is corrected", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const legacyPath = join(storeDir, "malformed-session.jsonl");
		const timestamp = new Date().toISOString();
		const header = JSON.stringify({ type: "session", version: 3, id: "malformed-id", timestamp, cwd });
		writeFileSync(legacyPath, `${header}\nnot-json\n`);

		await expect(SessionManager.list(cwd, storeDir)).rejects.toMatchObject({
			message: expect.stringContaining(`Failed to import legacy session archive ${legacyPath}`),
			cause: expect.any(SyntaxError),
		});
		const database = new SessionDatabase(join(storeDir, "sessions.db"));
		expect(database.getMetadata("legacy-jsonl-import-v3")).toBeUndefined();
		expect(database.hasSession("malformed-id", cwd)).toBe(false);
		database.close();

		writeFileSync(
			legacyPath,
			`${header}\n${JSON.stringify({
				type: "message",
				id: "valid-entry",
				parentId: null,
				timestamp,
				message: { role: "user", content: "recovered", timestamp: Date.now() },
			})}\n`,
		);
		expect((await SessionManager.list(cwd, storeDir)).map((session) => session.id)).toEqual(["malformed-id"]);
	});

	it("does not reimport a deleted legacy session while archive migration is pending", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const legacyPath = join(storeDir, "deleted-session.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "deleted-id", timestamp, cwd })}\n`,
		);

		const opened = SessionManager.open(legacyPath, storeDir);
		const locator = opened.getSessionFile()!;
		expect(SessionManager.delete(locator)).toBe(true);
		expect(await SessionManager.list(cwd, storeDir)).toEqual([]);
		expect(() => SessionManager.open(legacyPath, storeDir)).toThrow("Cannot open deleted legacy session archive");
		expect(await SessionManager.list(cwd, storeDir)).toEqual([]);
	});

	it("migrates v1 legacy archives before importing them", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const legacyPath = join(storeDir, "v1-session.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			legacyPath,
			[
				JSON.stringify({ type: "session", id: "v1-id", timestamp, cwd }),
				JSON.stringify({ type: "message", timestamp, message: { role: "user", content: "hello", timestamp: 1 } }),
				JSON.stringify({ type: "message", timestamp, message: { role: "assistant", content: "hi", timestamp: 2 } }),
				JSON.stringify({
					type: "compaction",
					timestamp,
					summary: "summary",
					firstKeptEntryIndex: 1,
					tokensBefore: 10,
				}),
			].join("\n"),
		);

		const [info] = await SessionManager.list(cwd, storeDir);
		const entries = SessionManager.open(info!.path, storeDir).getEntries();
		expect(entries.map((entry) => entry.id)).toHaveLength(3);
		expect(entries[0]?.parentId).toBeNull();
		expect(entries[1]?.parentId).toBe(entries[0]?.id);
		expect(entries[2]).toMatchObject({ type: "compaction", firstKeptEntryId: entries[0]?.id });
		expect(info?.allMessagesText).toBe("hello hi");
	});

	it("yields during large legacy imports so progress and cancellation can run", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const timestamp = new Date().toISOString();
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "yielding-import", timestamp, cwd }),
			...Array.from({ length: 300 }, (_, index) =>
				JSON.stringify({
					type: "message",
					id: `entry-${index}`,
					parentId: index === 0 ? null : `entry-${index - 1}`,
					timestamp,
					message: {
						role: index % 2 === 0 ? "user" : "assistant",
						content: `message ${index}`,
						timestamp: Date.now(),
					},
				}),
			),
		];
		writeFileSync(join(storeDir, "yielding-import.jsonl"), `${lines.join("\n")}\n`);
		const controller = new AbortController();
		let writeProgressCalls = 0;
		let abortScheduled = false;
		const progress: SessionListProgress = (_loaded, _total, _sessions, stage) => {
			if (stage === "writing") {
				writeProgressCalls++;
				if (!abortScheduled) {
					abortScheduled = true;
					setImmediate(() => controller.abort());
				}
			}
		};

		await expect(SessionManager.list(cwd, storeDir, progress, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(writeProgressCalls).toBeGreaterThan(0);
		const database = new SessionDatabase(join(storeDir, "sessions.db"));
		expect(database.hasSession("yielding-import", cwd)).toBe(false);
		database.close();
		expect((await SessionManager.list(cwd, storeDir)).map((session) => session.id)).toEqual(["yielding-import"]);
	});

	it("opens a legacy JSONL session whose header has no cwd", () => {
		const storeDir = makeTempDir();
		const legacyPath = join(storeDir, "missing-cwd.jsonl");
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "missing-cwd", timestamp: new Date().toISOString() })}\n`,
		);

		const opened = SessionManager.open(legacyPath, storeDir);
		const locator = opened.getSessionFile();
		expect(locator).toMatch(/^pi-session:\/\//);
		expect(opened.hasStoredSession()).toBe(true);
		expect(SessionManager.open(locator!, storeDir).getSessionId()).toBe("missing-cwd");
	});

	it("imports custom agentDir archives even when an older import marker is complete", async () => {
		const agentDir = makeTempDir();
		const cwd = join(agentDir, "project");
		const legacyDir = getDefaultSessionDir(cwd, agentDir);
		const legacyPath = join(legacyDir, "custom-archive.jsonl");
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "custom-archive", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
		);
		writeFileSync(
			join(legacyDir, "custom-missing-cwd.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "custom-missing-cwd", timestamp: "2026-01-02T00:00:00.000Z" })}\n`,
		);
		const oldDatabase = new SessionDatabase(join(agentDir, "sessions.db"));
		oldDatabase.setMetadata("legacy-jsonl-import-v2", "complete");
		oldDatabase.close();

		const sessions = await SessionManager.list(cwd, agentDir);
		expect(sessions.map((session) => session.id).sort()).toEqual(["custom-archive", "custom-missing-cwd"]);
		expect(sessions.find((session) => session.id === "custom-archive")?.legacyPath).toBe(legacyPath);
		expect(await SessionManager.findById(cwd, "custom-missing-cwd", agentDir)).toBe(
			sessions.find((session) => session.id === "custom-missing-cwd")?.path,
		);
		const database = new SessionDatabase(join(agentDir, "sessions.db"));
		try {
			expect(database.getMetadata("legacy-jsonl-import-v3")).toBe("complete");
		} finally {
			database.close();
		}
	});

	it("rejects legacy archives with duplicate IDs instead of completing migration", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const timestamp = new Date().toISOString();
		for (const filename of ["first.jsonl", "second.jsonl"]) {
			writeFileSync(
				join(storeDir, filename),
				`${JSON.stringify({ type: "session", version: 3, id: "duplicate-legacy-id", timestamp, cwd })}\n`,
			);
		}

		await expect(SessionManager.list(cwd, storeDir)).rejects.toThrow("Failed to import legacy session archive");
		const database = new SessionDatabase(join(storeDir, "sessions.db"));
		try {
			expect(database.getMetadata("legacy-jsonl-import-v3")).toBeUndefined();
			expect(database.listSessions()).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	it("resolves imported legacy parent paths to session locators", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const parentPath = join(storeDir, "parent.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			parentPath,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy-parent", timestamp, cwd })}\n`,
		);
		writeFileSync(
			join(storeDir, "child.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "legacy-child",
				timestamp,
				cwd,
				parentSession: parentPath,
			})}\n`,
		);

		const sessions = await SessionManager.list(cwd, storeDir);
		const parent = sessions.find((session) => session.id === "legacy-parent");
		const child = sessions.find((session) => session.id === "legacy-child");
		expect(parent).toBeDefined();
		expect(child?.parentSessionPath).toBe(parent?.path);
	});

	it("discovers legacy sessions with missing or empty cwd from their archived project directory", async () => {
		const agentDir = makeTempDir();
		const cwd = join(agentDir, "project");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const legacyDir = getDefaultSessionDir(cwd, agentDir);
		const timestamp = new Date().toISOString();
		writeFileSync(
			join(legacyDir, "missing-cwd.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "missing-cwd", timestamp })}\n`,
		);
		writeFileSync(
			join(legacyDir, "empty-cwd.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "empty-cwd", timestamp, cwd: "" })}\n`,
		);

		const sessions = await SessionManager.list(cwd);
		expect(sessions.map((session) => session.id).sort()).toEqual(["empty-cwd", "missing-cwd"]);
		expect(await SessionManager.findById(cwd, "missing-cwd")).toBe(
			sessions.find((session) => session.id === "missing-cwd")?.path,
		);
		expect(["empty-cwd", "missing-cwd"]).toContain((await SessionManager.continueRecent(cwd)).getSessionId());
	});

	it("retries legacy import after a transient database failure", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const legacyPath = join(storeDir, "retry-session.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(legacyPath, `${JSON.stringify({ type: "session", version: 3, id: "retry-id", timestamp, cwd })}\n`);
		const database = new SessionDatabase(join(storeDir, "sessions.db"));
		database.setMetadata("legacy-jsonl-import-v1", "complete");
		database.close();
		vi.spyOn(SessionDatabase.prototype, "importSessionAsync").mockImplementationOnce(async () => {
			throw new Error("temporary write failure");
		});

		await expect(SessionManager.list(cwd, storeDir)).rejects.toThrow("Failed to import legacy session archive");
		const sessions = await SessionManager.list(cwd, storeDir);
		expect(sessions.map((session) => session.id)).toContain("retry-id");
	});

	it("imports symlinked legacy JSONL files", async () => {
		const storeDir = makeTempDir();
		const sourceDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const targetPath = join(sourceDir, "target.jsonl");
		const linkedPath = join(storeDir, "linked.jsonl");
		writeFileSync(
			targetPath,
			`${JSON.stringify({ type: "session", version: 3, id: "symlink-id", timestamp: new Date().toISOString(), cwd })}\n`,
		);
		symlinkSync(targetPath, linkedPath);

		const sessions = await SessionManager.list(cwd, storeDir);
		expect(sessions.map((session) => session.id)).toContain("symlink-id");
	});

	it.skipIf(process.platform === "win32")(
		"imports JSONL files from symlinked legacy session directories",
		async () => {
			const agentDir = makeTempDir();
			const sourceDir = makeTempDir();
			const cwd = join(agentDir, "project");
			const sessionsDir = join(agentDir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			writeFileSync(
				join(sourceDir, "directory-session.jsonl"),
				`${JSON.stringify({ type: "session", version: 3, id: "linked-directory-id", timestamp: new Date().toISOString(), cwd })}\n`,
			);
			symlinkSync(sourceDir, join(sessionsDir, "linked-project"), "dir");

			const sessions = await SessionManager.list(cwd);
			expect(sessions.map((session) => session.id)).toContain("linked-directory-id");
		},
	);

	it("migrates existing database rows to project-scoped session ids", async () => {
		const storeDir = makeTempDir();
		const projectA = join(storeDir, "project-a");
		const projectB = join(storeDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		const database = new DatabaseSync(join(storeDir, "sessions.db"));
		database.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY, header_json TEXT NOT NULL, cwd TEXT NOT NULL, created_at REAL NOT NULL,
				modified_at REAL NOT NULL, message_count INTEGER NOT NULL, first_message TEXT NOT NULL,
				all_messages_text TEXT NOT NULL, name TEXT, legacy_path TEXT
			);
			CREATE TABLE session_entries (
				session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT,
				type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL,
				PRIMARY KEY (session_id, ordinal), UNIQUE (session_id, entry_id)
			);
			CREATE TABLE session_store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE session_trash (
				id TEXT PRIMARY KEY, header_json TEXT NOT NULL, entries_json TEXT NOT NULL,
				legacy_path TEXT, deleted_at REAL NOT NULL
			);
		`);
		const timestamp = new Date().toISOString();
		const header = { type: "session", version: 3, id: "same-id", timestamp, cwd: projectA };
		const entry = {
			type: "message",
			id: "legacy-entry",
			parentId: null,
			timestamp,
			message: { role: "user", content: "legacy transcript", timestamp: Date.now() },
		};
		database
			.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				"same-id",
				JSON.stringify(header),
				projectA,
				Date.now(),
				Date.now(),
				1,
				"legacy transcript",
				"legacy transcript",
				null,
				null,
			);
		database
			.prepare("INSERT INTO session_entries VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run("same-id", 0, entry.id, null, entry.type, timestamp, JSON.stringify(entry));
		database.close();

		const migrated = await SessionManager.list(projectA, storeDir);
		expect(migrated[0]?.id).toBe("same-id");
		const second = SessionManager.create(projectB, storeDir, { id: "same-id" });
		appendConversation(second, "new project transcript");
		expect((await SessionManager.list(projectB, storeDir)).map((session) => session.id)).toEqual(["same-id"]);
		expect(SessionManager.open(migrated[0]!.path, storeDir).getEntries()[0]?.id).toBe("legacy-entry");
	});

	it("keeps session search text append-only instead of rewriting the accumulated summary", async () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const session = SessionManager.create(cwd, storeDir);
		appendConversation(session, "initial searchable text");
		appendConversation(session, "later searchable text");

		const database = new Database(join(storeDir, "sessions.db"), { readonly: true, experimental: ["index_method"] });
		try {
			const row = database
				.prepare("SELECT all_messages_text FROM sessions WHERE id = ? AND cwd = ?")
				.get(session.getSessionId(), cwd) as { all_messages_text: string };
			expect(row.all_messages_text).toContain("initial searchable text");
			expect(row.all_messages_text).not.toContain("later searchable text");
		} finally {
			database.close();
		}
		const [info] = await SessionManager.list(cwd, storeDir);
		expect(info?.allMessagesText).toContain("initial searchable text");
		expect(info?.allMessagesText).toContain("later searchable text");
	});

	it("moves deleted sessions into database trash and restores them", () => {
		const storeDir = makeTempDir();
		const session = SessionManager.create(join(storeDir, "project"), storeDir);
		appendConversation(session, "recoverable");
		const locator = session.getSessionFile()!;

		expect(SessionManager.delete(locator)).toBe(true);
		expect(session.hasStoredSession()).toBe(false);
		expect(SessionManager.restoreDeleted(locator)).toBe(true);
		expect(SessionManager.open(locator, storeDir).getSessionId()).toBe(session.getSessionId());
	});

	it("reserves a deleted custom ID until its session is restored", () => {
		const storeDir = makeTempDir();
		const cwd = join(storeDir, "project");
		const session = SessionManager.create(cwd, storeDir, { id: "deleted-custom-id" });
		appendConversation(session, "keep this trashed transcript");
		const locator = session.getSessionFile()!;

		expect(SessionManager.delete(locator)).toBe(true);
		expect(() => SessionManager.create(cwd, storeDir, { id: "deleted-custom-id" })).toThrow(
			"Session id already exists: deleted-custom-id",
		);
		expect(SessionManager.restoreDeleted(locator)).toBe(true);
		expect(SessionManager.open(locator, storeDir).getEntries()[0]).toMatchObject({
			message: { role: "user", content: "keep this trashed transcript" },
		});
	});
});
