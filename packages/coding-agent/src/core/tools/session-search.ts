import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { resolvePath } from "../../utils/paths.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { withExistingSessionDatabase } from "../session-database.ts";
import { getSessionDatabasePathFromLocator } from "../session-locator.ts";
import type { SessionEntry } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const execFileAsync = promisify(execFile);
const MAX_SEARCH_RESULTS = 10;
const MAX_CONTEXT_ENTRIES = 8;
const MAX_CONTEXT_ENTRY_CHARS = 1200;

const searchSessionsSchema = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 256, description: "Tantivy full-text query" }),
	scope: Type.Optional(Type.Union([Type.Literal("repository"), Type.Literal("all")])),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Maximum results (default: 5)" }),
	),
});

const readSessionContextSchema = Type.Object({
	session_id: Type.String({ minLength: 1, description: "Session ID from a search result" }),
	cwd: Type.String({ description: "Session working directory from a search result" }),
	entry_id: Type.String({ minLength: 1, description: "Entry ID from a search result" }),
	before: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: MAX_CONTEXT_ENTRIES,
			description: "Earlier entries to include (default: 4)",
		}),
	),
	after: Type.Optional(
		Type.Integer({ minimum: 0, maximum: MAX_CONTEXT_ENTRIES, description: "Later entries to include (default: 4)" }),
	),
});

export type SearchSessionsInput = Static<typeof searchSessionsSchema>;
export type ReadSessionContextInput = Static<typeof readSessionContextSchema>;

interface RepositoryScope {
	roots: string[];
	description: string;
}

async function getRepositoryScope(cwd: string): Promise<RepositoryScope> {
	const root = resolvePath(cwd);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === 128) {
			return { roots: [root], description: `directory tree ${root} (not a Git repository)` };
		}
		throw error;
	}

	const roots = [
		...new Set(
			stdout
				.split("\0")
				.filter((record) => record.startsWith("worktree "))
				.map((record) => resolvePath(record.slice("worktree ".length))),
		),
	];
	if (roots.length === 0) throw new Error(`Git returned no worktrees for ${cwd}`);
	return {
		roots,
		description: `current Git repository across ${roots.length} registered worktree${roots.length === 1 ? "" : "s"}`,
	};
}

function boundedCount(value: number | undefined, defaultValue: number): number {
	return Math.max(0, Math.min(MAX_CONTEXT_ENTRIES, Math.floor(value ?? defaultValue)));
}

function contentText(content: string | Array<{ type: string; text?: string }> | null | undefined): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join(" ");
}

function entryText(entry: SessionEntry): { role: string; text: string } | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (!("role" in message) || !("content" in message)) return undefined;
		const role = message.role === "toolResult" ? "tool" : message.role;
		const text = contentText(message.content);
		return text ? { role, text } : undefined;
	}
	if (entry.type === "custom_message") {
		const text = contentText(entry.content);
		return text ? { role: "custom", text } : undefined;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { role: entry.type === "compaction" ? "compaction" : "branch summary", text: entry.summary };
	}
	return undefined;
}

function resultText(content: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text: content }], details: undefined };
}

export function createSearchSessionsToolDefinition(cwd: string): ToolDefinition<typeof searchSessionsSchema> {
	return {
		name: "search_sessions",
		label: "search sessions",
		description:
			"Search prior Pi transcripts with Tantivy. By default searches the current Git repository across its registered worktrees and all transcript branches. Use scope='all' to search every session in the current session database. Returns bounded excerpts and stable entry references.",
		promptSnippet: "Search prior Pi session transcripts, then retrieve context around a result",
		promptGuidelines: [
			"Use search_sessions for prior-session recall. Call read_session_context with a result's session_id, cwd, and entry_id to inspect nearby transcript entries.",
		],
		parameters: searchSessionsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const databasePath = sessionFile ? getSessionDatabasePathFromLocator(sessionFile) : undefined;
			if (!databasePath) {
				return resultText("Session search is unavailable because this session is not using persistent storage.");
			}

			await ctx.sessionManager.ensureSessionDatabaseInitialized((loaded, total, _partialSessions, stage) => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Preparing the local session index (${stage ?? "import"}): ${loaded}/${total}`,
						},
					],
					details: undefined,
				});
			}, signal);
			signal?.throwIfAborted();
			const scope = params.scope ?? "repository";
			const repositoryScope = scope === "repository" ? await getRepositoryScope(ctx.cwd || cwd) : undefined;
			signal?.throwIfAborted();
			const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, params.limit ?? 5));
			const hits = withExistingSessionDatabase(databasePath, (database) =>
				database.searchSessionText(params.query, {
					cwdPrefixes: repositoryScope?.roots,
					limit,
				}),
			);
			const scopeDescription = repositoryScope?.description ?? "all sessions in the current session database";
			if (hits.length === 0) {
				return resultText(`No matching session entries. Scope: ${scopeDescription}.`);
			}

			const lines = [
				`Found ${hits.length} matching session entr${hits.length === 1 ? "y" : "ies"}. Scope: ${scopeDescription}.`,
			];
			for (const [index, hit] of hits.entries()) {
				const date = new Date(hit.timestamp);
				const timestamp = Number.isNaN(date.getTime()) ? hit.timestamp : date.toISOString();
				lines.push(
					`${index + 1}. ${hit.sessionName || "Unnamed session"} (${timestamp})`,
					`   cwd: ${hit.cwd}`,
					`   reference: session_id=${hit.sessionId}; cwd=${hit.cwd}; entry_id=${hit.entryId}`,
					`   excerpt: ${hit.excerpt.replace(/\s+/gu, " ").trim()}`,
				);
			}
			return resultText(lines.join("\n"));
		},
	};
}

export function createReadSessionContextToolDefinition(_cwd: string): ToolDefinition<typeof readSessionContextSchema> {
	return {
		name: "read_session_context",
		label: "read session context",
		description:
			"Read a bounded window around a search_sessions result. Supply its session_id, cwd, and entry_id. At each branch, later context follows the most recently appended direct child.",
		promptSnippet: "Read bounded context around a prior-session search result",
		parameters: readSessionContextSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			signal?.throwIfAborted();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const databasePath = sessionFile ? getSessionDatabasePathFromLocator(sessionFile) : undefined;
			if (!databasePath) {
				return resultText("Session context is unavailable because this session is not using persistent storage.");
			}
			await ctx.sessionManager.ensureSessionDatabaseInitialized(undefined, signal);
			signal?.throwIfAborted();

			const beforeCount = boundedCount(params.before, 4);
			const afterCount = boundedCount(params.after, 4);
			const window = withExistingSessionDatabase(databasePath, (database) =>
				database.readSessionContext(params.session_id, params.cwd, params.entry_id, beforeCount, afterCount),
			);
			if (!window) return resultText("Session or entry not found in the current session database.");
			const context = [
				...window.before.map((entry) => ({ entry, isAnchor: false })),
				{ entry: window.anchor, isAnchor: true },
				...window.after.map((entry) => ({ entry, isAnchor: false })),
			];
			const lines = [`Session ${params.session_id}; anchor ${params.entry_id}:`];
			for (const { entry, isAnchor } of context) {
				const text = entryText(entry);
				if (!text) continue;
				const date = new Date(entry.timestamp);
				const timestamp = Number.isNaN(date.getTime()) ? entry.timestamp : date.toISOString();
				const excerpt =
					text.text.length > MAX_CONTEXT_ENTRY_CHARS
						? `${text.text.slice(0, MAX_CONTEXT_ENTRY_CHARS)}…`
						: text.text;
				lines.push(`${isAnchor ? ">" : " "} ${timestamp} [${text.role}] ${excerpt}`);
			}
			if (lines.length === 1) return resultText("The referenced entry has no readable text context.");
			return resultText(lines.join("\n"));
		},
	};
}

export function createSearchSessionsTool(cwd: string) {
	return wrapToolDefinition(createSearchSessionsToolDefinition(cwd));
}

export function createReadSessionContextTool(cwd: string) {
	return wrapToolDefinition(createReadSessionContextToolDefinition(cwd));
}
