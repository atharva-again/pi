import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	boundImportedMessages,
	createResumeOpenCodeExtension,
	parseOpenCodeExport,
	parseOpenCodeSessionList,
	type ResumeOpenCodeDependencies,
} from "../examples/extensions/resume-opencode/index.ts";
import type {
	ExtensionCommandContext,
	RegisteredCommand,
	ReplacedSessionContext,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const NOW = 1_700_000_000_000;
const SESSION_ID = "ses_abc123";
const CWD = "/tmp/pi-resume-opencode";
const DATABASE_PATH = "/tmp/opencode.db";

interface CommandHarness {
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; level: string }>;
	confirmations: string[];
	selectItems: string[];
	customScreens: string[];
	getReplacement(): SessionManager | undefined;
}

function exportPayload(directory = CWD): string {
	return JSON.stringify({
		info: {
			id: SESSION_ID,
			title: "Fix parser",
			directory,
			version: "1.17.20",
			time: { created: NOW - 5000, updated: NOW - 1000 },
		},
		messages: [
			{
				info: { id: "msg_user_1", role: "user", system: "hidden system", time: { created: NOW - 4000 } },
				parts: [
					{ id: "part_user", type: "text", text: "Please fix the parser" },
					{ id: "part_synthetic", type: "text", text: "stale file contents", synthetic: true },
					{ id: "part_file", type: "file", filename: "secret.txt" },
				],
			},
			{
				info: {
					id: "msg_assistant_1",
					role: "assistant",
					finish: "stop",
					time: { created: NOW - 3000, completed: NOW - 2500 },
				},
				parts: [
					{ id: "part_reasoning", type: "reasoning", text: "private reasoning" },
					{ id: "part_answer", type: "text", text: "Implemented the parser fix." },
					{ id: "part_tool", type: "tool", tool: "bash", state: { output: "secret tool output" } },
				],
			},
			{
				info: {
					id: "msg_summary",
					role: "assistant",
					summary: true,
					finish: "stop",
					time: { completed: NOW - 2200 },
				},
				parts: [{ id: "part_summary", type: "text", text: "hidden compaction summary" }],
			},
			{
				info: {
					id: "msg_error",
					role: "assistant",
					finish: "error",
					error: { name: "APIError" },
					time: { completed: NOW - 2100 },
				},
				parts: [{ id: "part_error", type: "text", text: "stale partial answer" }],
			},
			{
				info: { id: "msg_user_2", role: "user", time: { created: NOW - 2000 } },
				parts: [
					{ id: "part_ignored", type: "text", text: "ignored text", ignored: true },
					{ id: "part_user_2", type: "text", text: "Now add tests" },
				],
			},
			{
				info: { id: "msg_incomplete", role: "assistant", time: { created: NOW - 1000 } },
				parts: [{ id: "part_incomplete", type: "text", text: "unfinished answer" }],
			},
		],
	});
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function loadCommand(runOpenCode: ResumeOpenCodeDependencies["runOpenCode"], pathExists = true) {
	const result = await createTestExtensionsResult([
		createResumeOpenCodeExtension({
			runOpenCode,
			pathExists: () => pathExists,
			now: () => NOW,
		}),
	]);
	const command = result.extensions[0]?.commands.get("resume-opencode");
	if (!command) throw new Error("resume-opencode command was not registered");
	return command;
}

function createCommandHarness(
	options: {
		selectedIndex?: number;
		confirm?: boolean;
		modelContextWindow?: number;
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
	const cwd = options.cwd ?? CWD;
	const current = SessionManager.inMemory(cwd);
	const baseModel = getModel("anthropic", "claude-sonnet-4-5");
	if (!baseModel) throw new Error("test model not found");
	const model = { ...baseModel, contextWindow: options.modelContextWindow ?? baseModel.contextWindow };

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
			return await new Promise<T>((resolve, reject) => {
				let component: (Component & { dispose?(): void }) | undefined;
				let pending: T | undefined;
				const done = (value: T) => {
					if (!component) {
						pending = value;
						return;
					}
					component.dispose?.();
					resolve(value);
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
						} else if (screen.includes("Resume OpenCode Session")) {
							for (const key of options.pickerKeys ?? ["enter"]) {
								component.handleInput?.(key);
								if (key !== "enter") customScreens.push(component.render(100).join("\n"));
							}
						}
					})
					.catch(reject);
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
			replacement = SessionManager.inMemory(cwd);
			if (newSessionOptions?.parentSession) {
				replacement.newSession({ parentSession: newSessionOptions.parentSession });
			}
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
	};
}

async function runCommand(command: RegisteredCommand, args: string, harness: CommandHarness): Promise<void> {
	await command.handler(args, harness.ctx);
}

describe("resume-opencode", () => {
	it("imports only real user text and completed assistant text", async () => {
		const calls: string[][] = [];
		let exportCapturedToFile = false;
		let exportHasTimeout = false;
		let exportHasSizeCap = false;
		const command = await loadCommand(async (args, options) => {
			calls.push(args);
			if (args[0] === "export") {
				exportCapturedToFile = options.captureStdoutToFile ?? false;
				exportHasTimeout = options.timeoutMs !== undefined;
				exportHasSizeCap = options.maxStdoutBytes !== undefined || options.maxStderrBytes !== undefined;
			}
			if (args[0] === "db") return { stdout: `${DATABASE_PATH}\n`, stderr: "" };
			return { stdout: exportPayload(), stderr: `Exporting session: ${SESSION_ID}` };
		});
		const harness = createCommandHarness();

		await runCommand(command, SESSION_ID, harness);

		expect(calls).toEqual([
			["db", "path"],
			["export", SESSION_ID],
		]);
		expect(exportCapturedToFile).toBe(true);
		expect(exportHasTimeout).toBe(false);
		expect(exportHasSizeCap).toBe(false);
		const replacement = harness.getReplacement();
		expect(replacement).toBeDefined();
		const context = replacement!.buildSessionContext();
		expect(context.messages.map((message) => `${message.role}:${messageText(message)}`)).toEqual([
			"user:Please fix the parser",
			"assistant:Implemented the parser fix.",
			"user:Now add tests",
		]);
		expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(replacement!.getSessionName()).toBe("OpenCode: Fix parser");

		const provenance = replacement!
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "resume-opencode");
		expect(provenance?.type).toBe("custom");
		if (!provenance || provenance.type !== "custom") throw new Error("missing provenance entry");
		const data = provenance.data as {
			nativeSessionId: string;
			sourceFingerprint: string;
			omitted: Record<string, number>;
			importedEntries: unknown[];
		};
		expect(data.nativeSessionId).toBe(SESSION_ID);
		expect(data.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(data.importedEntries).toHaveLength(3);
		expect(data.omitted).toMatchObject({
			"system-prompt": 1,
			"synthetic-text-part": 1,
			"part:file": 1,
			"part:reasoning": 1,
			"part:tool": 1,
			"assistant-summary-message": 1,
			"assistant-error-message": 1,
			"ignored-text-part": 1,
			"assistant-incomplete-message": 1,
		});
		expect(harness.notifications.at(-1)?.message).toBe(`Imported 3 OpenCode messages from ${SESSION_ID}`);
	});

	it("uses the global metadata query and prioritizes sessions in the current directory", async () => {
		const calls: string[][] = [];
		const list = JSON.stringify([
			{
				id: "ses_foreign",
				title: "Newer foreign session",
				directory: "/tmp/other-project",
				created: NOW - 2000,
				updated: NOW,
			},
			{
				id: SESSION_ID,
				title: "Current session",
				directory: CWD,
				created: NOW - 5000,
				updated: NOW - 4000,
			},
		]);
		const command = await loadCommand(async (args) => {
			calls.push(args);
			if (args.join(" ") === "db path") return { stdout: `${DATABASE_PATH}\n`, stderr: "" };
			if (args[0] === "db") return { stdout: list, stderr: "" };
			return { stdout: exportPayload(), stderr: "" };
		});
		const harness = createCommandHarness();

		await runCommand(command, "", harness);

		expect(calls[1]?.slice(0, 3)).toEqual(["db", "--format", "json"]);
		expect(calls[1]?.[3]).toContain("FROM session");
		expect(calls.at(-1)).toEqual(["export", SESSION_ID]);
		expect(harness.selectItems[0]).toContain("current · Current session");
	});

	it("shows cancellable discovery/export loaders and a searchable TUI picker", async () => {
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
		const list = JSON.stringify([
			{
				id: SESSION_ID,
				title: "Current session",
				directory: CWD,
				created: NOW - 5000,
				updated: NOW - 1000,
			},
			{
				id: "ses_foreign",
				title: "Foreign session",
				directory: "/tmp/other-project",
				created: NOW - 7000,
				updated: NOW - 6000,
			},
		]);
		const command = await loadCommand(async (args) => {
			if (args.join(" ") === "db path") {
				return { stdout: `Checking OpenCode...\n${DATABASE_PATH}\n`, stderr: "" };
			}
			if (args[0] === "db") return { stdout: list, stderr: "" };
			return { stdout: `{"status":"checking"}\n${exportPayload()}\nDone`, stderr: "" };
		});
		const harness = createCommandHarness({ mode: "tui", pickerKeys: ["tab", "enter"] });

		try {
			await runCommand(command, "", harness);
		} finally {
			keybindings.setUserBindings(previousBindings);
		}

		expect(harness.notifications.filter((notification) => notification.level === "error")).toEqual([]);
		expect(harness.customScreens).toHaveLength(4);
		expect(harness.customScreens[0]).toContain("Discovering OpenCode sessions...");
		expect(harness.customScreens[1]).toContain("Resume OpenCode Session (Current Directory)");
		expect(harness.customScreens[1]).toContain("Search by title, directory, or session ID");
		expect(harness.customScreens[1]).toContain("ctrl+g");
		expect(harness.customScreens[1]).toContain("ctrl+p/ctrl+n");
		expect(harness.customScreens[1]).toContain("ctrl+o");
		expect(harness.customScreens[1]).toContain("ctrl+x");
		expect(harness.customScreens[1]).toContain("Current session");
		expect(harness.customScreens[1]).toContain(SESSION_ID);
		expect(harness.customScreens[1]).not.toContain("Foreign session");
		expect(harness.customScreens[2]).toContain("Resume OpenCode Session (All)");
		expect(harness.customScreens[2]).toContain("Foreign session");
		expect(harness.customScreens[3]).toContain(`Exporting ${SESSION_ID}...`);
		expect(harness.getReplacement()).toBeDefined();
	});

	it("requires confirmation before importing history from another directory", async () => {
		const command = await loadCommand(async (args) => {
			if (args[0] === "db") return { stdout: `${DATABASE_PATH}\n`, stderr: "" };
			return { stdout: exportPayload("/tmp/other-project"), stderr: "" };
		});
		const harness = createCommandHarness({ confirm: false });

		await runCommand(command, SESSION_ID, harness);

		expect(harness.confirmations).toHaveLength(1);
		expect(harness.getReplacement()).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toBe("OpenCode import cancelled");
	});

	it("treats symlinked working directories as the current directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-resume-opencode-test-"));
		const realDirectory = join(root, "real");
		const linkedDirectory = join(root, "linked");
		mkdirSync(realDirectory);
		symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

		try {
			const list = JSON.stringify([
				{
					id: SESSION_ID,
					title: "Symlinked session",
					directory: realDirectory,
					created: NOW - 5000,
					updated: NOW - 1000,
				},
			]);
			const command = await loadCommand(async (args) => {
				if (args.join(" ") === "db path") return { stdout: `${DATABASE_PATH}\n`, stderr: "" };
				if (args[0] === "db") return { stdout: list, stderr: "" };
				return { stdout: exportPayload(realDirectory), stderr: "" };
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

	it("propagates command failures when dialog UI is unavailable", async () => {
		const command = await loadCommand(async () => ({ stdout: `${DATABASE_PATH}\n`, stderr: "" }), false);
		const harness = createCommandHarness({ mode: "print", hasUI: false });
		const previousExitCode = process.exitCode;

		try {
			await expect(runCommand(command, "invalid", harness)).rejects.toThrow("Usage: /resume-opencode [ses_...]");
			await expect(runCommand(command, SESSION_ID, harness)).rejects.toThrow(
				`OpenCode database not found at ${DATABASE_PATH}`,
			);
			expect(process.exitCode).toBe(1);
			expect(harness.notifications).toEqual([]);
			expect(harness.getReplacement()).toBeUndefined();
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("does not invoke export when the OpenCode database is absent", async () => {
		const calls: string[][] = [];
		const command = await loadCommand(async (args) => {
			calls.push(args);
			return { stdout: `${DATABASE_PATH}\n`, stderr: "" };
		}, false);
		const harness = createCommandHarness();

		await runCommand(command, SESSION_ID, harness);

		expect(calls).toEqual([["db", "path"]]);
		expect(harness.getReplacement()).toBeUndefined();
		expect(harness.notifications.at(-1)).toEqual({
			message: `resume-opencode: OpenCode database not found at ${DATABASE_PATH}`,
			level: "error",
		});
	});

	it("bounds imported context and records message truncation", () => {
		const longText = "x".repeat(8000);
		const parsed = parseOpenCodeExport(
			JSON.stringify({
				info: { id: SESSION_ID, title: "Large", directory: CWD, time: {} },
				messages: [
					{
						info: { id: "user", role: "user", time: { created: NOW } },
						parts: [{ id: "user-part", type: "text", text: longText }],
					},
					{
						info: { id: "assistant", role: "assistant", finish: "stop", time: { completed: NOW } },
						parts: [{ id: "assistant-part", type: "text", text: longText }],
					},
				],
			}),
			SESSION_ID,
			NOW,
		);

		const bounded = boundImportedMessages(parsed.messages, 1000);

		expect(bounded.messages).toHaveLength(2);
		expect(bounded.truncatedMessages).toBe(2);
		expect(bounded.truncatedCharacters).toBeGreaterThan(0);
		expect(
			bounded.messages.every((message) => message.text.includes("[OpenCode message truncated during import]")),
		).toBe(true);
	});

	it("validates list and export payloads", () => {
		expect(
			parseOpenCodeSessionList(
				JSON.stringify([
					{ id: SESSION_ID, title: "valid", directory: CWD, created: 1, updated: 2 },
					{ id: "invalid", title: "invalid", directory: CWD, created: 1, updated: 2 },
				]),
			),
		).toEqual([{ id: SESSION_ID, title: "valid", directory: CWD, created: 1, updated: 2 }]);
		expect(
			parseOpenCodeSessionList(
				`OpenCode update available\n${JSON.stringify([{ id: SESSION_ID, title: "valid", directory: CWD }])}\nDone`,
			),
		).toHaveLength(1);
		expect(
			parseOpenCodeSessionList(
				`${JSON.stringify({ status: "checking", warnings: [] })}\n${JSON.stringify([{ id: SESSION_ID, title: "valid", directory: CWD }])}`,
			),
		).toHaveLength(1);
		expect(
			parseOpenCodeExport(`{"status":"checking"}\n${exportPayload()}\nDone`, SESSION_ID, NOW).messages,
		).toHaveLength(3);
		expect(() => parseOpenCodeExport(exportPayload(), "ses_wrong", NOW)).toThrow(
			`OpenCode export returned unexpected session ID ${SESSION_ID}`,
		);
	});
});
