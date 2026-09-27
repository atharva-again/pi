import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "@tursodatabase/database/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function makeLocator(databasePath: string): string {
	const encodedDatabasePath = Buffer.from(databasePath).toString("base64url");
	const encodedCwd = Buffer.from(process.cwd()).toString("base64url");
	const encodedSessionId = Buffer.from("locator-security-test").toString("base64url");
	return `pi-session://${encodedDatabasePath}/${encodedCwd}/${encodedSessionId}`;
}

describe("session database validation", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not create a missing database or its parent directory", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-locator-security-"));
		const missingDirectory = join(tempDir, "missing");
		const databasePath = join(missingDirectory, "sessions.db");

		expect(() => SessionManager.open(makeLocator(databasePath))).toThrow();
		expect(existsSync(missingDirectory)).toBe(false);
	});

	it("rejects unrelated SQLite databases before schema migration on both open paths", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-locator-security-"));
		const databasePath = join(tempDir, "sessions.db");
		const unrelated = new DatabaseSync(databasePath);
		try {
			unrelated.exec(`
				CREATE TABLE sessions (id TEXT PRIMARY KEY);
				CREATE TABLE session_entries (session_id TEXT, ordinal INTEGER);
			`);
		} finally {
			unrelated.close();
		}
		const readSchema = (): unknown[] => {
			const database = new DatabaseSync(databasePath, { readOnly: true });
			try {
				return database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
			} finally {
				database.close();
			}
		};
		const schemaBefore = readSchema();

		expect(() => SessionManager.open(makeLocator(databasePath))).toThrow("Refusing to open session database");
		expect(() => SessionManager.create(process.cwd(), tempDir, { id: "unrelated-db-test" })).toThrow(
			"Refusing to open session database",
		);
		expect(readSchema()).toEqual(schemaBefore);
	});

	it("migrates a recognized pre-project-scoping database when opened by locator", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-locator-security-"));
		const databasePath = join(tempDir, "sessions.db");
		const timestamp = new Date().toISOString();
		const header = {
			type: "session",
			version: 3,
			id: "locator-security-test",
			timestamp,
			cwd: process.cwd(),
		};
		const entry = {
			type: "message",
			id: "legacy-entry",
			parentId: null,
			timestamp,
			message: { role: "user", content: "legacy transcript", timestamp: Date.now() },
		};
		const legacy = new DatabaseSync(databasePath);
		try {
			legacy.exec(`
				CREATE TABLE sessions (
					id TEXT PRIMARY KEY, header_json TEXT NOT NULL, cwd TEXT NOT NULL, created_at REAL NOT NULL,
					modified_at REAL NOT NULL, message_count INTEGER NOT NULL, first_message TEXT NOT NULL,
					all_messages_text TEXT NOT NULL, name TEXT
				);
				CREATE TABLE session_entries (
					session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT,
					type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL,
					PRIMARY KEY (session_id, ordinal), UNIQUE (session_id, entry_id)
				);
				CREATE TABLE session_store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			`);
			legacy
				.prepare(
					`INSERT INTO sessions
					 (id, header_json, cwd, created_at, modified_at, message_count, first_message, all_messages_text, name)
					VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
				)
				.run(
					header.id,
					JSON.stringify(header),
					header.cwd,
					Date.now(),
					Date.now(),
					"legacy transcript",
					"legacy transcript",
				);
			legacy
				.prepare("INSERT INTO session_entries VALUES (?, 0, ?, NULL, 'message', ?, ?)")
				.run(header.id, entry.id, timestamp, JSON.stringify(entry));
		} finally {
			legacy.close();
		}

		const opened = SessionManager.open(makeLocator(databasePath));
		expect(opened.getSessionId()).toBe(header.id);
		expect(opened.getEntries()[0]?.id).toBe(entry.id);
		const migrated = new Database(databasePath, { readonly: true, experimental: ["index_method"] });
		try {
			const columns = migrated.prepare("PRAGMA table_info(sessions)").all() as Array<{ pk: number; name: string }>;
			const sessionPrimaryKey = columns
				.filter((column) => column.pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map((column) => column.name);
			expect(sessionPrimaryKey).toEqual(["id", "cwd"]);
		} finally {
			migrated.close();
		}
	});

	it("rejects locator paths that do not use the session database filename", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-locator-security-"));
		const databasePath = join(tempDir, "unrelated.sqlite");

		expect(() => SessionManager.open(makeLocator(databasePath))).toThrow("Invalid session locator database path");
		expect(existsSync(databasePath)).toBe(false);
	});
});
