import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const SESSION_QUERY =
	"SELECT id, title, directory, time_created AS created, time_updated AS updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1000";
const DATABASE_PATH_TIMEOUT_MS = 10_000;
const SESSION_LIST_TIMEOUT_MS = 15_000;
const DATABASE_PATH_MAX_BYTES = 16 * 1024;
const SESSION_LIST_MAX_BYTES = 2 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const MAX_EXPORTED_MESSAGES = 10_000;
const MAX_EXPORTED_PARTS = 100_000;
const MAX_IMPORT_TOKENS = 100_000;

interface OpenCodeCommandOptions {
	cwd: string;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
	captureStdoutToFile?: boolean;
	signal?: AbortSignal;
}

interface OpenCodeCommandResult {
	stdout: string;
	stderr: string;
}

type RunOpenCode = (args: string[], options: OpenCodeCommandOptions) => Promise<OpenCodeCommandResult>;

export interface ResumeOpenCodeDependencies {
	runOpenCode: RunOpenCode;
	pathExists: (path: string) => boolean;
	now: () => number;
}

export interface OpenCodeSessionSummary {
	id: string;
	title: string;
	directory: string;
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

interface SourceRecord {
	id: string;
	role: "user" | "assistant" | "unknown";
	partIds: string[];
	partTypes: string[];
	projectedContentHash?: string;
}

interface ParsedOpenCodeExport {
	info: OpenCodeSessionSummary & { version?: string };
	messages: ImportedMessage[];
	records: SourceRecord[];
	omitted: Record<string, number>;
}

interface BoundedImport {
	messages: ImportedMessage[];
	contextLimitOmitted: number;
	truncatedCharacters: number;
	truncatedMessages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength = 4096): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function readTimestamp(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
		? value
		: fallback;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
	counts[key] = (counts[key] ?? 0) + amount;
}

function normalizePartType(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	switch (value) {
		case "text":
		case "reasoning":
		case "tool":
		case "file":
		case "step-start":
		case "step-finish":
		case "patch":
		case "snapshot":
		case "retry":
		case "agent":
		case "subtask":
		case "compaction":
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

function commandFailure(args: string[], code: number | null, stderr: string): Error {
	const detail = safeDisplayText(stderr, 2000);
	const suffix = detail ? `: ${detail}` : "";
	return new Error(`OpenCode ${args[0] ?? "command"} failed (exit ${code ?? "unknown"})${suffix}`);
}

async function runOpenCodeCommand(args: string[], options: OpenCodeCommandOptions): Promise<OpenCodeCommandResult> {
	let outputDirectory: string | undefined;
	let outputPath: string | undefined;
	let outputFd: number | undefined;
	if (options.captureStdoutToFile) {
		outputDirectory = mkdtempSync(join(tmpdir(), "pi-resume-opencode-"));
		outputPath = join(outputDirectory, "stdout");
		outputFd = openSync(outputPath, "wx", 0o600);
	}

	try {
		return await new Promise((resolveResult, reject) => {
			const child = spawn("opencode", args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", outputFd ?? "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let failure: Error | undefined;
			let settled = false;
			let forceKillTimer: NodeJS.Timeout | undefined;

			const terminate = () => {
				child.kill("SIGTERM");
				forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
			};
			const timer =
				options.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							failure = new Error(`OpenCode ${args[0] ?? "command"} timed out after ${options.timeoutMs}ms`);
							terminate();
						}, options.timeoutMs);
			const maxStdoutBytes = options.maxStdoutBytes;
			const outputSizeTimer =
				outputFd === undefined || maxStdoutBytes === undefined
					? undefined
					: setInterval(() => {
							if (failure || fstatSync(outputFd).size <= maxStdoutBytes) return;
							failure = new Error(`OpenCode ${args[0] ?? "command"} output exceeded ${maxStdoutBytes} bytes`);
							terminate();
						}, 10);
			const handleAbort = () => {
				if (failure) return;
				failure = new Error(`OpenCode ${args[0] ?? "command"} cancelled`);
				terminate();
			};
			if (options.signal?.aborted) handleAbort();
			else options.signal?.addEventListener("abort", handleAbort, { once: true });

			const settle = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (outputSizeTimer) clearInterval(outputSizeTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				options.signal?.removeEventListener("abort", handleAbort);
				callback();
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				if (failure) return;
				stdoutBytes += chunk.length;
				if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
					failure = new Error(`OpenCode ${args[0] ?? "command"} output exceeded ${options.maxStdoutBytes} bytes`);
					terminate();
					return;
				}
				stdout.push(chunk);
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				if (failure) return;
				stderrBytes += chunk.length;
				if (options.maxStderrBytes !== undefined && stderrBytes > options.maxStderrBytes) {
					failure = new Error(`OpenCode ${args[0] ?? "command"} stderr exceeded ${options.maxStderrBytes} bytes`);
					terminate();
					return;
				}
				stderr.push(chunk);
			});

			child.on("error", (error) => {
				settle(() => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(new Error("OpenCode CLI not found on PATH"));
						return;
					}
					reject(error);
				});
			});

			child.on("close", (code) => {
				settle(() => {
					try {
						if (failure) {
							reject(failure);
							return;
						}
						if (
							outputFd !== undefined &&
							options.maxStdoutBytes !== undefined &&
							fstatSync(outputFd).size > options.maxStdoutBytes
						) {
							reject(
								new Error(`OpenCode ${args[0] ?? "command"} output exceeded ${options.maxStdoutBytes} bytes`),
							);
							return;
						}
						const stdoutText = outputPath
							? readFileSync(outputPath, "utf8")
							: Buffer.concat(stdout).toString("utf8");
						const stderrText = Buffer.concat(stderr).toString("utf8");
						if (code !== 0) {
							reject(commandFailure(args, code, stderrText));
							return;
						}
						resolveResult({ stdout: stdoutText, stderr: stderrText });
					} catch (error) {
						reject(error);
					}
				});
			});
		});
	} finally {
		if (outputFd !== undefined) closeSync(outputFd);
		if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true });
	}
}

function findJsonValueEnd(value: string, start: number): number | undefined {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") {
			stack.push(character);
			continue;
		}
		if (character !== "}" && character !== "]") continue;
		const expected = character === "}" ? "{" : "[";
		if (stack.pop() !== expected) return undefined;
		if (stack.length === 0) return index + 1;
	}
	return undefined;
}

function parseJson(
	value: string,
	description: string,
	expectedStart: "{" | "[",
	accept: (parsed: unknown) => boolean,
	prefer: (parsed: unknown) => boolean = accept,
): unknown {
	const normalized = value.replace(/^\uFEFF/, "").trim();
	try {
		const parsed: unknown = JSON.parse(normalized);
		if (accept(parsed)) return parsed;
	} catch {
		// Try extracting the expected JSON value from surrounding CLI status text.
	}

	let fallback: unknown;
	let hasFallback = false;
	let searchStart = 0;
	while (searchStart < normalized.length) {
		const objectStart = normalized.indexOf("{", searchStart);
		const arrayStart = normalized.indexOf("[", searchStart);
		const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
		if (start < 0) break;

		const end = findJsonValueEnd(normalized, start);
		if (end === undefined) {
			searchStart = start + 1;
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(normalized.slice(start, end));
			searchStart = end;
			if (normalized[start] !== expectedStart || !accept(parsed)) continue;
			if (prefer(parsed)) return parsed;
			fallback = parsed;
			hasFallback = true;
		} catch {
			// Continue past non-JSON status text such as "[info]" or "{update}".
			searchStart = start + 1;
		}
	}
	if (hasFallback) return fallback;
	throw new Error(
		`${description} did not contain valid JSON (${Buffer.byteLength(value, "utf8")} bytes, sha256 ${hashText(value).slice(0, 12)})`,
	);
}

export function parseOpenCodeSessionList(raw: string): OpenCodeSessionSummary[] {
	const value = parseJson(
		raw,
		"OpenCode session list",
		"[",
		(parsed) =>
			Array.isArray(parsed) &&
			(parsed.length === 0 ||
				parsed.some(
					(item) =>
						isRecord(item) &&
						typeof item.id === "string" &&
						OPENCODE_SESSION_ID.test(item.id) &&
						typeof item.directory === "string" &&
						item.directory.length > 0,
				)),
		(parsed) => Array.isArray(parsed) && parsed.length > 0,
	);
	if (!Array.isArray(value)) {
		throw new Error("OpenCode session list is not an array");
	}

	const sessions: OpenCodeSessionSummary[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const id = readString(item.id, 128);
		const directory = readString(item.directory, 4096);
		if (!id || !OPENCODE_SESSION_ID.test(id) || !directory) continue;
		sessions.push({
			id,
			title: readString(item.title, 512) ?? id,
			directory,
			created: readTimestamp(item.created, 0),
			updated: readTimestamp(item.updated, 0),
		});
	}
	return sessions;
}

function getMessageTimestamp(info: Record<string, unknown>, fallback: number): number {
	const time = isRecord(info.time) ? info.time : undefined;
	return readTimestamp(time?.completed, readTimestamp(time?.created, fallback));
}

function getSessionTime(info: Record<string, unknown>, key: "created" | "updated", fallback: number): number {
	const time = isRecord(info.time) ? info.time : undefined;
	return readTimestamp(time?.[key], fallback);
}

export function parseOpenCodeExport(
	raw: string,
	expectedSessionId: string,
	fallbackTimestamp: number,
): ParsedOpenCodeExport {
	const value = parseJson(
		raw,
		"OpenCode export",
		"{",
		(parsed) => isRecord(parsed) && isRecord(parsed.info) && Array.isArray(parsed.messages),
	);
	if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.messages)) {
		throw new Error("OpenCode export has no valid info/messages payload");
	}
	if (value.messages.length > MAX_EXPORTED_MESSAGES) {
		throw new Error(`OpenCode export contains more than ${MAX_EXPORTED_MESSAGES} messages`);
	}

	const sessionId = readString(value.info.id, 128);
	if (!sessionId || sessionId !== expectedSessionId) {
		throw new Error(`OpenCode export returned unexpected session ID ${sessionId ?? "<missing>"}`);
	}
	const directory = readString(value.info.directory, 4096);
	if (!directory) {
		throw new Error("OpenCode export has no session directory");
	}

	const omitted: Record<string, number> = {};
	const messages: ImportedMessage[] = [];
	const records: SourceRecord[] = [];
	let partCount = 0;

	for (const [messageIndex, item] of value.messages.entries()) {
		if (!isRecord(item) || !isRecord(item.info) || !Array.isArray(item.parts)) {
			increment(omitted, "invalid-message");
			continue;
		}
		partCount += item.parts.length;
		if (partCount > MAX_EXPORTED_PARTS) {
			throw new Error(`OpenCode export contains more than ${MAX_EXPORTED_PARTS} message parts`);
		}

		const role = item.info.role === "user" || item.info.role === "assistant" ? item.info.role : "unknown";
		const sourceMessageId = readString(item.info.id, 128) ?? `message-${messageIndex}`;
		const partIds: string[] = [];
		const partTypes: string[] = [];
		for (const part of item.parts) {
			if (!isRecord(part)) continue;
			partTypes.push(normalizePartType(part.type));
			const partId = readString(part.id, 128);
			if (partId) partIds.push(partId);
		}
		const record: SourceRecord = { id: sourceMessageId, role, partIds, partTypes };
		records.push(record);

		if (role === "unknown") {
			increment(omitted, "unknown-role-message");
			continue;
		}
		if (role === "assistant" && item.info.summary === true) {
			increment(omitted, "assistant-summary-message");
			continue;
		}
		if (role === "assistant" && item.info.error !== undefined && item.info.error !== null) {
			increment(omitted, "assistant-error-message");
			continue;
		}
		const completionTime = isRecord(item.info.time) ? item.info.time.completed : undefined;
		if (role === "assistant" && item.info.finish === undefined && completionTime === undefined) {
			increment(omitted, "assistant-incomplete-message");
			continue;
		}
		if (role === "user" && typeof item.info.system === "string" && item.info.system.length > 0) {
			increment(omitted, "system-prompt");
		}

		const textParts: string[] = [];
		for (const part of item.parts) {
			if (!isRecord(part)) {
				increment(omitted, "invalid-part");
				continue;
			}
			const partType = normalizePartType(part.type);
			if (partType !== "text") {
				increment(omitted, `part:${partType}`);
				continue;
			}
			if (typeof part.text !== "string") {
				increment(omitted, "invalid-text-part");
				continue;
			}
			if (part.synthetic === true) {
				increment(omitted, "synthetic-text-part");
				continue;
			}
			if (part.ignored === true) {
				increment(omitted, "ignored-text-part");
				continue;
			}
			if (part.text.trim().length === 0) {
				increment(omitted, "empty-text-part");
				continue;
			}
			textParts.push(part.text);
		}

		if (textParts.length === 0) {
			increment(omitted, "message-without-importable-text");
			continue;
		}

		const text = textParts.join("\n\n");
		record.projectedContentHash = hashText(text);
		messages.push({
			sourceMessageId,
			role,
			text,
			timestamp: getMessageTimestamp(item.info, fallbackTimestamp),
			contentHash: record.projectedContentHash,
		});
	}

	return {
		info: {
			id: sessionId,
			title: readString(value.info.title, 512) ?? sessionId,
			directory,
			created: getSessionTime(value.info, "created", fallbackTimestamp),
			updated: getSessionTime(value.info, "updated", fallbackTimestamp),
			version: readString(value.info.version, 128),
		},
		messages,
		records,
		omitted,
	};
}

function messageTokens(message: ImportedMessage): number {
	return Math.max(1, Math.ceil(message.text.length / 4));
}

function truncateMessage(message: ImportedMessage, maxTokens: number): { message: ImportedMessage; omitted: number } {
	const maxCharacters = Math.max(1, maxTokens * 4);
	if (message.text.length <= maxCharacters) return { message, omitted: 0 };
	const marker = "\n\n[OpenCode message truncated during import]\n\n";
	if (maxCharacters <= marker.length + 2) {
		const text = message.text.slice(0, maxCharacters);
		return {
			message: { ...message, text, contentHash: hashText(text) },
			omitted: message.text.length - text.length,
		};
	}
	const available = maxCharacters - marker.length;
	const headLength = Math.ceil(available / 2);
	const tailLength = Math.floor(available / 2);
	const text = `${message.text.slice(0, headLength)}${marker}${message.text.slice(-tailLength)}`;
	return {
		message: { ...message, text, contentHash: hashText(text) },
		omitted: message.text.length - headLength - tailLength,
	};
}

export function boundImportedMessages(messages: ImportedMessage[], tokenBudget: number): BoundedImport {
	if (messages.length === 0) {
		return { messages: [], contextLimitOmitted: 0, truncatedCharacters: 0, truncatedMessages: 0 };
	}

	const perMessageBudget = Math.max(256, Math.floor(tokenBudget / 2));
	let truncatedCharacters = 0;
	let truncatedMessages = 0;
	const bounded = messages.map((message) => {
		const result = truncateMessage(message, perMessageBudget);
		if (result.omitted > 0) {
			truncatedCharacters += result.omitted;
			truncatedMessages++;
		}
		return result.message;
	});

	let totalTokens = bounded.reduce((total, message) => total + messageTokens(message), 0);
	let start = 0;
	while (start < bounded.length && totalTokens > tokenBudget) {
		totalTokens -= messageTokens(bounded[start]);
		start++;
	}
	while (start < bounded.length && bounded[start].role !== "user") {
		start++;
	}

	let selected = bounded.slice(start);
	if (selected.length === 0) {
		let latestUserIndex = -1;
		for (let index = bounded.length - 1; index >= 0; index--) {
			if (bounded[index].role === "user") {
				latestUserIndex = index;
				break;
			}
		}
		if (latestUserIndex < 0) {
			return {
				messages: [],
				contextLimitOmitted: bounded.length,
				truncatedCharacters,
				truncatedMessages,
			};
		}
		selected = [];
		let remaining = tokenBudget;
		for (let index = latestUserIndex; index < bounded.length; index++) {
			const message = bounded[index];
			const tokens = messageTokens(message);
			if (tokens > remaining) break;
			selected.push(message);
			remaining -= tokens;
		}
	}

	return {
		messages: selected,
		contextLimitOmitted: messages.length - selected.length,
		truncatedCharacters,
		truncatedMessages,
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

function formatSessionChoice(session: OpenCodeSessionSummary, cwd: string): string {
	const current = isCurrentDirectory(session.directory, cwd) ? "current · " : "";
	return `${current}${safeDisplayText(session.title, 80)} · ${formatTimestamp(session.updated)} · ${safeDisplayText(session.directory, 80)} · ${session.id}`;
}

function sortOpenCodeSessions(sessions: OpenCodeSessionSummary[]): void {
	sessions.sort((left, right) => right.updated - left.updated);
}

async function selectOpenCodeSession(
	ctx: ExtensionCommandContext,
	sessions: OpenCodeSessionSummary[],
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const available = [...sessions].sort((left, right) => {
			const leftCurrent = isCurrentDirectory(left.directory, ctx.cwd);
			const rightCurrent = isCurrentDirectory(right.directory, ctx.cwd);
			if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
			return right.updated - left.updated;
		});
		const choices = available.map((session) => formatSessionChoice(session, ctx.cwd));
		const selected = await ctx.ui.select("Resume OpenCode session", choices);
		if (!selected) return undefined;
		const selectedIndex = choices.indexOf(selected);
		if (selectedIndex < 0) throw new Error("OpenCode picker returned an unknown session");
		return available[selectedIndex].id;
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const input = new Input();
		let scope: "current" | "all" = "current";
		let filtered: OpenCodeSessionSummary[] = [];
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
							const searchable = `${session.title}\n${session.directory}\n${session.id}`.toLowerCase();
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
							theme.bold(`Resume OpenCode Session (${scope === "current" ? "Current Directory" : "All"})`),
						),
					),
					fit(`${currentTab}${theme.fg("muted", "  |  ")}${allTab}`),
					fit(theme.fg("dim", "Search by title, directory, or session ID")),
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
								? `${formatTimestamp(session.updated)} · ${safeDisplayText(session.directory, 200)} · ${session.id}`
								: `${formatTimestamp(session.updated)} · ${session.id}`;
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

async function ensureOpenCodeDatabase(
	runOpenCode: RunOpenCode,
	pathExists: (path: string) => boolean,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	const result = await runOpenCode(["db", "path"], {
		cwd,
		timeoutMs: DATABASE_PATH_TIMEOUT_MS,
		maxStdoutBytes: DATABASE_PATH_MAX_BYTES,
		maxStderrBytes: STDERR_MAX_BYTES,
		signal,
	});
	const outputLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	let databasePath: string | undefined;
	for (let index = outputLines.length - 1; index >= 0; index--) {
		if (isAbsolute(outputLines[index])) {
			databasePath = outputLines[index];
			break;
		}
	}
	if (!databasePath) {
		throw new Error("OpenCode returned an invalid database path");
	}
	if (!pathExists(databasePath)) {
		throw new Error(`OpenCode database not found at ${safeDisplayText(databasePath, 1000)}`);
	}
}

async function listOpenCodeSessions(
	runOpenCode: RunOpenCode,
	cwd: string,
	signal?: AbortSignal,
): Promise<OpenCodeSessionSummary[]> {
	const result = await runOpenCode(["db", "--format", "json", SESSION_QUERY], {
		cwd,
		timeoutMs: SESSION_LIST_TIMEOUT_MS,
		maxStdoutBytes: SESSION_LIST_MAX_BYTES,
		maxStderrBytes: STDERR_MAX_BYTES,
		signal,
	});
	return parseOpenCodeSessionList(result.stdout);
}

async function exportOpenCodeSession(
	runOpenCode: RunOpenCode,
	cwd: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runOpenCode(["export", sessionId], {
		cwd,
		captureStdoutToFile: true,
		signal,
	});
	return result.stdout;
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

export function createResumeOpenCodeExtension(overrides: Partial<ResumeOpenCodeDependencies> = {}): ExtensionFactory {
	const dependencies: ResumeOpenCodeDependencies = {
		runOpenCode: overrides.runOpenCode ?? runOpenCodeCommand,
		pathExists: overrides.pathExists ?? existsSync,
		now: overrides.now ?? Date.now,
	};

	return (pi: ExtensionAPI) => {
		pi.registerCommand("resume-opencode", {
			description: "Import an OpenCode session in Pi",
			handler: async (args, ctx) => {
				try {
					await ctx.waitForIdle();
					if (!ctx.model) {
						throw new Error("No model selected");
					}

					const requestedId = args.trim();
					if (requestedId && !OPENCODE_SESSION_ID.test(requestedId)) {
						throw new Error("Usage: /resume-opencode [ses_...]");
					}
					if (!requestedId && !ctx.hasUI) {
						throw new Error("Usage: /resume-opencode <ses_...> (a picker requires interactive or RPC mode)");
					}

					let sessionId = requestedId;
					let databaseChecked = false;
					if (!sessionId) {
						const discovery = await runWithLoader(ctx, "Discovering OpenCode sessions...", async (signal) => {
							await ensureOpenCodeDatabase(dependencies.runOpenCode, dependencies.pathExists, ctx.cwd, signal);
							return await listOpenCodeSessions(dependencies.runOpenCode, ctx.cwd, signal);
						});
						if (discovery.cancelled) {
							ctx.ui.notify("OpenCode discovery cancelled", "info");
							return;
						}
						databaseChecked = true;
						const sessions = discovery.value;
						if (sessions.length === 0) {
							ctx.ui.notify("No OpenCode sessions found", "info");
							return;
						}
						sortOpenCodeSessions(sessions);
						sessionId = (await selectOpenCodeSession(ctx, sessions)) ?? "";
						if (!sessionId) return;
					}

					const exportedResult = await runWithLoader(ctx, `Exporting ${sessionId}...`, async (signal) => {
						if (!databaseChecked) {
							await ensureOpenCodeDatabase(dependencies.runOpenCode, dependencies.pathExists, ctx.cwd, signal);
						}
						return await exportOpenCodeSession(dependencies.runOpenCode, ctx.cwd, sessionId, signal);
					});
					if (exportedResult.cancelled) {
						ctx.ui.notify("OpenCode export cancelled", "info");
						return;
					}
					const exported = exportedResult.value;
					const parsed = parseOpenCodeExport(exported, sessionId, dependencies.now());
					if (!isCurrentDirectory(parsed.info.directory, ctx.cwd)) {
						if (!ctx.hasUI) {
							throw new Error(
								`OpenCode session directory ${safeDisplayText(parsed.info.directory, 1000)} differs from ${safeDisplayText(ctx.cwd, 1000)}`,
							);
						}
						const confirmed = await ctx.ui.confirm(
							"Different working directory",
							`This session was created in ${safeDisplayText(parsed.info.directory, 1000)}. Import its history into ${safeDisplayText(ctx.cwd, 1000)}?`,
						);
						if (!confirmed) {
							ctx.ui.notify("OpenCode import cancelled", "info");
							return;
						}
					}

					const tokenBudget = Math.min(
						MAX_IMPORT_TOKENS,
						Math.max(512, Math.floor(ctx.model.contextWindow * 0.5)),
					);
					const bounded = boundImportedMessages(parsed.messages, tokenBudget);
					if (bounded.messages.length === 0 || !bounded.messages.some((message) => message.role === "user")) {
						throw new Error("OpenCode session has no importable user text");
					}

					const model = { api: ctx.model.api, provider: ctx.model.provider, id: ctx.model.id };
					const parentSession = ctx.sessionManager.getSessionFile();
					const importedAt = new Date(dependencies.now()).toISOString();
					const sourceFingerprint = hashText(exported);
					const sessionName = safeDisplayText(`OpenCode: ${parsed.info.title}`, 120);
					const omissionCounts = { ...parsed.omitted };
					if (bounded.contextLimitOmitted > 0) {
						increment(omissionCounts, "context-limit-message", bounded.contextLimitOmitted);
					}
					if (bounded.truncatedMessages > 0) {
						increment(omissionCounts, "truncated-message", bounded.truncatedMessages);
					}
					const notification = `Imported ${bounded.messages.length} OpenCode messages from ${sessionId}`;

					const result = await ctx.newSession({
						parentSession,
						setup: async (sessionManager) => {
							const importedEntries: Array<{
								sourceMessageId: string;
								piEntryId: string;
								contentHash: string;
							}> = [];
							for (const message of bounded.messages) {
								const piEntryId =
									message.role === "user"
										? sessionManager.appendMessage({
												role: "user",
												content: [{ type: "text", text: message.text }],
												timestamp: message.timestamp,
											})
										: sessionManager.appendMessage({
												role: "assistant",
												content: [{ type: "text", text: message.text }],
												api: model.api,
												provider: model.provider,
												model: model.id,
												usage: emptyUsage(),
												stopReason: "stop",
												timestamp: message.timestamp,
											});
								importedEntries.push({
									sourceMessageId: message.sourceMessageId,
									piEntryId,
									contentHash: message.contentHash,
								});
							}
							sessionManager.appendModelChange(model.provider, model.id);
							sessionManager.appendCustomEntry("resume-opencode", {
								version: 1,
								source: "opencode",
								nativeSessionId: parsed.info.id,
								sourceVersion: parsed.info.version,
								title: parsed.info.title,
								directory: parsed.info.directory,
								created: parsed.info.created,
								updated: parsed.info.updated,
								importedAt,
								sourceFingerprint,
								tokenBudget,
								truncatedCharacters: bounded.truncatedCharacters,
								omitted: omissionCounts,
								records: parsed.records,
								importedEntries,
							});
							sessionManager.appendSessionInfo(sessionName);
						},
						withSession: async (replacementCtx) => {
							replacementCtx.ui.notify(notification, "info");
						},
					});
					if (result.cancelled) {
						ctx.ui.notify("OpenCode import cancelled", "info");
					}
				} catch (error) {
					if (!ctx.hasUI) {
						process.exitCode = 1;
						throw error instanceof Error ? error : new Error(String(error));
					}
					ctx.ui.notify(`resume-opencode: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	};
}

const resumeOpenCodeExtension = createResumeOpenCodeExtension();

export default resumeOpenCodeExtension;
