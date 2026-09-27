import { constants as bufferConstants } from "buffer";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionHeader(file: string, cwd: string, id: string, prefix = ""): void {
		writeFileSync(
			file,
			`${prefix}${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd,
			})}\n`,
		);
	}

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("fails on malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow(SyntaxError);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("fails rather than dropping malformed lines", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(() => loadEntriesFromFile(file)).toThrow(SyntaxError);
	});

	it("adds a newline after an unterminated valid record", () => {
		const file = join(tempDir, "unterminated.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(readFileSync(file, "utf8")).toBe(`${content}\n`);
	});

	it("does not repair an unterminated malformed final fragment", () => {
		const file = join(tempDir, "malformed-tail.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' + '{"type":"message"';
		writeFileSync(file, content);

		expect(() => loadEntriesFromFile(file)).toThrow(SyntaxError);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("does not modify an unterminated non-session file", () => {
		const file = join(tempDir, "invalid.jsonl");
		const content = '{"type":"message","id":"1"}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it.each([
		["leading blank lines", "\n  \n", "leading-blank"],
		["a multi-buffer header", "", "a".repeat(8192)],
	])("reads cwd from a session with %s", (_description, prefix, sessionId) => {
		const file = join(tempDir, "header.jsonl");
		const storedCwd = join(tempDir, "stored-project");
		writeSessionHeader(file, storedCwd, sessionId, prefix);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe(sessionId);
		expect(sessionManager.getCwd()).toBe(storedCwd);
	});

	it("fails on malformed JSON before the session header", () => {
		const file = join(tempDir, "malformed-prefix.jsonl");
		writeSessionHeader(file, join(tempDir, "stored-project"), "malformed-prefix", "not json\n");

		expect(() => SessionManager.open(file, tempDir)).toThrow(SyntaxError);
	});

	it("rejects malformed session locators instead of treating them as file paths", () => {
		expect(() => SessionManager.open("pi-session://not-a-valid-locator")).toThrow("Invalid session locator");
	});

	it("opens compatible sessions beyond the discovery scan limit", () => {
		const storedCwd = join(tempDir, "stored-project");
		const overrideCwd = join(tempDir, "override-project");
		const cases = [
			{ name: "large-header", id: "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1), prefix: "" },
			{
				name: "large-blank-prefix",
				id: "large-prefix",
				prefix: "\n".repeat(HEADER_SCAN_LIMIT_BYTES + 1),
			},
		];

		for (const { name, id, prefix } of cases) {
			const file = join(tempDir, `${name}.jsonl`);
			writeSessionHeader(file, storedCwd, id, prefix);
			for (const cwdOverride of [undefined, overrideCwd]) {
				const sessionManager = SessionManager.open(file, tempDir, cwdOverride);
				expect(sessionManager.getSessionId()).toBe(id);
				expect(sessionManager.getCwd()).toBe(cwdOverride ?? storedCwd);
			}
		}
	});

	it("rejects malformed sparse data after a valid session header", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		expect(() => SessionManager.open(file, tempDir)).toThrow(SyntaxError);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
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
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = await SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});

	it("rejects a cancelled session listing", async () => {
		createPersistedSession(projectA, "from A");
		createPersistedSession(projectB, "from B");
		const controller = new AbortController();
		const listing = SessionManager.listAll(
			tempDir,
			(_loaded, _total, partialSessions) => {
				if (partialSessions) controller.abort();
			},
			controller.signal,
		);

		await expect(listing).rejects.toMatchObject({ name: "AbortError" });
		await expect(SessionManager.listAll(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects a pre-aborted project listing even when there are no sessions", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(SessionManager.list(projectA, tempDir, undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects an explicitly opened empty JSONL file", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		expect(() => SessionManager.open(emptyFile, tempDir)).toThrow(`Session file is empty: ${emptyFile}`);
		expect(readFileSync(emptyFile, "utf-8")).toBe("");
	});

	it("rejects an explicitly opened missing JSONL file", () => {
		const missingFile = join(tempDir, "missing.jsonl");

		expect(() => SessionManager.open(missingFile, tempDir)).toThrow(`Session file not found: ${missingFile}`);
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionManager.open(nonSessionFile, tempDir)).toThrow(
			`Session file is not a valid pi session: ${nonSessionFile}`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("reopens the persisted session by its database locator", () => {
		const sm1 = SessionManager.create(tempDir, tempDir);
		sm1.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sm1.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response" }],
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
			timestamp: 2,
		});
		const sessionId = sm1.getSessionId();

		const sm2 = SessionManager.open(sm1.getSessionFile()!, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
