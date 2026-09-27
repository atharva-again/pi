import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { SessionEntry, SessionHeader, SessionInfo } from "./session-manager.ts";

interface SqliteStatement {
	run(...parameters: unknown[]): unknown;
	get(...parameters: unknown[]): unknown;
	all(...parameters: unknown[]): unknown[];
}

interface SqliteConnection {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteConstructor {
	new (
		path: string,
		options?: {
			timeout?: number;
			readonly?: boolean;
			fileMustExist?: boolean;
			experimental?: Array<"index_method">;
		},
	): SqliteConnection;
}

interface SqliteOpenOptions {
	readonly?: boolean;
	fileMustExist?: boolean;
}

const requireFromSessionDatabase = createRequire(import.meta.url);

function getTursoDatabaseConstructor(): SqliteConstructor {
	try {
		return (requireFromSessionDatabase("@tursodatabase/database/compat") as { Database: SqliteConstructor }).Database;
	} catch (error) {
		throw new Error("Failed to load @tursodatabase/database/compat", { cause: error });
	}
}

function openDatabase(path: string, options?: SqliteOpenOptions): SqliteConnection {
	const TursoDatabase = getTursoDatabaseConstructor();
	return new TursoDatabase(path, { timeout: 5000, experimental: ["index_method"], ...options });
}

interface SessionSummary {
	id: string;
	header: SessionHeader;
	cwd: string;
	createdAt: number;
	modifiedAt: number;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	name?: string;
	legacyPath?: string;
}

export interface SessionSearchHit {
	sessionId: string;
	cwd: string;
	entryId: string;
	ordinal: number;
	timestamp: string;
	sessionName?: string;
	score: number;
	excerpt: string;
}

export interface SessionEntryContext {
	before: SessionEntry[];
	anchor: SessionEntry;
	after: SessionEntry[];
}

interface SessionSearchRow {
	session_id: string;
	cwd: string;
	entry_id: string | null;
	ordinal: number;
	timestamp: string | null;
	session_name: string | null;
	score: number;
	match_pos: number;
	text_length: number;
	excerpt: string;
}

type SessionImportResult = "imported" | "already-imported" | "deleted";

interface SessionRow {
	id: string;
	header_json: string;
	cwd: string;
	created_at: number;
	modified_at: number;
	message_count: number;
	first_message: string;
	all_messages_text: string;
	name: string | null;
	legacy_path: string | null;
}

interface SessionAppendRow {
	id: string;
	header_json: string;
	cwd: string;
	created_at: number;
	modified_at: number;
	message_count: number;
	first_message: string;
	name: string | null;
	legacy_path: string | null;
}

interface EntryRow {
	data: string;
}

interface KeyValueRow {
	value: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT NOT NULL,
	header_json TEXT NOT NULL,
	cwd TEXT NOT NULL,
	created_at REAL NOT NULL,
	modified_at REAL NOT NULL,
	message_count INTEGER NOT NULL,
	first_message TEXT NOT NULL,
	all_messages_text TEXT NOT NULL,
	name TEXT,
	legacy_path TEXT,
	PRIMARY KEY (id, cwd)
);
CREATE TABLE IF NOT EXISTS session_entries (
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	parent_id TEXT,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	data TEXT NOT NULL,
	PRIMARY KEY (session_id, cwd, ordinal),
	UNIQUE (session_id, cwd, entry_id)
);
CREATE INDEX IF NOT EXISTS session_entries_parent_idx ON session_entries(session_id, cwd, parent_id);
CREATE TABLE IF NOT EXISTS session_search_text (
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (session_id, cwd, ordinal)
);
CREATE INDEX IF NOT EXISTS session_search_text_fts_idx ON session_search_text USING fts (text);
CREATE TABLE IF NOT EXISTS session_store_metadata (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_trash (
	id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	header_json TEXT NOT NULL,
	entries_json TEXT NOT NULL,
	legacy_path TEXT,
	deleted_at REAL NOT NULL,
	PRIMARY KEY (id, cwd)
);
`;

const SESSION_SEARCH_TEXT_METADATA_KEY = "session-search-text-v1";
const SESSION_IMPORT_BATCH_SIZE = 100;

interface TableColumn {
	name: string;
	pk: number;
}

interface LegacyEntryRow {
	session_id: string;
	cwd?: string;
	ordinal: number;
	entry_id: string;
	parent_id: string | null;
	type: string;
	timestamp: string;
	data: string;
}

interface LegacySearchTextRow {
	session_id: string;
	cwd?: string;
	ordinal: number;
	text: string;
}

interface LegacyTrashRow {
	id: string;
	header_json: string;
	entries_json: string;
	legacy_path: string | null;
	deleted_at: number;
}

function normalizedCwd(cwd: string): string {
	return cwd ? resolvePath(cwd) : "";
}

function tableExists(db: SqliteConnection, name: string): boolean {
	return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function tableColumns(db: SqliteConnection, table: string): TableColumn[] {
	return db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
}

function ensureColumn(db: SqliteConnection, table: string, column: string, definition: string): void {
	if (!tableColumns(db, table).some((item) => item.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

function primaryKeyColumns(db: SqliteConnection, table: string): string[] {
	return tableColumns(db, table)
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk)
		.map((column) => column.name);
}

function hasPrimaryKey(db: SqliteConnection, table: string, candidates: string[][]): boolean {
	const primaryKey = primaryKeyColumns(db, table);
	return candidates.some(
		(columns) =>
			primaryKey.length === columns.length && primaryKey.every((column, index) => column === columns[index]),
	);
}

function hasCompositePrimaryKey(db: SqliteConnection, table: string, columns: string[]): boolean {
	return hasPrimaryKey(db, table, [columns]);
}

function assertColumns(db: SqliteConnection, table: string, columns: string[], path: string): void {
	const presentColumns = new Set(tableColumns(db, table).map((column) => column.name));
	if (columns.some((column) => !presentColumns.has(column))) {
		throw new Error(`Refusing to open session database with an incompatible ${table} schema: ${path}`);
	}
}

/** Validate a recognized current or pre-project-scoping Pi schema before allowing migrations. */
function assertKnownSessionDatabaseSchema(db: SqliteConnection, path: string): void {
	if (!tableExists(db, "sessions") || !tableExists(db, "session_entries")) {
		throw new Error(`Refusing to open unrecognized session database: ${path}`);
	}
	assertColumns(
		db,
		"sessions",
		[
			"id",
			"header_json",
			"cwd",
			"created_at",
			"modified_at",
			"message_count",
			"first_message",
			"all_messages_text",
			"name",
		],
		path,
	);
	assertColumns(
		db,
		"session_entries",
		["session_id", "ordinal", "entry_id", "parent_id", "type", "timestamp", "data"],
		path,
	);
	if (tableExists(db, "session_store_metadata")) {
		assertColumns(db, "session_store_metadata", ["key", "value"], path);
	}
	if (
		!hasPrimaryKey(db, "sessions", [["id"], ["id", "cwd"]]) ||
		!hasPrimaryKey(db, "session_entries", [
			["session_id", "ordinal"],
			["session_id", "cwd", "ordinal"],
		]) ||
		(tableExists(db, "session_store_metadata") && !hasPrimaryKey(db, "session_store_metadata", [["key"]]))
	) {
		throw new Error(`Refusing to open session database with an incompatible schema: ${path}`);
	}
	if (tableExists(db, "session_search_text")) {
		assertColumns(db, "session_search_text", ["session_id", "ordinal", "text"], path);
		if (
			!hasPrimaryKey(db, "session_search_text", [
				["session_id", "ordinal"],
				["session_id", "cwd", "ordinal"],
			])
		) {
			throw new Error(`Refusing to open session database with an incompatible search-text schema: ${path}`);
		}
	}
	if (tableExists(db, "session_trash")) {
		assertColumns(db, "session_trash", ["id", "header_json", "entries_json", "deleted_at"], path);
		if (!hasPrimaryKey(db, "session_trash", [["id"], ["id", "cwd"]])) {
			throw new Error(`Refusing to open session database with an incompatible trash schema: ${path}`);
		}
	}
}

function assertCurrentPiSessionDatabase(db: SqliteConnection, path: string): void {
	assertKnownSessionDatabaseSchema(db, path);
	const requiredTables = ["session_search_text", "session_trash"];
	if (requiredTables.some((table) => !tableExists(db, table))) {
		throw new Error(`Session database migration did not produce the current schema: ${path}`);
	}
	assertColumns(db, "sessions", ["legacy_path"], path);
	assertColumns(db, "session_entries", ["cwd"], path);
	assertColumns(db, "session_search_text", ["cwd"], path);
	assertColumns(db, "session_trash", ["cwd", "legacy_path"], path);
	if (
		!hasCompositePrimaryKey(db, "sessions", ["id", "cwd"]) ||
		!hasCompositePrimaryKey(db, "session_entries", ["session_id", "cwd", "ordinal"]) ||
		!hasCompositePrimaryKey(db, "session_search_text", ["session_id", "cwd", "ordinal"]) ||
		!hasCompositePrimaryKey(db, "session_trash", ["id", "cwd"])
	) {
		throw new Error(`Session database migration did not produce the current schema: ${path}`);
	}
	const marker = db
		.prepare("SELECT value FROM session_store_metadata WHERE key = ?")
		.get(SESSION_SEARCH_TEXT_METADATA_KEY) as KeyValueRow | undefined;
	if (marker?.value !== "complete") {
		throw new Error(`Session database is missing Pi session-store metadata: ${path}`);
	}
}

function validateExistingSessionDatabase(path: string): void {
	if (!statSync(path).isFile()) throw new Error(`Session database is not a regular file: ${path}`);
	const db = openDatabase(path, { readonly: true, fileMustExist: true });
	try {
		assertKnownSessionDatabaseSchema(db, path);
	} finally {
		db.close();
	}
}

function migrateProjectScopedSchema(db: SqliteConnection): void {
	if (
		hasCompositePrimaryKey(db, "sessions", ["id", "cwd"]) &&
		hasCompositePrimaryKey(db, "session_entries", ["session_id", "cwd", "ordinal"]) &&
		hasCompositePrimaryKey(db, "session_search_text", ["session_id", "cwd", "ordinal"]) &&
		hasCompositePrimaryKey(db, "session_trash", ["id", "cwd"])
	) {
		return;
	}

	ensureColumn(db, "sessions", "legacy_path", "TEXT");
	if (tableExists(db, "session_trash")) ensureColumn(db, "session_trash", "legacy_path", "TEXT");

	inTransaction(db, () => {
		const sessions = db.prepare("SELECT * FROM sessions").all() as SessionRow[];
		const entries = db
			.prepare("SELECT * FROM session_entries ORDER BY session_id, ordinal")
			.all() as LegacyEntryRow[];
		const searchText = tableExists(db, "session_search_text")
			? (db.prepare("SELECT * FROM session_search_text ORDER BY session_id, ordinal").all() as LegacySearchTextRow[])
			: [];
		const trash = tableExists(db, "session_trash")
			? (db.prepare("SELECT * FROM session_trash").all() as LegacyTrashRow[])
			: [];
		const cwdBySessionId = new Map<string, Set<string>>();
		for (const row of sessions) {
			const cwd = normalizedCwd(row.cwd);
			const cwds = cwdBySessionId.get(row.id) ?? new Set<string>();
			cwds.add(cwd);
			cwdBySessionId.set(row.id, cwds);
		}
		const getMigratedCwd = (sessionId: string, rowCwd: string | undefined): string => {
			const cwds = cwdBySessionId.get(sessionId);
			if (!cwds) throw new Error(`Cannot migrate data for orphaned session ${sessionId}`);
			if (rowCwd !== undefined) {
				const cwd = normalizedCwd(rowCwd);
				if (!cwds.has(cwd)) {
					throw new Error(`Cannot migrate data for session ${sessionId} from unexpected project ${cwd}`);
				}
				return cwd;
			}
			if (cwds.size !== 1) throw new Error(`Cannot migrate unscoped data for duplicate session id ${sessionId}`);
			return cwds.values().next().value!;
		};

		db.exec(`
			DROP TABLE IF EXISTS sessions_project_scoped_new;
			DROP TABLE IF EXISTS session_entries_project_scoped_new;
			DROP TABLE IF EXISTS session_search_text_project_scoped_new;
			DROP TABLE IF EXISTS session_trash_project_scoped_new;
			CREATE TABLE sessions_project_scoped_new (
				id TEXT NOT NULL,
				header_json TEXT NOT NULL,
				cwd TEXT NOT NULL,
				created_at REAL NOT NULL,
				modified_at REAL NOT NULL,
				message_count INTEGER NOT NULL,
				first_message TEXT NOT NULL,
				all_messages_text TEXT NOT NULL,
				name TEXT,
				legacy_path TEXT,
				PRIMARY KEY (id, cwd)
			);
			CREATE TABLE session_entries_project_scoped_new (
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				entry_id TEXT NOT NULL,
				parent_id TEXT,
				type TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (session_id, cwd, ordinal),
				UNIQUE (session_id, cwd, entry_id)
			);
			CREATE TABLE session_search_text_project_scoped_new (
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				text TEXT NOT NULL,
				PRIMARY KEY (session_id, cwd, ordinal)
			);
			CREATE TABLE session_trash_project_scoped_new (
				id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				header_json TEXT NOT NULL,
				entries_json TEXT NOT NULL,
				legacy_path TEXT,
				deleted_at REAL NOT NULL,
				PRIMARY KEY (id, cwd)
			);
		`);

		const insertSession = db.prepare(
			`INSERT INTO sessions_project_scoped_new
			 (id, header_json, cwd, created_at, modified_at, message_count, first_message, all_messages_text, name, legacy_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const row of sessions) {
			const cwd = normalizedCwd(row.cwd);
			insertSession.run(
				row.id,
				row.header_json,
				cwd,
				row.created_at,
				row.modified_at,
				row.message_count,
				row.first_message,
				row.all_messages_text,
				row.name,
				row.legacy_path,
			);
		}

		const insertEntry = db.prepare(
			`INSERT INTO session_entries_project_scoped_new
			 (session_id, cwd, ordinal, entry_id, parent_id, type, timestamp, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const row of entries) {
			const cwd = getMigratedCwd(row.session_id, row.cwd);
			insertEntry.run(
				row.session_id,
				cwd,
				row.ordinal,
				row.entry_id,
				row.parent_id,
				row.type,
				row.timestamp,
				row.data,
			);
		}
		const insertSearchText = db.prepare(
			"INSERT INTO session_search_text_project_scoped_new (session_id, cwd, ordinal, text) VALUES (?, ?, ?, ?)",
		);
		for (const row of searchText) {
			const cwd = getMigratedCwd(row.session_id, row.cwd);
			insertSearchText.run(row.session_id, cwd, row.ordinal, row.text);
		}

		const insertTrash = db.prepare(
			`INSERT INTO session_trash_project_scoped_new
			 (id, cwd, header_json, entries_json, legacy_path, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const row of trash) {
			const header = JSON.parse(row.header_json) as SessionHeader;
			insertTrash.run(
				row.id,
				normalizedCwd(typeof header.cwd === "string" ? header.cwd : ""),
				row.header_json,
				row.entries_json,
				row.legacy_path,
				row.deleted_at,
			);
		}

		db.exec("DROP TABLE session_entries; DROP TABLE sessions;");
		if (tableExists(db, "session_search_text")) db.exec("DROP TABLE session_search_text;");
		if (tableExists(db, "session_trash")) db.exec("DROP TABLE session_trash;");
		db.exec(`
			ALTER TABLE sessions_project_scoped_new RENAME TO sessions;
			ALTER TABLE session_entries_project_scoped_new RENAME TO session_entries;
			ALTER TABLE session_search_text_project_scoped_new RENAME TO session_search_text;
			ALTER TABLE session_trash_project_scoped_new RENAME TO session_trash;
			CREATE INDEX session_entries_parent_idx ON session_entries(session_id, cwd, parent_id);
		`);
	});
}

function getHeaderTime(header: SessionHeader): number {
	const timestamp = Date.parse(header.timestamp);
	return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function messageText(entry: SessionEntry): { role: string; text: string } | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (content == null) return { role: message.role, text: "" };
	const text =
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(" ");
	return { role: message.role, text };
}

function getSearchSnippetTerms(query: string): string[] {
	const terms: string[] = [];
	for (const match of query.matchAll(/"([^"]+)"|[\p{L}\p{N}_*]+/gu)) {
		const term = (match[1] ?? match[0] ?? "").replace(/\*+$/u, "");
		if (!term || /^(AND|OR|NOT)$/iu.test(term)) continue;
		terms.push(term);
		if (terms.length >= 8) break;
	}
	return terms;
}

function getActivityTime(entry: SessionEntry): number | undefined {
	const text = messageText(entry);
	if (!text) return undefined;
	const message = entry.type === "message" ? entry.message : undefined;
	const timestamp = message && "timestamp" in message ? message.timestamp : undefined;
	if (typeof timestamp === "number") return timestamp;
	const fallback = Date.parse(entry.timestamp);
	return Number.isFinite(fallback) ? fallback : undefined;
}

function createSummary(header: SessionHeader, legacyPath?: string): SessionSummary {
	return {
		id: header.id,
		header,
		cwd: normalizedCwd(typeof header.cwd === "string" ? header.cwd : ""),
		createdAt: getHeaderTime(header),
		modifiedAt: getHeaderTime(header),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
		legacyPath,
	};
}

function buildSummary(header: SessionHeader, entries: SessionEntry[], legacyPath?: string): SessionSummary {
	const summary = createSummary(header, legacyPath);
	const searchableText: string[] = [];

	for (const entry of entries) applyEntry(summary, entry, searchableText);
	summary.allMessagesText = searchableText.join(" ");
	return summary;
}

function applyEntry(summary: SessionSummary, entry: SessionEntry, searchableText?: string[]): void {
	if (entry.type === "message") summary.messageCount++;
	if (entry.type === "session_info") summary.name = entry.name?.trim() || undefined;

	const message = messageText(entry);
	if (message) {
		if (message.text) {
			searchableText?.push(message.text);
			if (message.role === "user" && !summary.firstMessage) summary.firstMessage = message.text;
		}
		const activityTime = getActivityTime(entry);
		if (activityTime !== undefined) summary.modifiedAt = Math.max(summary.modifiedAt, activityTime);
	}
}

function entryInsert(db: SqliteConnection, sessionId: string, cwd: string, ordinal: number, entry: SessionEntry): void {
	db.prepare(
		`INSERT INTO session_entries (session_id, cwd, ordinal, entry_id, parent_id, type, timestamp, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(sessionId, cwd, ordinal, entry.id, entry.parentId, entry.type, entry.timestamp, JSON.stringify(entry));
}

function insertSearchText(
	db: SqliteConnection,
	sessionId: string,
	cwd: string,
	ordinal: number,
	entry: SessionEntry,
): void {
	const text = messageText(entry)?.text;
	if (!text) return;
	db.prepare("INSERT INTO session_search_text (session_id, cwd, ordinal, text) VALUES (?, ?, ?, ?)").run(
		sessionId,
		cwd,
		ordinal,
		text,
	);
}

function upsertSummary(db: SqliteConnection, summary: SessionSummary): void {
	db.prepare(
		`INSERT INTO sessions
		 (id, header_json, cwd, created_at, modified_at, message_count, first_message, all_messages_text, name, legacy_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id, cwd) DO UPDATE SET
		 header_json = excluded.header_json,
		 cwd = excluded.cwd,
		 created_at = excluded.created_at,
		 modified_at = excluded.modified_at,
		 message_count = excluded.message_count,
		 first_message = excluded.first_message,
		 all_messages_text = excluded.all_messages_text,
			name = excluded.name,
		 legacy_path = COALESCE(excluded.legacy_path, sessions.legacy_path)`,
	).run(
		summary.id,
		JSON.stringify(summary.header),
		summary.cwd,
		summary.createdAt,
		summary.modifiedAt,
		summary.messageCount,
		summary.firstMessage,
		summary.allMessagesText,
		summary.name ?? null,
		summary.legacyPath ?? null,
	);
}

function insertSummary(db: SqliteConnection, summary: SessionSummary): void {
	db.prepare(
		`INSERT INTO sessions
		 (id, header_json, cwd, created_at, modified_at, message_count, first_message, all_messages_text, name, legacy_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		summary.id,
		JSON.stringify(summary.header),
		summary.cwd,
		summary.createdAt,
		summary.modifiedAt,
		summary.messageCount,
		summary.firstMessage,
		summary.allMessagesText,
		summary.name ?? null,
		summary.legacyPath ?? null,
	);
}

function insertEntries(db: SqliteConnection, sessionId: string, cwd: string, entries: SessionEntry[]): void {
	for (const [ordinal, entry] of entries.entries()) {
		entryInsert(db, sessionId, cwd, ordinal, entry);
		insertSearchText(db, sessionId, cwd, ordinal, entry);
	}
}

function updateSummary(db: SqliteConnection, summary: SessionSummary): void {
	db.prepare(
		`UPDATE sessions SET
		 header_json = ?, cwd = ?, created_at = ?, modified_at = ?, message_count = ?, first_message = ?, name = ?,
		 legacy_path = COALESCE(?, legacy_path)
		 WHERE id = ? AND cwd = ?`,
	).run(
		JSON.stringify(summary.header),
		summary.cwd,
		summary.createdAt,
		summary.modifiedAt,
		summary.messageCount,
		summary.firstMessage,
		summary.name ?? null,
		summary.legacyPath ?? null,
		summary.id,
		summary.cwd,
	);
}

function inTransaction<T>(db: SqliteConnection, callback: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = callback();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

/** Local Turso database access. Connections are short-lived so callers do not pin database files open. */
export class SessionDatabase {
	private readonly db: SqliteConnection;

	constructor(path: string, options?: { existing?: boolean }) {
		const existingDatabase = options?.existing || existsSync(path);
		if (existingDatabase) {
			validateExistingSessionDatabase(path);
		} else {
			mkdirSync(dirname(path), { recursive: true });
		}
		// Existing database paths and schemas were checked read-only above. Avoid Turso's
		// fileMustExist option for the writable reopen: it rejects some valid SQLite files.
		this.db = openDatabase(path);
		if (existingDatabase) {
			let validated = false;
			try {
				assertKnownSessionDatabaseSchema(this.db, path);
				validated = true;
			} finally {
				if (!validated) this.db.close();
			}
		}
		if (tableExists(this.db, "sessions")) {
			ensureColumn(this.db, "sessions", "legacy_path", "TEXT");
			if (tableExists(this.db, "session_trash")) ensureColumn(this.db, "session_trash", "legacy_path", "TEXT");
			migrateProjectScopedSchema(this.db);
		}
		this.db.exec(SCHEMA);
		this.migrateSearchText();
		if (options?.existing) assertCurrentPiSessionDatabase(this.db, path);
	}

	private migrateSearchText(): void {
		const row = this.db
			.prepare("SELECT value FROM session_store_metadata WHERE key = ?")
			.get(SESSION_SEARCH_TEXT_METADATA_KEY) as KeyValueRow | undefined;
		const projectionIsComplete = row?.value === "complete";
		if (projectionIsComplete) {
			const needsRebuild = this.db
				.prepare(
					`SELECT 1 AS found FROM sessions AS s
					 WHERE s.all_messages_text <> '' AND (
						 EXISTS (
							 SELECT 1 FROM session_search_text AS t
							 WHERE t.session_id = s.id AND t.cwd = s.cwd AND t.ordinal = -1
						 ) OR NOT EXISTS (
							 SELECT 1 FROM session_search_text AS t
							 WHERE t.session_id = s.id AND t.cwd = s.cwd AND t.ordinal >= 0
						 )
					 ) LIMIT 1`,
				)
				.get();
			if (!needsRebuild) return;
		}

		inTransaction(this.db, () => {
			const sessions = this.db.prepare("SELECT id, cwd FROM sessions").all() as Array<{ id: string; cwd: string }>;
			for (const session of sessions) {
				const hasEntryProjection = this.db
					.prepare(
						"SELECT 1 AS found FROM session_search_text WHERE session_id = ? AND cwd = ? AND ordinal >= 0 LIMIT 1",
					)
					.get(session.id, session.cwd);
				const hasAggregateProjection = this.db
					.prepare(
						"SELECT 1 AS found FROM session_search_text WHERE session_id = ? AND cwd = ? AND ordinal = -1 LIMIT 1",
					)
					.get(session.id, session.cwd);
				if (projectionIsComplete && hasEntryProjection && !hasAggregateProjection) continue;

				this.db
					.prepare("DELETE FROM session_search_text WHERE session_id = ? AND cwd = ?")
					.run(session.id, session.cwd);
				const entries = this.db
					.prepare("SELECT ordinal, data FROM session_entries WHERE session_id = ? AND cwd = ? ORDER BY ordinal")
					.all(session.id, session.cwd) as Array<{ ordinal: number; data: string }>;
				for (const storedEntry of entries) {
					const entry = JSON.parse(storedEntry.data) as SessionEntry;
					insertSearchText(this.db, session.id, session.cwd, storedEntry.ordinal, entry);
				}
			}
			this.db
				.prepare(
					"INSERT INTO session_store_metadata(key, value) VALUES (?, 'complete') ON CONFLICT(key) DO UPDATE SET value = 'complete'",
				)
				.run(SESSION_SEARCH_TEXT_METADATA_KEY);
		});
	}

	private resolveTrashCwd(id: string, cwd?: string): string | undefined {
		if (cwd !== undefined) return normalizedCwd(cwd);
		const rows = this.db.prepare("SELECT cwd FROM session_trash WHERE id = ?").all(id) as Array<{ cwd: string }>;
		if (rows.length > 1) throw new Error(`Deleted session locator is ambiguous for duplicate session id: ${id}`);
		return rows[0]?.cwd;
	}

	close(): void {
		this.db.close();
	}

	private resolveCwd(id: string, cwd?: string): string | undefined {
		if (cwd !== undefined) return normalizedCwd(cwd);
		const rows = this.db.prepare("SELECT cwd FROM sessions WHERE id = ?").all(id) as Array<{ cwd: string }>;
		if (rows.length > 1) throw new Error(`Session locator is ambiguous for duplicate session id: ${id}`);
		return rows[0]?.cwd;
	}

	private getImportDisposition(
		summary: SessionSummary,
		legacyPath?: string,
	): "already-imported" | "deleted" | undefined {
		const existing = this.db
			.prepare("SELECT legacy_path FROM sessions WHERE id = ? AND cwd = ?")
			.get(summary.id, summary.cwd) as { legacy_path: string | null } | undefined;
		if (existing) {
			if (
				legacyPath &&
				existing.legacy_path &&
				canonicalizePath(resolvePath(legacyPath)) === canonicalizePath(resolvePath(existing.legacy_path))
			) {
				return "already-imported";
			}
			throw new Error(
				`Cannot import session ${summary.id} from ${legacyPath ?? "an unknown archive"}: ` +
					`session id already exists in ${summary.cwd || "an unknown project"}`,
			);
		}

		const deleted = this.db
			.prepare("SELECT legacy_path FROM session_trash WHERE id = ? AND cwd = ?")
			.get(summary.id, summary.cwd) as { legacy_path: string | null } | undefined;
		if (!deleted) return undefined;
		if (
			legacyPath &&
			deleted.legacy_path &&
			canonicalizePath(resolvePath(legacyPath)) === canonicalizePath(resolvePath(deleted.legacy_path))
		) {
			return "deleted";
		}
		throw new Error(
			`Cannot import session ${summary.id} from ${legacyPath ?? "an unknown archive"}: ` +
				`session id is in database trash for ${summary.cwd || "an unknown project"}`,
		);
	}

	hasSession(id: string, cwd?: string): boolean {
		if (cwd !== undefined) {
			return (
				this.db.prepare("SELECT 1 AS found FROM sessions WHERE id = ? AND cwd = ?").get(id, normalizedCwd(cwd)) !==
				undefined
			);
		}
		return this.db.prepare("SELECT 1 AS found FROM sessions WHERE id = ? LIMIT 1").get(id) !== undefined;
	}

	hasDeletedSession(id: string, cwd?: string): boolean {
		if (cwd !== undefined) {
			return (
				this.db
					.prepare("SELECT 1 AS found FROM session_trash WHERE id = ? AND cwd = ?")
					.get(id, normalizedCwd(cwd)) !== undefined
			);
		}
		return this.db.prepare("SELECT 1 AS found FROM session_trash WHERE id = ? LIMIT 1").get(id) !== undefined;
	}

	findSessionsById(id: string): Array<{ id: string; cwd: string; legacy_path: string | null }> {
		return this.db.prepare("SELECT id, cwd, legacy_path FROM sessions WHERE id = ?").all(id) as Array<{
			id: string;
			cwd: string;
			legacy_path: string | null;
		}>;
	}

	readSession(id: string, cwd?: string): Array<SessionHeader | SessionEntry> | undefined {
		const resolvedCwd = this.resolveCwd(id, cwd);
		if (resolvedCwd === undefined) return undefined;
		const session = this.db
			.prepare("SELECT header_json FROM sessions WHERE id = ? AND cwd = ?")
			.get(id, resolvedCwd) as { header_json: string } | undefined;
		if (!session) return undefined;
		const header = JSON.parse(session.header_json) as SessionHeader;
		const rows = this.db
			.prepare("SELECT data FROM session_entries WHERE session_id = ? AND cwd = ? ORDER BY ordinal")
			.all(id, resolvedCwd) as EntryRow[];
		return [header, ...rows.map((row) => JSON.parse(row.data) as SessionEntry)];
	}

	readSessionContext(
		id: string,
		cwd: string,
		entryId: string,
		beforeCount: number,
		afterCount: number,
	): SessionEntryContext | undefined {
		if (
			!Number.isSafeInteger(beforeCount) ||
			beforeCount < 0 ||
			beforeCount > 100 ||
			!Number.isSafeInteger(afterCount) ||
			afterCount < 0 ||
			afterCount > 100
		) {
			throw new Error("Session context counts must be integers from 0 to 100");
		}
		const resolvedCwd = this.resolveCwd(id, cwd);
		if (resolvedCwd === undefined) return undefined;
		const readEntry = (targetId: string): SessionEntry | undefined => {
			const row = this.db
				.prepare("SELECT data FROM session_entries WHERE session_id = ? AND cwd = ? AND entry_id = ?")
				.get(id, resolvedCwd, targetId) as EntryRow | undefined;
			return row ? (JSON.parse(row.data) as SessionEntry) : undefined;
		};
		const anchor = readEntry(entryId);
		if (!anchor) return undefined;

		const before: SessionEntry[] = [];
		let current = anchor;
		for (let index = 0; index < beforeCount && current.parentId; index++) {
			const parent = readEntry(current.parentId);
			if (!parent) throw new Error(`Session entry ${current.id} has a missing parent ${current.parentId}`);
			before.unshift(parent);
			current = parent;
		}

		const after: SessionEntry[] = [];
		current = anchor;
		for (let index = 0; index < afterCount; index++) {
			const row = this.db
				.prepare(
					`SELECT data FROM session_entries WHERE session_id = ? AND cwd = ? AND parent_id = ?
					 ORDER BY ordinal DESC LIMIT 1`,
				)
				.get(id, resolvedCwd, current.id) as EntryRow | undefined;
			if (!row) break;
			current = JSON.parse(row.data) as SessionEntry;
			after.push(current);
		}
		return { before, anchor, after };
	}

	searchSessionText(query: string, options?: { cwdPrefixes?: string[]; limit?: number }): SessionSearchHit[] {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) throw new Error("Session search query must not be empty");
		const limit = options?.limit ?? 10;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Session search limit must be an integer from 1 to 100");
		}

		const cwdPrefixes = options?.cwdPrefixes;
		let cwdFilter = "";
		const cwdParameters: string[] = [];
		if (cwdPrefixes !== undefined) {
			const uniquePrefixes = [...new Set(cwdPrefixes.map((cwd) => resolvePath(cwd)))];
			if (uniquePrefixes.length === 0) return [];
			cwdFilter = ` AND (${uniquePrefixes.map(() => "(cwd = ? OR substr(cwd, 1, length(?)) = ?)").join(" OR ")})`;
			for (const cwd of uniquePrefixes) {
				const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
				cwdParameters.push(cwd, prefix, prefix);
			}
		}

		const snippetTerms = getSearchSnippetTerms(normalizedQuery);
		const snippetPositionTerms = snippetTerms.map(
			() => "COALESCE(NULLIF(instr(lower(text), lower(?)), 0), 2147483647)",
		);
		const matchPosition =
			snippetTerms.length === 0
				? "0"
				: snippetTerms.length === 1
					? "COALESCE(NULLIF(instr(lower(text), lower(?)), 0), 0)"
					: `COALESCE(NULLIF(min(${snippetPositionTerms.join(", ")}), 2147483647), 0)`;
		const querySql = `
			SELECT session_id, cwd, entry_id, ordinal, timestamp, session_name, score,
				match_pos, text_length,
				CASE WHEN match_pos > 0 THEN substr(text, max(match_pos - 160, 1), 420)
					ELSE substr(text, 1, 420) END AS excerpt
			FROM (
				SELECT session_search_text.session_id, session_search_text.cwd, session_search_text.ordinal,
					session_search_text.text,
					(SELECT entry_id FROM session_entries AS e
						WHERE e.session_id = session_search_text.session_id AND e.cwd = session_search_text.cwd
							AND e.ordinal = session_search_text.ordinal) AS entry_id,
					(SELECT timestamp FROM session_entries AS e
						WHERE e.session_id = session_search_text.session_id AND e.cwd = session_search_text.cwd
							AND e.ordinal = session_search_text.ordinal) AS timestamp,
			(SELECT name FROM sessions AS s
				WHERE s.id = session_search_text.session_id AND s.cwd = session_search_text.cwd) AS session_name,
				fts_score(text, ?) AS score, ${matchPosition} AS match_pos, length(text) AS text_length
				FROM session_search_text
				WHERE fts_match(text, ?)${cwdFilter}
				ORDER BY score DESC LIMIT ?
			) AS matches
			ORDER BY score DESC`;
		const parameters: unknown[] = [normalizedQuery, ...snippetTerms, normalizedQuery, ...cwdParameters, limit];
		const rows = this.db.prepare(querySql).all(...parameters) as SessionSearchRow[];
		return rows.flatMap((row) => {
			if (!row.entry_id || row.timestamp === null) {
				throw new Error(
					`Session search index row has no matching transcript entry: ${row.session_id}/${row.cwd}/${row.ordinal}`,
				);
			}
			if (!Number.isFinite(row.score)) throw new Error("Tantivy returned an invalid session search score");
			const excerptStart = row.match_pos > 0 ? Math.max(row.match_pos - 160, 1) : 1;
			const excerptEnd = excerptStart + row.excerpt.length - 1;
			const excerpt = `${excerptStart > 1 ? "…" : ""}${row.excerpt}${excerptEnd < row.text_length ? "…" : ""}`;
			return [
				{
					sessionId: row.session_id,
					cwd: row.cwd,
					entryId: row.entry_id,
					ordinal: row.ordinal,
					timestamp: row.timestamp,
					sessionName: row.session_name?.trim() || undefined,
					score: row.score,
					excerpt,
				},
			];
		});
	}

	writeSession(header: SessionHeader, entries: SessionEntry[], legacyPath?: string): void {
		const summary = buildSummary(header, entries, legacyPath);
		inTransaction(this.db, () => {
			upsertSummary(this.db, summary);
			this.db.prepare("DELETE FROM session_entries WHERE session_id = ? AND cwd = ?").run(summary.id, summary.cwd);
			this.db
				.prepare("DELETE FROM session_search_text WHERE session_id = ? AND cwd = ?")
				.run(summary.id, summary.cwd);
			insertEntries(this.db, summary.id, summary.cwd, entries);
		});
	}

	createSession(header: SessionHeader, entries: SessionEntry[]): void {
		const summary = buildSummary(header, entries);
		inTransaction(this.db, () => {
			if (this.hasSession(summary.id, summary.cwd) || this.hasDeletedSession(summary.id, summary.cwd)) {
				throw new Error(`Session id already exists: ${summary.id}`);
			}
			insertSummary(this.db, summary);
			insertEntries(this.db, summary.id, summary.cwd, entries);
		});
	}

	importSession(header: SessionHeader, entries: SessionEntry[], legacyPath?: string): SessionImportResult {
		const summary = buildSummary(header, entries, legacyPath);
		return inTransaction(this.db, () => {
			const disposition = this.getImportDisposition(summary, legacyPath);
			if (disposition) return disposition;
			insertSummary(this.db, summary);
			insertEntries(this.db, summary.id, summary.cwd, entries);
			return "imported";
		});
	}

	async importSessionAsync(
		header: SessionHeader,
		entries: AsyncIterable<SessionEntry>,
		totalEntries: number,
		legacyPath: string,
		signal?: AbortSignal,
		onProgress?: (loaded: number, total: number) => void,
	): Promise<SessionImportResult> {
		const summary = createSummary(header, legacyPath);
		this.db.exec(`
			DROP TABLE IF EXISTS temp.session_import_entries;
			DROP TABLE IF EXISTS temp.session_import_search_text;
			CREATE TEMP TABLE session_import_entries (
				ordinal INTEGER PRIMARY KEY,
				entry_id TEXT NOT NULL UNIQUE,
				parent_id TEXT,
				type TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				data TEXT NOT NULL
			);
			CREATE TEMP TABLE session_import_search_text (
				ordinal INTEGER PRIMARY KEY,
				text TEXT NOT NULL
			);
		`);
		const insertEntry = this.db.prepare(
			"INSERT INTO session_import_entries (ordinal, entry_id, parent_id, type, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertSearchText = this.db.prepare("INSERT INTO session_import_search_text (ordinal, text) VALUES (?, ?)");
		const batch: Array<{ ordinal: number; entry: SessionEntry; text: string | undefined }> = [];
		const writeBatch = () => {
			if (batch.length === 0) return;
			inTransaction(this.db, () => {
				for (const { ordinal, entry, text } of batch) {
					insertEntry.run(ordinal, entry.id, entry.parentId, entry.type, entry.timestamp, JSON.stringify(entry));
					if (text) insertSearchText.run(ordinal, text);
				}
			});
			batch.length = 0;
		};
		let processed = 0;
		for await (const entry of entries) {
			signal?.throwIfAborted();
			applyEntry(summary, entry);
			batch.push({ ordinal: processed, entry, text: messageText(entry)?.text });
			processed++;
			if (processed % SESSION_IMPORT_BATCH_SIZE === 0) {
				writeBatch();
				onProgress?.(processed, totalEntries);
				await new Promise<void>((resolve) => setImmediate(resolve));
				signal?.throwIfAborted();
			}
		}
		signal?.throwIfAborted();
		writeBatch();
		if (processed !== totalEntries) {
			throw new Error(
				`Legacy session entry count changed during import: expected ${totalEntries}, read ${processed}`,
			);
		}
		onProgress?.(processed, totalEntries);
		signal?.throwIfAborted();
		return inTransaction(this.db, () => {
			const disposition = this.getImportDisposition(summary, legacyPath);
			if (disposition) return disposition;
			insertSummary(this.db, summary);
			this.db
				.prepare(
					`INSERT INTO session_entries (session_id, cwd, ordinal, entry_id, parent_id, type, timestamp, data)
					 SELECT ?, ?, ordinal, entry_id, parent_id, type, timestamp, data
					 FROM session_import_entries ORDER BY ordinal`,
				)
				.run(summary.id, summary.cwd);
			this.db
				.prepare(
					`INSERT INTO session_search_text (session_id, cwd, ordinal, text)
					 SELECT ?, ?, ordinal, text FROM session_import_search_text ORDER BY ordinal`,
				)
				.run(summary.id, summary.cwd);
			return "imported";
		});
	}

	appendEntry(header: SessionHeader, entry: SessionEntry): void {
		inTransaction(this.db, () => {
			const cwd = normalizedCwd(header.cwd);
			const row = this.db
				.prepare(
					`SELECT id, header_json, cwd, created_at, modified_at, message_count, first_message, name, legacy_path
					 FROM sessions WHERE id = ? AND cwd = ?`,
				)
				.get(header.id, cwd) as SessionAppendRow | undefined;
			if (!row) throw new Error(`Session ${header.id} no longer exists in the database`);
			const summary: SessionSummary = {
				id: row.id,
				header: JSON.parse(row.header_json) as SessionHeader,
				cwd: row.cwd,
				createdAt: row.created_at,
				modifiedAt: row.modified_at,
				messageCount: row.message_count,
				firstMessage: row.first_message,
				allMessagesText: "",
				name: row.name ?? undefined,
				legacyPath: row.legacy_path ?? undefined,
			};
			applyEntry(summary, entry);
			const nextOrdinal = this.db
				.prepare(
					"SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal FROM session_entries WHERE session_id = ? AND cwd = ?",
				)
				.get(header.id, cwd) as { ordinal: number };
			entryInsert(this.db, header.id, cwd, nextOrdinal.ordinal, entry);
			insertSearchText(this.db, header.id, cwd, nextOrdinal.ordinal, entry);
			updateSummary(this.db, summary);
		});
	}

	deleteSession(id: string, cwd?: string): boolean {
		return inTransaction(this.db, () => {
			const resolvedCwd = this.resolveCwd(id, cwd);
			if (resolvedCwd === undefined) return false;
			const headerRow = this.db
				.prepare("SELECT header_json, legacy_path FROM sessions WHERE id = ? AND cwd = ?")
				.get(id, resolvedCwd) as { header_json: string; legacy_path: string | null } | undefined;
			if (!headerRow) return false;
			const entryRows = this.db
				.prepare("SELECT data FROM session_entries WHERE session_id = ? AND cwd = ? ORDER BY ordinal")
				.all(id, resolvedCwd) as EntryRow[];
			this.db
				.prepare(
					`INSERT INTO session_trash(id, cwd, header_json, entries_json, legacy_path, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id, cwd) DO UPDATE SET header_json = excluded.header_json,
					 entries_json = excluded.entries_json, legacy_path = excluded.legacy_path, deleted_at = excluded.deleted_at`,
				)
				.run(
					id,
					resolvedCwd,
					headerRow.header_json,
					JSON.stringify(entryRows.map((row) => JSON.parse(row.data))),
					headerRow.legacy_path,
					Date.now(),
				);
			this.db.prepare("DELETE FROM session_entries WHERE session_id = ? AND cwd = ?").run(id, resolvedCwd);
			this.db.prepare("DELETE FROM session_search_text WHERE session_id = ? AND cwd = ?").run(id, resolvedCwd);
			this.db.prepare("DELETE FROM sessions WHERE id = ? AND cwd = ?").run(id, resolvedCwd);
			return true;
		});
	}

	restoreSession(id: string, cwd?: string): boolean {
		return inTransaction(this.db, () => {
			const resolvedCwd = this.resolveTrashCwd(id, cwd);
			if (resolvedCwd === undefined) return false;
			const row = this.db
				.prepare("SELECT header_json, entries_json, legacy_path FROM session_trash WHERE id = ? AND cwd = ?")
				.get(id, resolvedCwd) as
				| { header_json: string; entries_json: string; legacy_path: string | null }
				| undefined;
			if (!row) return false;
			if (this.hasSession(id, resolvedCwd)) return false;
			const header = JSON.parse(row.header_json) as SessionHeader;
			const entries = JSON.parse(row.entries_json) as SessionEntry[];
			const summary = buildSummary(header, entries, row.legacy_path ?? undefined);
			upsertSummary(this.db, summary);
			this.db.prepare("DELETE FROM session_entries WHERE session_id = ? AND cwd = ?").run(id, resolvedCwd);
			this.db.prepare("DELETE FROM session_search_text WHERE session_id = ? AND cwd = ?").run(id, resolvedCwd);
			for (const [ordinal, entry] of entries.entries()) {
				entryInsert(this.db, id, resolvedCwd, ordinal, entry);
				insertSearchText(this.db, id, resolvedCwd, ordinal, entry);
			}
			this.db.prepare("DELETE FROM session_trash WHERE id = ? AND cwd = ?").run(id, resolvedCwd);
			return true;
		});
	}

	listSessions(cwd?: string, legacySessionDir?: string): SessionInfo[] {
		if ((cwd === undefined) !== (legacySessionDir === undefined)) {
			throw new Error("Project session listing requires both cwd and legacy session directory");
		}
		const projectFilter =
			cwd === undefined
				? ""
				: `WHERE s.cwd = ? OR (
						s.cwd = '' AND s.legacy_path IS NOT NULL AND
						substr(s.legacy_path, 1, length(?)) = ?
					)`;
		const rows = this.db
			.prepare(
				`SELECT s.id, s.header_json, s.cwd, s.created_at, s.modified_at, s.message_count, s.first_message,
					COALESCE((
						SELECT group_concat(ordered_search_text.text, ' ')
						FROM (
							SELECT text FROM session_search_text
							WHERE session_id = s.id AND cwd = s.cwd
							ORDER BY ordinal
						) AS ordered_search_text
					), s.all_messages_text) AS all_messages_text,
					s.name, s.legacy_path
					 FROM sessions AS s ${projectFilter} ORDER BY s.modified_at DESC, s.id DESC, s.cwd DESC`,
			)
			.all(
				...(cwd === undefined || legacySessionDir === undefined
					? []
					: [
							normalizedCwd(cwd),
							`${resolvePath(legacySessionDir)}${sep}`,
							`${resolvePath(legacySessionDir)}${sep}`,
						]),
			) as SessionRow[];
		return rows.map((row) => {
			const header = JSON.parse(row.header_json) as SessionHeader;
			return {
				path: "",
				id: row.id,
				cwd: row.cwd,
				name: row.name?.trim() || undefined,
				legacyPath: row.legacy_path ?? undefined,
				parentSessionPath: header.parentSession,
				created: new Date(row.created_at),
				modified: new Date(row.modified_at),
				messageCount: row.message_count,
				firstMessage: row.first_message || "(no messages)",
				allMessagesText: row.all_messages_text,
			};
		});
	}

	getMetadata(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM session_store_metadata WHERE key = ?").get(key) as
			| KeyValueRow
			| undefined;
		return row?.value;
	}

	setMetadata(key: string, value: string): void {
		this.db
			.prepare(
				"INSERT INTO session_store_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}
}

export function withSessionDatabase<T>(path: string, callback: (database: SessionDatabase) => T): T {
	const database = new SessionDatabase(path);
	try {
		return callback(database);
	} finally {
		database.close();
	}
}

export function withExistingSessionDatabase<T>(path: string, callback: (database: SessionDatabase) => T): T {
	const database = new SessionDatabase(path, { existing: true });
	try {
		return callback(database);
	} finally {
		database.close();
	}
}

export async function withSessionDatabaseAsync<T>(
	path: string,
	callback: (database: SessionDatabase) => Promise<T>,
): Promise<T> {
	const database = new SessionDatabase(path);
	try {
		return await callback(database);
	} finally {
		database.close();
	}
}
