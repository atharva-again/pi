import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { withSessionDatabase } from "../src/core/session-database.ts";
import { createSessionLocator } from "../src/core/session-locator.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";
import {
	createReadSessionContextToolDefinition,
	createSearchSessionsToolDefinition,
} from "../src/core/tools/session-search.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session search tools", () => {
	it("falls back to directory scope when Git worktree environment variables are set alone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-search-git-env-"));
		tempDirs.push(directory);
		const project = join(directory, "project");
		mkdirSync(project);
		const databasePath = join(directory, "sessions.db");
		const context = {
			cwd: project,
			sessionManager: {
				getSessionFile: () => createSessionLocator(databasePath, "active-session", project),
				ensureSessionDatabaseInitialized: async () => {},
			},
		} as unknown as ExtensionContext;
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "git-env-fallback",
			timestamp: new Date().toISOString(),
			cwd: project,
		};
		withSessionDatabase(databasePath, (database) => database.createSession(header, []));
		vi.stubEnv("GIT_DIR", "");
		vi.stubEnv("GIT_WORK_TREE", "");
		vi.stubEnv("GIT_COMMON_DIR", "");
		vi.stubEnv("GIT_CEILING_DIRECTORIES", "");
		vi.stubEnv("GIT_DISCOVERY_ACROSS_FILESYSTEM", "");
		const search = createSearchSessionsToolDefinition(project);

		for (const variable of ["GIT_WORK_TREE", "GIT_COMMON_DIR"] as const) {
			vi.stubEnv("GIT_WORK_TREE", "");
			vi.stubEnv("GIT_COMMON_DIR", "");
			vi.stubEnv(variable, project);
			const result = await search.execute(`${variable}-scope`, { query: "absent" }, undefined, undefined, context);
			expect(JSON.stringify(result.content)).toContain(`directory tree ${project} (not a Git repository)`);
		}
	});

	it("returns bounded excerpts and reads context on the anchored transcript path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-search-tools-"));
		tempDirs.push(directory);
		const project = join(directory, "project");
		mkdirSync(project);
		const databasePath = join(directory, "sessions.db");
		const locator = createSessionLocator(databasePath, "active-session", project);
		const context = {
			cwd: project,
			sessionManager: { getSessionFile: () => locator, ensureSessionDatabaseInitialized: async () => {} },
		} as unknown as ExtensionContext;
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "prior-session",
			timestamp: new Date().toISOString(),
			cwd: project,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "prior-user",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "How did we index old Pi conversations?", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "prior-match",
				parentId: "prior-user",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: "The Tantivy index searches all transcript branches.",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "prior-followup",
				parentId: "prior-match",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Can I retrieve the surrounding messages?", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "prior-latest-branch",
				parentId: "prior-match",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "This is a later alternate path.", timestamp: Date.now() },
			},
		];
		withSessionDatabase(databasePath, (database) => database.createSession(header, entries));
		const outsideHeader: SessionHeader = {
			...header,
			id: "outside-session",
			cwd: join(directory, "outside-project"),
		};
		withSessionDatabase(databasePath, (database) =>
			database.createSession(outsideHeader, [
				{
					type: "message",
					id: "outside-entry",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "user",
						content: "Tantivy also appears outside this repository.",
						timestamp: Date.now(),
					},
				},
			]),
		);
		const search = createSearchSessionsToolDefinition(project);
		const searchResult = await search.execute("search", { query: "Tantivy" }, undefined, undefined, context);
		const searchText = JSON.stringify(searchResult.content);
		expect(searchText).toContain(`directory tree ${project} (not a Git repository)`);
		expect(searchText).toContain("entry_id=prior-match");
		expect(searchText).toContain("Tantivy index searches all transcript branches.");
		expect(searchText).not.toContain("outside-session");
		const allSessionsResult = await search.execute(
			"all-sessions-search",
			{ query: "Tantivy", scope: "all" },
			undefined,
			undefined,
			context,
		);
		expect(JSON.stringify(allSessionsResult.content)).toContain("session_id=outside-session");
		const alternateBranchResult = await search.execute(
			"alternate-search",
			{ query: "retrieve surrounding" },
			undefined,
			undefined,
			context,
		);
		expect(JSON.stringify(alternateBranchResult.content)).toContain("entry_id=prior-followup");

		const read = createReadSessionContextToolDefinition(project);
		const readResult = await read.execute(
			"read",
			{ session_id: header.id, cwd: project, entry_id: "prior-match", before: 1, after: 1 },
			undefined,
			undefined,
			context,
		);
		const readText = JSON.stringify(readResult.content);
		expect(readText).toContain("How did we index old Pi conversations?");
		expect(readText).toContain("> ");
		expect(readText).toContain("This is a later alternate path.");
		expect(readText).not.toContain("Can I retrieve the surrounding messages?");
	});

	it("searches across the current Git repository's registered worktrees", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-worktree-search-"));
		tempDirs.push(directory);
		const primary = join(directory, "primary");
		const linked = join(directory, "linked");
		mkdirSync(primary);
		execFileSync("git", ["init", "-q", primary]);
		execFileSync("git", ["-C", primary, "config", "user.email", "test@example.com"]);
		execFileSync("git", ["-C", primary, "config", "user.name", "Session Search Test"]);
		execFileSync("git", ["-C", primary, "commit", "--allow-empty", "-m", "initial"]);
		execFileSync("git", ["-C", primary, "worktree", "add", "-q", "-b", "search-linked", linked]);

		const databasePath = join(directory, "sessions.db");
		const context = {
			cwd: primary,
			sessionManager: {
				getSessionFile: () => createSessionLocator(databasePath, "active-session", primary),
				ensureSessionDatabaseInitialized: async () => {},
			},
		} as unknown as ExtensionContext;
		for (const [id, cwd] of [
			["primary-session", primary],
			["linked-session", linked],
		] as const) {
			const header: SessionHeader = {
				type: "session",
				version: 3,
				id,
				timestamp: new Date().toISOString(),
				cwd,
			};
			const entry: SessionEntry = {
				type: "message",
				id: `${id}-entry`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Shared repository worktree memory phrase", timestamp: Date.now() },
			};
			withSessionDatabase(databasePath, (database) => database.createSession(header, [entry]));
		}

		const search = createSearchSessionsToolDefinition(primary);
		const result = await search.execute(
			"worktree-search",
			{ query: "worktree memory" },
			undefined,
			undefined,
			context,
		);
		const output = JSON.stringify(result.content);
		expect(output).toContain("session_id=primary-session");
		expect(output).toContain("session_id=linked-session");
	});

	it("respects Git discovery ceilings when determining repository scope", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-search-ceiling-"));
		tempDirs.push(directory);
		const repository = join(directory, "repository");
		const nested = join(repository, "nested");
		mkdirSync(nested, { recursive: true });
		execFileSync("git", ["init", "-q", repository]);
		vi.stubEnv("GIT_CEILING_DIRECTORIES", repository);

		const databasePath = join(directory, "sessions.db");
		const context = {
			cwd: nested,
			sessionManager: {
				getSessionFile: () => createSessionLocator(databasePath, "active-session", nested),
				ensureSessionDatabaseInitialized: async () => {},
			},
		} as unknown as ExtensionContext;
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "above-ceiling",
			timestamp: new Date().toISOString(),
			cwd: repository,
		};
		const entry: SessionEntry = {
			type: "message",
			id: "above-ceiling-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "ceiling-scoped repository memory", timestamp: Date.now() },
		};
		withSessionDatabase(databasePath, (database) => database.createSession(header, [entry]));

		const search = createSearchSessionsToolDefinition(nested);
		const result = await search.execute("ceiling-search", { query: "ceiling-scoped" }, undefined, undefined, context);
		const output = JSON.stringify(result.content);
		expect(output).toContain(`directory tree ${nested} (not a Git repository)`);
		expect(output).toContain("No matching session entries");
	});
});
