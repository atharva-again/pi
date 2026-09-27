import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@tursodatabase/database/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDatabase } from "../src/core/session-database.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";

interface SearchRow {
	session_id: string;
	ordinal: number;
	score: number;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session Tantivy FTS index", () => {
	it("searches persisted session text and removes deleted text from the index", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-fts-"));
		tempDirs.push(directory);
		const databasePath = join(directory, "sessions.db");
		const cwd = join(directory, "project");
		const otherCwd = join(directory, "unrelated-project");
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "tantivy-session",
			timestamp: new Date().toISOString(),
			cwd,
		};
		const entry: SessionEntry = {
			type: "message",
			id: "tantivy-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: `${"prefix ".repeat(200)}Tantivy session search phrase ${"tail ".repeat(200)}`,
				timestamp: Date.now(),
			},
		};
		const unrelatedHeader = { ...header, id: "unrelated-session", cwd: otherCwd };
		const unrelatedEntry = {
			...entry,
			id: "unrelated-entry",
			message: {
				role: "user" as const,
				content: "Tantivy session search in another project",
				timestamp: Date.now(),
			},
		};
		const query = "Tantivy";
		const search = (database: Database) =>
			database
				.prepare(
					`SELECT session_id, ordinal, fts_score(text, ?) AS score
					 FROM session_search_text
					 WHERE fts_match(text, ?)
					 ORDER BY score DESC`,
				)
				.all(query, query) as SearchRow[];

		const sessionDatabase = new SessionDatabase(databasePath);
		try {
			sessionDatabase.createSession(header, [entry]);
			sessionDatabase.createSession(unrelatedHeader, [unrelatedEntry]);
			const results = sessionDatabase.searchSessionText(query, { cwdPrefixes: [cwd], limit: 5 });
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ sessionId: header.id, cwd, entryId: entry.id });
			expect(results[0]?.excerpt).toContain("Tantivy");
			expect(results[0]?.excerpt.length).toBeLessThanOrEqual(422);
			const compoundQuery = sessionDatabase.searchSessionText("Tantivy AND phrase", { cwdPrefixes: [cwd] });
			expect(compoundQuery[0]?.excerpt).toContain("Tantivy");
			expect(sessionDatabase.searchSessionText(query, { cwdPrefixes: [otherCwd] })).toMatchObject([
				{ sessionId: unrelatedHeader.id, cwd: otherCwd },
			]);
		} finally {
			sessionDatabase.close();
		}

		const searchDatabase = new Database(databasePath, { experimental: ["index_method"] });
		try {
			const results = search(searchDatabase);
			expect(results).toHaveLength(2);
			const target = results.find((result) => result.session_id === header.id);
			expect(target).toMatchObject({ session_id: header.id, ordinal: 0 });
			expect(typeof target?.score).toBe("number");
		} finally {
			searchDatabase.close();
		}

		const reopenedSessionDatabase = new SessionDatabase(databasePath, { existing: true });
		try {
			expect(reopenedSessionDatabase.deleteSession(header.id, cwd)).toBe(true);
		} finally {
			reopenedSessionDatabase.close();
		}

		const reopenedSearchDatabase = new Database(databasePath, { experimental: ["index_method"] });
		try {
			expect(search(reopenedSearchDatabase)).toHaveLength(1);
		} finally {
			reopenedSearchDatabase.close();
		}
	});

	it("rebuilds unanchored aggregate search rows from session entries", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-fts-rebuild-"));
		tempDirs.push(directory);
		const databasePath = join(directory, "sessions.db");
		const cwd = join(directory, "project");
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "legacy-search-session",
			timestamp: new Date().toISOString(),
			cwd,
		};
		const entry: SessionEntry = {
			type: "message",
			id: "legacy-search-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "legacy aggregate searchable text", timestamp: Date.now() },
		};
		const database = new SessionDatabase(databasePath);
		try {
			database.createSession(header, [entry]);
		} finally {
			database.close();
		}

		const legacyDatabase = new Database(databasePath, { experimental: ["index_method"] });
		try {
			legacyDatabase.exec("DELETE FROM session_search_text WHERE session_id = 'legacy-search-session'");
			legacyDatabase
				.prepare("INSERT INTO session_search_text (session_id, cwd, ordinal, text) VALUES (?, ?, -1, ?)")
				.run(header.id, cwd, "legacy aggregate searchable text");
		} finally {
			legacyDatabase.close();
		}

		const reopenedDatabase = new SessionDatabase(databasePath, { existing: true });
		try {
			const results = reopenedDatabase.searchSessionText("aggregate", { cwdPrefixes: [cwd] });
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ sessionId: header.id, entryId: entry.id, ordinal: 0 });
		} finally {
			reopenedDatabase.close();
		}
	});
});
