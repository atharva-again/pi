import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createResumeCodexExtension,
	parseCodexThread,
	parseCodexThreadList,
	type ResumeCodexDependencies,
	resolveCodexScript,
} from "../examples/extensions/resume-codex/index.ts";
import type {
	ExtensionCommandContext,
	RegisteredCommand,
	ReplacedSessionContext,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const NOW = 1_700_000_000_000;
const THREAD_ID = "019f5f7c-1de1-77d1-b12f-972d618e845f";
const CWD = "/tmp/pi-resume-codex";

interface CommandHarness {
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; level: string }>;
	confirmations: string[];
	selectItems: string[];
	customScreens: string[];
	getReplacement(): SessionManager | undefined;
	hasParentSessionOption(): boolean;
}

interface FakeServerState {
	opened: number;
	closed: number;
	requests: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }>;
}

function threadPayload(directory = CWD, threadId = THREAD_ID): Record<string, unknown> {
	return {
		thread: {
			id: threadId,
			sessionId: threadId,
			name: "Fix parser",
			preview: "Please fix the parser",
			cwd: directory,
			source: "cli",
			cliVersion: "0.144.5",
			createdAt: (NOW - 10_000) / 1000,
			updatedAt: (NOW - 1000) / 1000,
			recencyAt: (NOW - 2000) / 1000,
			turns: [
				{
					id: "turn-completed",
					status: "completed",
					itemsView: "full",
					startedAt: (NOW - 9000) / 1000,
					completedAt: (NOW - 8000) / 1000,
					items: [
						{
							type: "userMessage",
							id: "user-1",
							content: [
								{ type: "text", text: "Please fix the parser" },
								{ type: "image", url: "https://example.com/private.png" },
								{ type: "skill", name: "secret-skill", path: "/tmp/secret" },
							],
						},
						{ type: "hookPrompt", id: "hook-1", fragments: [{ text: "hidden system prompt" }] },
						{ type: "reasoning", id: "reasoning-1", summary: ["private reasoning"], content: [] },
						{
							type: "commandExecution",
							id: "command-1",
							command: "cat secret.txt",
							aggregatedOutput: "secret output",
						},
						{
							type: "agentMessage",
							id: "assistant-1",
							text: "Implemented the parser fix.",
							phase: "final_answer",
						},
					],
				},
				{
					id: "turn-failed",
					status: "failed",
					itemsView: "full",
					startedAt: (NOW - 7000) / 1000,
					completedAt: (NOW - 6000) / 1000,
					items: [
						{
							type: "userMessage",
							id: "user-2",
							content: [
								{ type: "text", text: "Now add tests" },
								{ type: "mention", name: "README.md", path: "/tmp/README.md" },
							],
						},
						{ type: "agentMessage", id: "assistant-failed", text: "unfinished failed answer" },
					],
				},
				{
					id: "turn-interrupted",
					status: "interrupted",
					itemsView: "full",
					startedAt: (NOW - 5000) / 1000,
					completedAt: (NOW - 4000) / 1000,
					items: [
						{
							type: "userMessage",
							id: "user-3",
							content: [{ type: "text", text: "Check Windows too" }],
						},
						{ type: "agentMessage", id: "assistant-interrupted", text: "unfinished interrupted answer" },
					],
				},
				{
					id: "turn-running",
					status: "inProgress",
					itemsView: "full",
					startedAt: (NOW - 3000) / 1000,
					completedAt: null,
					items: [
						{
							type: "userMessage",
							id: "user-4",
							content: [{ type: "text", text: "One more thing" }],
						},
						{ type: "agentMessage", id: "assistant-running", text: "unfinished running answer" },
					],
				},
			],
		},
	};
}

function listThread(
	id: string,
	directory: string,
	title: string,
	updated: number,
	source = "cli",
): Record<string, unknown> {
	return {
		id,
		name: title,
		preview: title,
		cwd: directory,
		source,
		createdAt: (updated - 1000) / 1000,
		updatedAt: updated / 1000,
		recencyAt: updated / 1000,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function loadCommand(
	handler: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
): Promise<{ command: RegisteredCommand; state: FakeServerState }> {
	const state: FakeServerState = { opened: 0, closed: 0, requests: [] };
	const openCodexAppServer: ResumeCodexDependencies["openCodexAppServer"] = async () => {
		state.opened++;
		return {
			async request(method, params, timeoutMs) {
				state.requests.push({ method, params, timeoutMs });
				return await handler(method, params, timeoutMs);
			},
			async close() {
				state.closed++;
			},
		};
	};
	const result = await createTestExtensionsResult([
		createResumeCodexExtension({
			openCodexAppServer,
			now: () => NOW,
		}),
	]);
	const command = result.extensions[0]?.commands.get("resume-codex");
	if (!command) throw new Error("resume-codex command was not registered");
	return { command, state };
}

function createCommandHarness(
	options: {
		selectedIndex?: number;
		confirm?: boolean;
		mode?: "print" | "rpc" | "tui";
		hasUI?: boolean;
		cwd?: string;
		pickerKeys?: string[];
	} = {},
): CommandHarness {
	const notifications: Array<{ message: string; level: string }> = [];
	const confirmations: string[] = [];
	const selectItems: string[] = [];
	const customScreens: string[] = [];
	let replacement: SessionManager | undefined;
	let parentSessionOption = false;
	const cwd = options.cwd ?? CWD;
	const current = SessionManager.inMemory(cwd);
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("test model not found");

	const ui = {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		async select(_title: string, items: string[]) {
			selectItems.push(...items);
			return items[options.selectedIndex ?? 0];
		},
		async confirm(_title: string, message: string) {
			confirmations.push(message);
			return options.confirm ?? true;
		},
		async custom<T>(factory: unknown): Promise<T> {
			type CustomFactory = (
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string; bold(text: string): string },
				keybindings: { matches(data: string, id: string): boolean },
				done: (value: T) => void,
			) => Component | Promise<Component>;
			const typedFactory = factory as CustomFactory;
			return await new Promise<T>((resolveCustom, rejectCustom) => {
				let component: (Component & { dispose?(): void }) | undefined;
				let pending: T | undefined;
				const done = (value: T) => {
					if (!component) {
						pending = value;
						return;
					}
					component.dispose?.();
					resolveCustom(value);
				};
				Promise.resolve(
					typedFactory(
						{ requestRender() {} },
						{ fg: (_color, text) => text, bold: (text) => text },
						{
							matches: (data, id) =>
								(data === "enter" && id === "tui.select.confirm") || (data === "tab" && id === "tui.input.tab"),
						},
						done,
					),
				)
					.then((created) => {
						component = created;
						const screen = component.render(100).join("\n");
						customScreens.push(screen);
						if (pending !== undefined) {
							const value = pending;
							pending = undefined;
							done(value);
						} else if (screen.includes("Resume Codex Session")) {
							for (const key of options.pickerKeys ?? ["enter"]) {
								component.handleInput?.(key);
								if (key !== "enter") customScreens.push(component.render(100).join("\n"));
							}
						}
					})
					.catch(rejectCustom);
			});
		},
	};

	const ctx = {
		ui,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		cwd,
		sessionManager: current,
		model,
		async waitForIdle() {},
		async newSession(newSessionOptions?: Parameters<ExtensionCommandContext["newSession"]>[0]) {
			parentSessionOption = Object.hasOwn(newSessionOptions ?? {}, "parentSession");
			replacement = SessionManager.inMemory(cwd);
			if (newSessionOptions?.parentSession)
				replacement.newSession({ parentSession: newSessionOptions.parentSession });
			await newSessionOptions?.setup?.(replacement);
			if (newSessionOptions?.withSession) {
				await newSessionOptions.withSession({
					ui,
					sessionManager: replacement,
				} as unknown as ReplacedSessionContext);
			}
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		confirmations,
		selectItems,
		customScreens,
		getReplacement: () => replacement,
		hasParentSessionOption: () => parentSessionOption,
	};
}

async function runCommand(command: RegisteredCommand, args: string, harness: CommandHarness): Promise<void> {
	await command.handler(args, harness.ctx);
}

describe("resume-codex", () => {
	it("resolves the Codex script from a custom Windows npm prefix", () => {
		const prefix = "/custom/npm-prefix";
		const expected = join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");

		const resolved = resolveCodexScript({
			platform: "win32",
			appData: "/missing/appdata",
			runNpmPrefixCommand(command, options) {
				expect(command).toBe("npm prefix -g");
				expect(options).toEqual({ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
				return `${prefix}\r\n`;
			},
			pathExists: (path) => path === expected,
		});

		expect(resolved).toBe(expected);
	});

	it("imports user text and only completed assistant text", async () => {
		const { command, state } = await loadCommand(async (method) => {
			if (method !== "thread/read") throw new Error(`unexpected method ${method}`);
			return threadPayload();
		});
		const harness = createCommandHarness();

		await runCommand(command, THREAD_ID, harness);

		expect(state.requests).toEqual([
			{
				method: "thread/read",
				params: { threadId: THREAD_ID, includeTurns: true },
				timeoutMs: 120_000,
			},
		]);
		expect(state.opened).toBe(1);
		expect(state.closed).toBe(1);
		const replacement = harness.getReplacement();
		expect(replacement).toBeDefined();
		const context = replacement!.buildSessionContext();
		expect(context.messages.map((message) => `${message.role}:${messageText(message)}`)).toEqual([
			"user:Please fix the parser",
			"assistant:Implemented the parser fix.",
			"user:Now add tests",
			"user:Check Windows too",
			"user:One more thing",
		]);
		expect(context.messages.map((message) => message.timestamp)).toEqual([NOW, NOW, NOW, NOW, NOW]);
		expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(replacement!.getSessionName()).toBeUndefined();
		expect(harness.hasParentSessionOption()).toBe(false);

		const provenance = replacement!
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "resume-codex");
		if (!provenance || provenance.type !== "custom") throw new Error("missing provenance entry");
		const data = provenance.data as {
			version: number;
			nativeThreadId: string;
			sourceVersion: string;
			sourceFingerprint: string;
			omitted: Record<string, number>;
			importedEntries: Array<{ sourceTimestamp: number }>;
		};
		expect(data.version).toBe(1);
		expect(data.nativeThreadId).toBe(THREAD_ID);
		expect(data.sourceVersion).toBe("0.144.5");
		expect(data.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(data.importedEntries.map((entry) => entry.sourceTimestamp)).toEqual([
			NOW - 9000,
			NOW - 8000,
			NOW - 7000,
			NOW - 5000,
			NOW - 3000,
		]);
		expect(data.omitted).toMatchObject({
			"input:image": 1,
			"input:skill": 1,
			"input:mention": 1,
			"item:hookPrompt": 1,
			"item:reasoning": 1,
			"item:commandExecution": 1,
			"assistant-failed-item": 1,
			"assistant-interrupted-item": 1,
			"assistant-inProgress-item": 1,
		});
		expect(harness.notifications.at(-1)?.message).toBe(`Imported 5 Codex messages from ${THREAD_ID}`);
	});

	it("paginates interactive sessions and prioritizes the current directory", async () => {
		const foreignId = "019f5f7c-1de1-77d1-b12f-972d618e8460";
		const { command, state } = await loadCommand(async (method, params) => {
			if (method === "thread/list") {
				return params.cursor === null
					? {
							data: [listThread(foreignId, "/tmp/other-project", "Newer foreign", NOW)],
							nextCursor: "page-2",
						}
					: {
							data: [listThread(THREAD_ID, CWD, "Current session", NOW - 4000, "vscode")],
							nextCursor: null,
						};
			}
			if (method === "thread/read") return threadPayload();
			throw new Error(`unexpected method ${method}`);
		});
		const harness = createCommandHarness();

		await runCommand(command, "", harness);

		expect(state.requests.slice(0, 2)).toEqual([
			{
				method: "thread/list",
				params: {
					cursor: null,
					limit: 100,
					sortKey: "recency_at",
					sortDirection: "desc",
					sourceKinds: ["cli", "vscode"],
					archived: false,
				},
				timeoutMs: 30_000,
			},
			{
				method: "thread/list",
				params: {
					cursor: "page-2",
					limit: 100,
					sortKey: "recency_at",
					sortDirection: "desc",
					sourceKinds: ["cli", "vscode"],
					archived: false,
				},
				timeoutMs: 30_000,
			},
		]);
		expect(state.requests.at(-1)?.params).toEqual({ threadId: THREAD_ID, includeTurns: true });
		expect(state.opened).toBe(2);
		expect(state.closed).toBe(2);
		expect(harness.selectItems[0]).toContain("current · Current session");
		expect(harness.selectItems[0]).toContain("vscode");
	});

	it("shows cancellable loaders and a searchable TUI picker", async () => {
		initTheme("dark", false);
		const keybindings = getKeybindings();
		const previousBindings = keybindings.getUserBindings();
		keybindings.setUserBindings({
			...previousBindings,
			"tui.input.tab": "ctrl+g",
			"tui.select.up": "ctrl+p",
			"tui.select.down": "ctrl+n",
			"tui.select.confirm": "ctrl+o",
			"tui.select.cancel": "ctrl+x",
		});
		const foreignId = "019f5f7c-1de1-77d1-b12f-972d618e8460";
		const { command } = await loadCommand(async (method) => {
			if (method === "thread/list") {
				return {
					data: [
						listThread(THREAD_ID, CWD, "Current session", NOW - 1000),
						listThread(foreignId, "/tmp/other-project", "Foreign session", NOW - 2000, "vscode"),
					],
					nextCursor: null,
				};
			}
			if (method === "thread/read") return threadPayload();
			throw new Error(`unexpected method ${method}`);
		});
		const harness = createCommandHarness({ mode: "tui", pickerKeys: ["tab", "enter"] });

		try {
			await runCommand(command, "", harness);
		} finally {
			keybindings.setUserBindings(previousBindings);
		}

		expect(harness.notifications.filter((notification) => notification.level === "error")).toEqual([]);
		expect(harness.customScreens).toHaveLength(4);
		expect(harness.customScreens[0]).toContain("Discovering Codex sessions...");
		expect(harness.customScreens[1]).toContain("Resume Codex Session (Current Directory)");
		expect(harness.customScreens[1]).toContain("Search by title, directory, source, or thread ID");
		expect(harness.customScreens[1]).toContain("ctrl+g");
		expect(harness.customScreens[1]).toContain("Current session");
		expect(harness.customScreens[1]).not.toContain("Foreign session");
		expect(harness.customScreens[2]).toContain("Resume Codex Session (All)");
		expect(harness.customScreens[2]).toContain("Foreign session");
		expect(harness.customScreens[3]).toContain(`Reading ${THREAD_ID}...`);
		expect(harness.getReplacement()).toBeDefined();
	});

	it("requires confirmation before importing history from another directory", async () => {
		const { command } = await loadCommand(async () => threadPayload("/tmp/other-project"));
		const harness = createCommandHarness({ confirm: false });

		await runCommand(command, THREAD_ID, harness);

		expect(harness.confirmations).toHaveLength(1);
		expect(harness.getReplacement()).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toBe("Codex import cancelled");
	});

	it("treats symlinked working directories as the current directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-resume-codex-test-"));
		const realDirectory = join(root, "real");
		const linkedDirectory = join(root, "linked");
		mkdirSync(realDirectory);
		symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

		try {
			const { command } = await loadCommand(async (method) => {
				if (method === "thread/list") {
					return { data: [listThread(THREAD_ID, realDirectory, "Symlinked session", NOW)], nextCursor: null };
				}
				return threadPayload(realDirectory);
			});
			const harness = createCommandHarness({ cwd: linkedDirectory });

			await runCommand(command, "", harness);

			expect(harness.selectItems[0]).toContain("current · Symlinked session");
			expect(harness.confirmations).toEqual([]);
			expect(harness.getReplacement()).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates validation and app-server failures without changing the host exit code", async () => {
		const { command, state } = await loadCommand(async () => {
			throw new Error("Codex thread/read failed: unsupported history");
		});
		const harness = createCommandHarness({ mode: "print", hasUI: false });
		const previousExitCode = process.exitCode;

		try {
			await expect(runCommand(command, "invalid id", harness)).rejects.toThrow("Usage: /resume-codex [thread-id]");
			await expect(runCommand(command, "", harness)).rejects.toThrow(
				"Usage: /resume-codex <thread-id> (a picker requires interactive or RPC mode)",
			);
			await expect(runCommand(command, THREAD_ID, harness)).rejects.toThrow("unsupported history");
			expect(process.exitCode).toBe(previousExitCode);
			expect(harness.notifications).toEqual([]);
			expect(harness.getReplacement()).toBeUndefined();
			expect(state.opened).toBe(1);
			expect(state.closed).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("imports full message text and leaves context compaction to Pi", async () => {
		const longUserText = "u".repeat(8000);
		const longAssistantText = "a".repeat(8000);
		const payload = threadPayload();
		const thread = payload.thread as Record<string, unknown>;
		thread.turns = [
			{
				id: "large-turn",
				status: "completed",
				itemsView: "full",
				startedAt: NOW / 1000,
				completedAt: NOW / 1000,
				items: [
					{ type: "userMessage", id: "large-user", content: [{ type: "text", text: longUserText }] },
					{ type: "agentMessage", id: "large-assistant", text: longAssistantText },
				],
			},
		];
		const { command } = await loadCommand(async () => payload);
		const harness = createCommandHarness();

		await runCommand(command, THREAD_ID, harness);

		const context = harness.getReplacement()?.buildSessionContext();
		expect(context?.messages.map(messageText)).toEqual([longUserText, longAssistantText]);
		const provenance = harness
			.getReplacement()
			?.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "resume-codex");
		if (!provenance || provenance.type !== "custom") throw new Error("missing provenance entry");
		const data = provenance.data as { omitted: Record<string, number> };
		expect(data.omitted).not.toHaveProperty("context-limit-message");
		expect(data.omitted).not.toHaveProperty("truncated-message");
	});

	it("validates list and thread payloads", () => {
		expect(
			parseCodexThreadList({
				data: [listThread(THREAD_ID, CWD, "Valid", NOW)],
				nextCursor: "next",
			}),
		).toEqual({
			sessions: [
				{
					id: THREAD_ID,
					title: "Valid",
					directory: CWD,
					source: "cli",
					created: NOW - 1000,
					updated: NOW,
				},
			],
			nextCursor: "next",
		});
		expect(() => parseCodexThreadList({ data: "invalid" })).toThrow("invalid response");
		expect(() =>
			parseCodexThreadList({
				data: [{ id: "invalid id", cwd: CWD, createdAt: 1, updatedAt: 2 }],
				nextCursor: null,
			}),
		).toThrow("invalid thread at index 0");
		expect(() => parseCodexThread(threadPayload(), "wrong-id", NOW)).toThrow(
			`Codex thread/read returned unexpected thread ID ${THREAD_ID}`,
		);

		const invalidTurn = threadPayload();
		(invalidTurn.thread as Record<string, unknown>).turns = [{ id: "broken", items: [] }];
		expect(() => parseCodexThread(invalidTurn, THREAD_ID, NOW)).toThrow("invalid turn metadata at index 0");

		const incompleteTurn = threadPayload();
		(incompleteTurn.thread as Record<string, unknown>).turns = [
			{ id: "summary", status: "completed", itemsView: "summary", items: [] },
		];
		expect(() => parseCodexThread(incompleteTurn, THREAD_ID, NOW)).toThrow("incomplete items for turn summary");

		const invalidTimestamp = threadPayload();
		const invalidTimestampTurns = (invalidTimestamp.thread as Record<string, unknown>).turns as Array<
			Record<string, unknown>
		>;
		invalidTimestampTurns[0].startedAt = "not-a-timestamp";
		expect(() => parseCodexThread(invalidTimestamp, THREAD_ID, NOW)).toThrow(
			"invalid timestamps for turn turn-completed",
		);

		const invalidUserMessage = threadPayload();
		(invalidUserMessage.thread as Record<string, unknown>).turns = [
			{
				id: "broken-user-turn",
				status: "completed",
				itemsView: "full",
				startedAt: null,
				completedAt: null,
				items: [{ type: "userMessage", id: "broken-user", content: "not-an-array" }],
			},
		];
		expect(() => parseCodexThread(invalidUserMessage, THREAD_ID, NOW)).toThrow(
			"invalid content for user message broken-user",
		);

		const invalidAssistantMessage = threadPayload();
		(invalidAssistantMessage.thread as Record<string, unknown>).turns = [
			{
				id: "broken-assistant-turn",
				status: "completed",
				itemsView: "full",
				startedAt: null,
				completedAt: null,
				items: [{ type: "agentMessage", id: "broken-assistant", text: null }],
			},
		];
		expect(() => parseCodexThread(invalidAssistantMessage, THREAD_ID, NOW)).toThrow(
			"invalid text for assistant message broken-assistant",
		);
	});
});
