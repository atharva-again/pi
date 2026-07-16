import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function assistantMessage(
	model: Pick<AssistantMessage, "api" | "provider"> & { id: string },
	text: string,
): AssistantMessage {
	return {
		...fauxAssistantMessage(text, { timestamp: Date.now() }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("AgentSession work duration entries", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-work-duration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records display-only work duration entries outside LLM context", async () => {
		const startedAt = new Date("2025-01-01T00:00:00.000Z").getTime();
		vi.setSystemTime(startedAt);
		const model = session.model!;
		session.agent.streamFn = () => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				vi.setSystemTime(startedAt + 1500);
				stream.push({ type: "done", reason: "stop", message: assistantMessage(model, "done") });
			});
			return stream;
		};

		await session.prompt("hello");

		const entries = sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual(["message", "message", "work_duration"]);
		const duration = entries[2];
		expect(duration).toMatchObject({ type: "work_duration", durationMs: 1500 });
		expect(sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("records separate durations for queued follow-up messages in the same agent run", async () => {
		const startedAt = new Date("2025-01-01T00:00:00.000Z").getTime();
		vi.setSystemTime(startedAt);
		const model = session.model!;
		let callCount = 0;
		session.agent.streamFn = () => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				if (callCount === 1) {
					vi.setSystemTime(startedAt + 1000);
					void session.followUp("second");
					stream.push({ type: "done", reason: "stop", message: assistantMessage(model, "first done") });
				} else {
					vi.setSystemTime(startedAt + 2500);
					stream.push({ type: "done", reason: "stop", message: assistantMessage(model, "second done") });
				}
			});
			return stream;
		};

		await session.prompt("first");

		const entries = sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"work_duration",
			"message",
			"message",
			"work_duration",
		]);
		expect(entries.filter((entry) => entry.type === "work_duration").map((entry) => entry.durationMs)).toEqual([
			1000, 1500,
		]);
	});
});
