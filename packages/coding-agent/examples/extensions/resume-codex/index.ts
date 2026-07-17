import {
	type ChildProcessWithoutNullStreams,
	type ExecSyncOptionsWithStringEncoding,
	execSync,
	spawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionFactory,
	keyHint,
	keyText,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, truncateToWidth } from "@earendil-works/pi-tui";

const CODEX_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const INITIALIZE_TIMEOUT_MS = 10_000;
const SESSION_LIST_TIMEOUT_MS = 30_000;
const THREAD_READ_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 1_000;
const STDERR_MAX_BYTES = 1024 * 1024;
const PROTOCOL_LINE_MAX_BYTES = 256 * 1024 * 1024;
const SESSION_PAGE_SIZE = 100;
const MAX_LISTED_SESSIONS = 1000;
const MAX_EXPORTED_TURNS = 10_000;
const MAX_EXPORTED_ITEMS = 100_000;

interface CodexAppServerOptions {
	cwd: string;
	signal?: AbortSignal;
}

type RunNpmPrefixCommand = (command: string, options: ExecSyncOptionsWithStringEncoding) => string;

export interface CodexScriptResolverOptions {
	platform?: NodeJS.Platform;
	appData?: string;
	runNpmPrefixCommand?: RunNpmPrefixCommand;
	pathExists?: (path: string) => boolean;
}

export interface CodexAppServerClient {
	request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
	close(): Promise<void>;
}

export type OpenCodexAppServer = (options: CodexAppServerOptions) => Promise<CodexAppServerClient>;

export interface ResumeCodexDependencies {
	openCodexAppServer: OpenCodexAppServer;
	now: () => number;
}

export interface CodexSessionSummary {
	id: string;
	title: string;
	directory: string;
	source: string;
	created: number;
	updated: number;
}

interface ImportedMessage {
	sourceMessageId: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	contentHash: string;
}

interface SourceItemRecord {
	id: string;
	type: string;
	projectedContentHash?: string;
}

interface SourceTurnRecord {
	id: string;
	status: string;
	items: SourceItemRecord[];
}

interface ParsedCodexThread {
	info: CodexSessionSummary & { version?: string };
	messages: ImportedMessage[];
	records: SourceTurnRecord[];
	omitted: Record<string, number>;
	sourceFingerprint: string;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength = 4096): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function readUnixMilliseconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000
		? Math.round(value * 1000)
		: undefined;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
	counts[key] = (counts[key] ?? 0) + amount;
}

function normalizeItemType(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	switch (value) {
		case "userMessage":
		case "hookPrompt":
		case "agentMessage":
		case "plan":
		case "reasoning":
		case "commandExecution":
		case "fileChange":
		case "mcpToolCall":
		case "dynamicToolCall":
		case "collabAgentToolCall":
		case "subAgentActivity":
		case "webSearch":
		case "imageView":
		case "sleep":
		case "imageGeneration":
		case "enteredReviewMode":
		case "exitedReviewMode":
		case "contextCompaction":
			return value;
		default:
			return "other";
	}
}

function normalizeInputType(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	switch (value) {
		case "text":
		case "image":
		case "localImage":
		case "skill":
		case "mention":
			return value;
		default:
			return "other";
	}
}

function normalizeTurnStatus(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	switch (value) {
		case "completed":
		case "interrupted":
		case "failed":
		case "inProgress":
			return value;
		default:
			return "other";
	}
}

function safeDisplayText(value: string, maxLength: number): string {
	const withoutControls = Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 32 || (code >= 127 && code <= 159) ? " " : character;
	}).join("");
	const normalized = withoutControls.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function protocolError(method: string, value: unknown): Error {
	if (!isRecord(value)) return new Error(`Codex ${method} failed`);
	const code = typeof value.code === "number" ? ` (${value.code})` : "";
	const message = readString(value.message, 2000);
	return new Error(`Codex ${method} failed${code}${message ? `: ${safeDisplayText(message, 2000)}` : ""}`);
}

class StdioCodexAppServer implements CodexAppServerClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly stderr: Buffer[] = [];
	private readonly exitPromise: Promise<void>;
	private readonly signal: AbortSignal | undefined;
	private readonly abortListener: () => void;
	private resolveExit: () => void = () => {};
	private nextRequestId = 1;
	private stdoutChunks: string[] = [];
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private terminalError: Error | undefined;
	private closed = false;
	private closing = false;

	constructor(child: ChildProcessWithoutNullStreams, signal?: AbortSignal) {
		this.child = child;
		this.signal = signal;
		this.abortListener = () => this.fail(new Error("Codex app-server cancelled"));
		this.exitPromise = new Promise((resolveExit) => {
			this.resolveExit = resolveExit;
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
		child.on("error", (error) => {
			const message =
				(error as NodeJS.ErrnoException).code === "ENOENT" ? "Codex CLI not found on PATH" : error.message;
			this.fail(new Error(message));
		});
		child.on("close", (code) => {
			this.closed = true;
			this.signal?.removeEventListener("abort", this.abortListener);
			if (!this.closing && !this.terminalError) {
				const detail = safeDisplayText(Buffer.concat(this.stderr).toString("utf8"), 2000);
				this.fail(new Error(`Codex app-server exited (code ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
			}
			this.resolveExit();
		});

		if (signal?.aborted) this.abortListener();
		else signal?.addEventListener("abort", this.abortListener, { once: true });
	}

	request(method: string, params: Record<string, unknown>, timeoutMs = THREAD_READ_TIMEOUT_MS): Promise<unknown> {
		if (this.terminalError) return Promise.reject(this.terminalError);
		if (this.closed || this.closing) return Promise.reject(new Error("Codex app-server is closed"));

		const id = this.nextRequestId++;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.fail(new Error(`Codex ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: resolveRequest,
				reject: rejectRequest,
				timer,
			});
			this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
				if (error) this.fail(error);
			});
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		if (this.terminalError || this.closed || this.closing) return;
		this.child.stdin.write(`${JSON.stringify({ method, params })}\n`, (error) => {
			if (error) this.fail(error);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		this.signal?.removeEventListener("abort", this.abortListener);
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Codex app-server closed before responding"));
		}
		this.pending.clear();
		this.child.stdin.end();
		const forceKillTimer = setTimeout(() => this.child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
		this.child.kill("SIGTERM");
		await this.exitPromise;
		clearTimeout(forceKillTimer);
	}

	private handleStdout(chunk: string): void {
		if (this.terminalError) return;
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline >= 0) {
			if (!this.appendStdoutSegment(chunk.slice(start, newline))) return;
			const line = this.stdoutChunks.join("").replace(/\r$/, "");
			this.stdoutChunks = [];
			this.stdoutBytes = 0;
			if (line.length > 0) this.handleLine(line);
			if (this.terminalError) return;
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		this.appendStdoutSegment(chunk.slice(start));
	}

	private appendStdoutSegment(segment: string): boolean {
		this.stdoutBytes += Buffer.byteLength(segment, "utf8");
		if (this.stdoutBytes > PROTOCOL_LINE_MAX_BYTES) {
			this.fail(new Error(`Codex app-server response exceeded ${PROTOCOL_LINE_MAX_BYTES} bytes`));
			return false;
		}
		if (segment.length > 0) this.stdoutChunks.push(segment);
		return true;
	}

	private handleStderr(chunk: Buffer): void {
		if (this.terminalError) return;
		this.stderrBytes += chunk.length;
		if (this.stderrBytes > STDERR_MAX_BYTES) {
			this.fail(new Error(`Codex app-server stderr exceeded ${STDERR_MAX_BYTES} bytes`));
			return;
		}
		this.stderr.push(chunk);
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.fail(new Error("Codex app-server returned invalid JSON"));
			return;
		}
		if (!isRecord(message)) {
			this.fail(new Error("Codex app-server returned an invalid protocol message"));
			return;
		}
		if (Object.hasOwn(message, "method")) {
			if (typeof message.method !== "string") {
				this.fail(new Error("Codex app-server returned an invalid protocol method"));
			} else if (Object.hasOwn(message, "id")) {
				this.fail(
					new Error(`Codex app-server requested unsupported method ${safeDisplayText(message.method, 200)}`),
				);
			}
			return;
		}
		if (typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 1) {
			this.fail(new Error("Codex app-server returned an invalid response ID"));
			return;
		}
		const id = message.id;
		const request = this.pending.get(id);
		if (!request) {
			this.fail(new Error(`Codex app-server returned unexpected response ID ${id}`));
			return;
		}
		this.pending.delete(id);
		clearTimeout(request.timer);
		if (Object.hasOwn(message, "error")) {
			request.reject(protocolError(request.method, message.error));
			return;
		}
		if (!Object.hasOwn(message, "result")) {
			request.reject(new Error(`Codex ${request.method} returned no result`));
			return;
		}
		request.resolve(message.result);
	}

	private fail(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		if (!this.closed) this.child.kill("SIGTERM");
	}
}

export function resolveCodexScript(options: CodexScriptResolverOptions = {}): string | undefined {
	const { platform = process.platform, appData = process.env.APPDATA, pathExists = existsSync } = options;
	const runNpmPrefixCommand: RunNpmPrefixCommand =
		options.runNpmPrefixCommand ?? ((command, commandOptions) => execSync(command, commandOptions));
	if (platform !== "win32") return undefined;

	const roots: string[] = [];
	if (appData) roots.push(join(appData, "npm"));
	try {
		const prefix = runNpmPrefixCommand("npm prefix -g", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (prefix) roots.push(prefix);
	} catch {
		// npm is optional when the standard root or PATH fallback is available.
	}
	for (const root of roots) {
		const candidate = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
		if (pathExists(candidate)) return candidate;
	}
	return undefined;
}

async function openCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServerClient> {
	const codexScript = resolveCodexScript();
	const child =
		codexScript !== undefined
			? spawn(process.execPath, [codexScript, "app-server"], {
					cwd: options.cwd,
					shell: false,
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				})
			: spawn("codex", ["app-server"], {
					cwd: options.cwd,
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
				});
	const client = new StdioCodexAppServer(child, options.signal);
	try {
		await client.request(
			"initialize",
			{
				clientInfo: {
					name: "pi_resume_codex",
					title: "Pi Resume Codex",
					version: "0.1.0",
				},
			},
			INITIALIZE_TIMEOUT_MS,
		);
		client.notify("initialized", {});
		return client;
	} catch (error) {
		await client.close();
		throw error;
	}
}

export function parseCodexThreadList(value: unknown): { sessions: CodexSessionSummary[]; nextCursor?: string } {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("Codex thread/list returned an invalid response");
	}
	const sessions: CodexSessionSummary[] = [];
	for (const [index, item] of value.data.entries()) {
		if (!isRecord(item)) throw new Error(`Codex thread/list returned an invalid thread at index ${index}`);
		const id = readString(item.id, 256);
		const directory = readString(item.cwd, 4096);
		const source = readString(item.source, 128);
		const created = readUnixMilliseconds(item.createdAt);
		const updatedAt = readUnixMilliseconds(item.updatedAt);
		const recencyAt = readUnixMilliseconds(item.recencyAt);
		if (
			!id ||
			!CODEX_THREAD_ID.test(id) ||
			!directory ||
			!source ||
			created === undefined ||
			updatedAt === undefined ||
			typeof item.preview !== "string" ||
			(item.name !== null && item.name !== undefined && typeof item.name !== "string") ||
			(item.recencyAt !== null && item.recencyAt !== undefined && recencyAt === undefined)
		) {
			throw new Error(`Codex thread/list returned an invalid thread at index ${index}`);
		}
		sessions.push({
			id,
			title: readString(item.name, 512) ?? readString(item.preview, 512) ?? id,
			directory,
			source,
			created,
			updated: recencyAt ?? updatedAt,
		});
	}
	if (value.nextCursor !== null && value.nextCursor !== undefined && !readString(value.nextCursor, 4096)) {
		throw new Error("Codex thread/list returned an invalid cursor");
	}
	return {
		sessions,
		nextCursor: readString(value.nextCursor, 4096),
	};
}

export function parseCodexThread(
	value: unknown,
	expectedThreadId: string,
	fallbackTimestamp: number,
): ParsedCodexThread {
	if (!isRecord(value) || !isRecord(value.thread)) {
		throw new Error("Codex thread/read returned an invalid response");
	}
	const thread = value.thread;
	const turns = thread.turns;
	if (!Array.isArray(turns)) {
		throw new Error("Codex thread/read returned an invalid response");
	}
	const threadId = readString(thread.id, 256);
	if (!threadId || threadId !== expectedThreadId) {
		throw new Error(`Codex thread/read returned unexpected thread ID ${threadId ?? "<missing>"}`);
	}
	const directory = readString(thread.cwd, 4096);
	if (!directory) throw new Error("Codex thread/read returned no working directory");
	const source = readString(thread.source, 128);
	const sourceVersion = readString(thread.cliVersion, 128);
	const created = readUnixMilliseconds(thread.createdAt);
	const updatedAt = readUnixMilliseconds(thread.updatedAt);
	const recencyAt = readUnixMilliseconds(thread.recencyAt);
	if (
		!source ||
		!sourceVersion ||
		created === undefined ||
		updatedAt === undefined ||
		typeof thread.preview !== "string" ||
		(thread.name !== null && thread.name !== undefined && typeof thread.name !== "string") ||
		(thread.recencyAt !== null && thread.recencyAt !== undefined && recencyAt === undefined)
	) {
		throw new Error("Codex thread/read returned invalid thread metadata");
	}
	if (turns.length > MAX_EXPORTED_TURNS) {
		throw new Error(`Codex thread contains more than ${MAX_EXPORTED_TURNS} turns`);
	}

	const omitted: Record<string, number> = {};
	const messages: ImportedMessage[] = [];
	const records: SourceTurnRecord[] = [];
	let itemCount = 0;

	for (const [turnIndex, turnValue] of turns.entries()) {
		if (!isRecord(turnValue) || !Array.isArray(turnValue.items)) {
			throw new Error(`Codex thread/read returned an invalid turn at index ${turnIndex}`);
		}
		itemCount += turnValue.items.length;
		if (itemCount > MAX_EXPORTED_ITEMS) {
			throw new Error(`Codex thread contains more than ${MAX_EXPORTED_ITEMS} items`);
		}
		const turnId = readString(turnValue.id, 256);
		const status = normalizeTurnStatus(turnValue.status);
		if (
			!turnId ||
			(status !== "completed" && status !== "interrupted" && status !== "failed" && status !== "inProgress")
		) {
			throw new Error(`Codex thread/read returned invalid turn metadata at index ${turnIndex}`);
		}
		if (turnValue.itemsView !== "full") {
			throw new Error(`Codex thread/read returned incomplete items for turn ${turnId}`);
		}
		const sourceStartedAt = readUnixMilliseconds(turnValue.startedAt);
		const sourceCompletedAt = readUnixMilliseconds(turnValue.completedAt);
		if (
			(turnValue.startedAt !== null && sourceStartedAt === undefined) ||
			(turnValue.completedAt !== null && sourceCompletedAt === undefined)
		) {
			throw new Error(`Codex thread/read returned invalid timestamps for turn ${turnId}`);
		}
		const startedAt = sourceStartedAt ?? fallbackTimestamp;
		const completedAt = sourceCompletedAt ?? fallbackTimestamp;
		const record: SourceTurnRecord = { id: turnId, status, items: [] };
		records.push(record);

		for (const [itemIndex, itemValue] of turnValue.items.entries()) {
			if (!isRecord(itemValue) || typeof itemValue.type !== "string") {
				throw new Error(`Codex thread/read returned an invalid item at turn ${turnId}, index ${itemIndex}`);
			}
			const itemType = normalizeItemType(itemValue.type);
			const itemId = readString(itemValue.id, 256);
			if ((itemType === "userMessage" || itemType === "agentMessage") && !itemId) {
				throw new Error(`Codex thread/read returned an invalid ${itemType} at turn ${turnId}, index ${itemIndex}`);
			}
			const sourceMessageId = itemId ?? `${turnId}-item-${itemIndex}`;
			const itemRecord: SourceItemRecord = { id: sourceMessageId, type: itemType };
			record.items.push(itemRecord);

			if (itemType === "userMessage") {
				if (!Array.isArray(itemValue.content)) {
					throw new Error(`Codex thread/read returned invalid content for user message ${sourceMessageId}`);
				}
				const textParts: string[] = [];
				for (const [inputIndex, input] of itemValue.content.entries()) {
					if (!isRecord(input) || typeof input.type !== "string") {
						throw new Error(
							`Codex thread/read returned an invalid user input for message ${sourceMessageId} at index ${inputIndex}`,
						);
					}
					const inputType = normalizeInputType(input.type);
					if (inputType !== "text") {
						increment(omitted, `input:${inputType}`);
						continue;
					}
					if (typeof input.text !== "string") {
						throw new Error(`Codex thread/read returned invalid text for user message ${sourceMessageId}`);
					}
					if (input.text.trim().length === 0) {
						increment(omitted, "empty-user-text");
						continue;
					}
					textParts.push(input.text);
				}
				if (textParts.length === 0) {
					increment(omitted, "user-message-without-importable-text");
					continue;
				}
				const text = textParts.join("\n\n");
				itemRecord.projectedContentHash = hashText(text);
				messages.push({
					sourceMessageId,
					role: "user",
					text,
					timestamp: startedAt,
					contentHash: itemRecord.projectedContentHash,
				});
				continue;
			}

			if (itemType === "agentMessage") {
				if (typeof itemValue.text !== "string") {
					throw new Error(`Codex thread/read returned invalid text for assistant message ${sourceMessageId}`);
				}
				if (status !== "completed") {
					increment(omitted, `assistant-${status}-item`);
					continue;
				}
				if (itemValue.text.trim().length === 0) {
					increment(omitted, "empty-assistant-text");
					continue;
				}
				itemRecord.projectedContentHash = hashText(itemValue.text);
				messages.push({
					sourceMessageId,
					role: "assistant",
					text: itemValue.text,
					timestamp: completedAt,
					contentHash: itemRecord.projectedContentHash,
				});
				continue;
			}

			increment(omitted, `item:${itemType}`);
		}
	}

	return {
		info: {
			id: threadId,
			title: readString(thread.name, 512) ?? readString(thread.preview, 512) ?? threadId,
			directory,
			source,
			created,
			updated: recencyAt ?? updatedAt,
			version: sourceVersion,
		},
		messages,
		records,
		omitted,
		sourceFingerprint: hashText(JSON.stringify(value)),
	};
}

function canonicalizeDirectory(directory: string): string {
	const resolved = resolve(directory);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function isCurrentDirectory(directory: string, cwd: string): boolean {
	return canonicalizeDirectory(directory) === canonicalizeDirectory(cwd);
}

function formatTimestamp(timestamp: number): string {
	return timestamp > 0 ? new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") : "unknown time";
}

function formatSessionChoice(session: CodexSessionSummary, cwd: string): string {
	const current = isCurrentDirectory(session.directory, cwd) ? "current · " : "";
	return `${current}${safeDisplayText(session.title, 80)} · ${formatTimestamp(session.updated)} · ${safeDisplayText(session.source, 30)} · ${safeDisplayText(session.directory, 80)} · ${session.id}`;
}

function sortCodexSessions(sessions: CodexSessionSummary[]): void {
	sessions.sort((left, right) => right.updated - left.updated);
}

async function selectCodexSession(
	ctx: ExtensionCommandContext,
	sessions: CodexSessionSummary[],
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const available = [...sessions].sort((left, right) => {
			const leftCurrent = isCurrentDirectory(left.directory, ctx.cwd);
			const rightCurrent = isCurrentDirectory(right.directory, ctx.cwd);
			if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
			return right.updated - left.updated;
		});
		const choices = available.map((session) => formatSessionChoice(session, ctx.cwd));
		const selected = await ctx.ui.select("Resume Codex session", choices);
		if (!selected) return undefined;
		const selectedIndex = choices.indexOf(selected);
		if (selectedIndex < 0) throw new Error("Codex picker returned an unknown session");
		return available[selectedIndex].id;
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const input = new Input();
		let scope: "current" | "all" = "current";
		let filtered: CodexSessionSummary[] = [];
		let selectedIndex = 0;
		const maxVisible = 6;

		const updateFilter = () => {
			const scopedSessions =
				scope === "current"
					? sessions.filter((session) => isCurrentDirectory(session.directory, ctx.cwd))
					: sessions;
			const terms = input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
			filtered =
				terms.length === 0
					? scopedSessions
					: scopedSessions.filter((session) => {
							const searchable =
								`${session.title}\n${session.directory}\n${session.source}\n${session.id}`.toLowerCase();
							return terms.every((term) => searchable.includes(term));
						});
			selectedIndex = 0;
		};
		updateFilter();

		const component: Component & Focusable = {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number) {
				const fit = (text: string) => truncateToWidth(text, Math.max(0, width), "");
				const border = theme.fg("border", "─".repeat(Math.max(0, width)));
				const currentTab =
					scope === "current"
						? theme.fg("accent", theme.bold("Current Directory"))
						: theme.fg("muted", "Current Directory");
				const allTab = scope === "all" ? theme.fg("accent", theme.bold("All")) : theme.fg("muted", "All");
				const lines = [
					border,
					fit(
						theme.fg(
							"accent",
							theme.bold(`Resume Codex Session (${scope === "current" ? "Current Directory" : "All"})`),
						),
					),
					fit(`${currentTab}${theme.fg("muted", "  |  ")}${allTab}`),
					fit(theme.fg("dim", "Search by title, directory, source, or thread ID")),
					...input.render(width),
					"",
				];

				if (filtered.length === 0) {
					const emptyMessage =
						scope === "current"
							? `  No sessions in current directory. Press ${keyText("tui.input.tab")} to view all.`
							: "  No matching sessions";
					lines.push(fit(theme.fg("warning", emptyMessage)));
				} else {
					const start = Math.max(
						0,
						Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, filtered.length - maxVisible)),
					);
					const end = Math.min(start + maxVisible, filtered.length);
					for (let index = start; index < end; index++) {
						const session = filtered[index];
						const selected = index === selectedIndex;
						const marker = selected ? theme.fg("accent", "›") : " ";
						const title = safeDisplayText(session.title, 200);
						const styledTitle = selected ? theme.fg("accent", theme.bold(title)) : theme.fg("text", title);
						lines.push(fit(`${marker} ${styledTitle}`));
						const details =
							scope === "all"
								? `${formatTimestamp(session.updated)} · ${safeDisplayText(session.source, 30)} · ${safeDisplayText(session.directory, 200)} · ${session.id}`
								: `${formatTimestamp(session.updated)} · ${safeDisplayText(session.source, 30)} · ${session.id}`;
						lines.push(fit(theme.fg("dim", `    ${details}`)));
					}
					if (filtered.length > maxVisible) {
						lines.push(fit(theme.fg("dim", `  ${selectedIndex + 1}/${filtered.length}`)));
					}
				}

				const separator = theme.fg("muted", " · ");
				const navigationKeys = `${keyText("tui.select.up")}/${keyText("tui.select.down")}`;
				lines.push(
					"",
					fit(
						[
							keyHint("tui.input.tab", "scope"),
							theme.fg("muted", "type to search"),
							rawKeyHint(navigationKeys, "navigate"),
							keyHint("tui.select.confirm", "import"),
							keyHint("tui.select.cancel", "cancel"),
						].join(separator),
					),
					border,
				);
				return lines;
			},
			invalidate() {
				input.invalidate();
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				if (keybindings.matches(data, "tui.input.tab")) {
					scope = scope === "current" ? "all" : "current";
					updateFilter();
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) {
					if (filtered.length > 0) selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
				} else if (keybindings.matches(data, "tui.select.down")) {
					if (filtered.length > 0) selectedIndex = (selectedIndex + 1) % filtered.length;
				} else if (keybindings.matches(data, "tui.select.confirm")) {
					done(filtered[selectedIndex]?.id ?? null);
					return;
				} else {
					const previous = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previous) updateFilter();
				}
				tui.requestRender();
			},
		};
		return component;
	});
	return result ?? undefined;
}

type LoaderResult<T> =
	| { status: "completed"; value: T }
	| { status: "cancelled" }
	| { status: "error"; error: unknown };

async function runWithLoader<T>(
	ctx: ExtensionCommandContext,
	message: string,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ cancelled: false; value: T } | { cancelled: true }> {
	if (ctx.mode !== "tui") {
		return { cancelled: false, value: await operation(new AbortController().signal) };
	}

	const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message);
		let finished = false;
		const finish = (value: LoaderResult<T>) => {
			if (finished) return;
			finished = true;
			done(value);
		};
		loader.onAbort = () => finish({ status: "cancelled" });
		operation(loader.signal)
			.then((value) => finish({ status: "completed", value }))
			.catch((error: unknown) => finish({ status: "error", error }));
		return loader;
	});
	if (result.status === "cancelled") return { cancelled: true };
	if (result.status === "error") {
		throw result.error instanceof Error ? result.error : new Error(String(result.error));
	}
	return { cancelled: false, value: result.value };
}

async function withCodexAppServer<T>(
	openServer: OpenCodexAppServer,
	cwd: string,
	signal: AbortSignal,
	operation: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
	const client = await openServer({ cwd, signal });
	try {
		return await operation(client);
	} finally {
		await client.close();
	}
}

async function listCodexSessions(client: CodexAppServerClient): Promise<CodexSessionSummary[]> {
	const sessions = new Map<string, CodexSessionSummary>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	do {
		let response: unknown;
		let lastError: unknown;
		for (const sortKey of ["recency_at", "updated_at"] as const) {
			try {
				response = await client.request(
					"thread/list",
					{
						cursor: cursor ?? null,
						limit: SESSION_PAGE_SIZE,
						sortKey,
						sortDirection: "desc",
						sourceKinds: ["cli", "vscode"],
						archived: false,
					},
					SESSION_LIST_TIMEOUT_MS,
				);
				break;
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				// codex <0.144.5 rejects recency_at; fall back to updated_at
				if (sortKey === "recency_at" && /unknown variant .recency_at./.test(message)) continue;
				throw error;
			}
		}
		if (!response) throw lastError instanceof Error ? lastError : new Error(String(lastError));
		const page = parseCodexThreadList(response);
		for (const session of page.sessions) {
			if (sessions.size >= MAX_LISTED_SESSIONS && !sessions.has(session.id)) break;
			sessions.set(session.id, session);
		}
		cursor = page.nextCursor;
		if (!cursor || sessions.size >= MAX_LISTED_SESSIONS) break;
		if (seenCursors.has(cursor)) throw new Error("Codex thread/list returned a repeated cursor");
		seenCursors.add(cursor);
	} while (cursor);

	return [...sessions.values()];
}

async function readCodexThread(client: CodexAppServerClient, threadId: string): Promise<unknown> {
	return await client.request(
		"thread/read",
		{
			threadId,
			includeTurns: true,
		},
		THREAD_READ_TIMEOUT_MS,
	);
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createResumeCodexExtension(overrides: Partial<ResumeCodexDependencies> = {}): ExtensionFactory {
	const dependencies: ResumeCodexDependencies = {
		openCodexAppServer: overrides.openCodexAppServer ?? openCodexAppServer,
		now: overrides.now ?? Date.now,
	};

	return (pi: ExtensionAPI) => {
		pi.registerCommand("resume-codex", {
			description: "Import a Codex session in Pi",
			handler: async (args, ctx) => {
				try {
					await ctx.waitForIdle();
					if (!ctx.model) throw new Error("No model selected");

					const requestedId = args.trim();
					if (requestedId && !CODEX_THREAD_ID.test(requestedId)) {
						throw new Error("Usage: /resume-codex [thread-id]");
					}
					if (!requestedId && !ctx.hasUI) {
						throw new Error("Usage: /resume-codex <thread-id> (a picker requires interactive or RPC mode)");
					}

					let threadId = requestedId;
					if (!threadId) {
						const discovery = await runWithLoader(ctx, "Discovering Codex sessions...", async (signal) => {
							return await withCodexAppServer(
								dependencies.openCodexAppServer,
								ctx.cwd,
								signal,
								listCodexSessions,
							);
						});
						if (discovery.cancelled) {
							ctx.ui.notify("Codex discovery cancelled", "info");
							return;
						}
						const sessions = discovery.value;
						if (sessions.length === 0) {
							ctx.ui.notify("No Codex sessions found", "info");
							return;
						}
						sortCodexSessions(sessions);
						threadId = (await selectCodexSession(ctx, sessions)) ?? "";
						if (!threadId) return;
					}

					const readResult = await runWithLoader(ctx, `Reading ${threadId}...`, async (signal) => {
						return await withCodexAppServer(dependencies.openCodexAppServer, ctx.cwd, signal, async (client) => {
							return await readCodexThread(client, threadId);
						});
					});
					if (readResult.cancelled) {
						ctx.ui.notify("Codex import cancelled", "info");
						return;
					}

					const importedAtTimestamp = dependencies.now();
					const parsed = parseCodexThread(readResult.value, threadId, importedAtTimestamp);
					if (!isCurrentDirectory(parsed.info.directory, ctx.cwd)) {
						if (!ctx.hasUI) {
							throw new Error(
								`Codex session directory ${safeDisplayText(parsed.info.directory, 1000)} differs from ${safeDisplayText(ctx.cwd, 1000)}`,
							);
						}
						const confirmed = await ctx.ui.confirm(
							"Different working directory",
							`This session was created in ${safeDisplayText(parsed.info.directory, 1000)}. Import its history into ${safeDisplayText(ctx.cwd, 1000)}?`,
						);
						if (!confirmed) {
							ctx.ui.notify("Codex import cancelled", "info");
							return;
						}
					}

					if (parsed.messages.length === 0 || !parsed.messages.some((message) => message.role === "user")) {
						throw new Error("Codex session has no importable user text");
					}

					const model = { api: ctx.model.api, provider: ctx.model.provider, id: ctx.model.id };
					const importedAt = new Date(importedAtTimestamp).toISOString();
					const notification = `Imported ${parsed.messages.length} Codex messages from ${threadId}`;
					const result = await ctx.newSession({
						setup: async (sessionManager) => {
							const importedEntries: Array<{
								sourceMessageId: string;
								sourceTimestamp: number;
								piEntryId: string;
								contentHash: string;
							}> = [];
							for (const message of parsed.messages) {
								const piEntryId =
									message.role === "user"
										? sessionManager.appendMessage({
												role: "user",
												content: [{ type: "text", text: message.text }],
												timestamp: importedAtTimestamp,
											})
										: sessionManager.appendMessage({
												role: "assistant",
												content: [{ type: "text", text: message.text }],
												api: model.api,
												provider: model.provider,
												model: model.id,
												usage: emptyUsage(),
												stopReason: "stop",
												timestamp: importedAtTimestamp,
											});
								importedEntries.push({
									sourceMessageId: message.sourceMessageId,
									sourceTimestamp: message.timestamp,
									piEntryId,
									contentHash: message.contentHash,
								});
							}
							sessionManager.appendModelChange(model.provider, model.id);
							sessionManager.appendCustomEntry("resume-codex", {
								version: 1,
								source: "codex",
								nativeThreadId: parsed.info.id,
								sourceVersion: parsed.info.version,
								sourceKind: parsed.info.source,
								title: parsed.info.title,
								directory: parsed.info.directory,
								created: parsed.info.created,
								updated: parsed.info.updated,
								importedAt,
								sourceFingerprint: parsed.sourceFingerprint,
								omitted: parsed.omitted,
								records: parsed.records,
								importedEntries,
							});
						},
						withSession: async (replacementCtx) => {
							replacementCtx.ui.notify(notification, "info");
						},
					});
					if (result.cancelled) ctx.ui.notify("Codex import cancelled", "info");
				} catch (error) {
					if (!ctx.hasUI) throw error instanceof Error ? error : new Error(String(error));
					ctx.ui.notify(`resume-codex: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	};
}

const resumeCodexExtension = createResumeCodexExtension();

export default resumeCodexExtension;
