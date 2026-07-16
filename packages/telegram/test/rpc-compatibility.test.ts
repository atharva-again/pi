import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcProcessInstance, type RpcProcessInstance } from "../src/rpc-process.ts";

const testDirectories: string[] = [];

function sendWithTimeout(rpc: RpcProcessInstance, command: RpcCommand): Promise<RpcResponse> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${command.type}`)), 20_000);
		void rpc.send(command).then(
			(response) => {
				clearTimeout(timeout);
				resolve(response);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

function expectSuccess<T extends RpcResponse["command"]>(
	response: RpcResponse,
	command: T,
): asserts response is Extract<RpcResponse, { success: true; command: T }> {
	if (!response.success || response.command !== command) {
		throw new Error(`Expected successful ${command} response: ${JSON.stringify(response)}`);
	}
	expect(response).toMatchObject({ command, success: true, type: "response" });
}

afterEach(() => {
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Telegram coding-agent RPC compatibility", () => {
	it("supports every fork-specific RPC capability used by pi-tg", async () => {
		const testDirectory = mkdtempSync(join(tmpdir(), "pi-tg-rpc-"));
		testDirectories.push(testDirectory);
		const agentDirectory = join(testDirectory, "agent");
		const workspace = join(testDirectory, "workspace");
		const sessionDirectory = join(testDirectory, "sessions");
		const exportPath = join(testDirectory, "session.jsonl");
		mkdirSync(agentDirectory, { recursive: true });
		mkdirSync(workspace, { recursive: true });

		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		const rpc = createRpcProcessInstance({ cwd: workspace, args: ["--session-dir", sessionDirectory] });

		try {
			const state = await sendWithTimeout(rpc, { type: "get_state" });
			expectSuccess(state, "get_state");
			expect(state.data.cwd).toBe(workspace);

			const scopedModels = await sendWithTimeout(rpc, { type: "get_scoped_models" });
			expectSuccess(scopedModels, "get_scoped_models");
			expect(scopedModels.data.scopedModels).toBeInstanceOf(Array);

			const setScopedModels = await sendWithTimeout(rpc, { type: "set_scoped_models", patterns: [] });
			expectSuccess(setScopedModels, "set_scoped_models");

			const setName = await sendWithTimeout(rpc, {
				type: "set_session_name",
				name: "Telegram RPC compatibility",
			});
			expectSuccess(setName, "set_session_name");

			const exported = await sendWithTimeout(rpc, { type: "export_jsonl", outputPath: exportPath });
			expectSuccess(exported, "export_jsonl");
			expect(exported.data.path).toBe(exportPath);
			expect(existsSync(exportPath)).toBe(true);

			const imported = await sendWithTimeout(rpc, {
				type: "import_jsonl",
				inputPath: exportPath,
				cwdOverride: workspace,
			});
			expectSuccess(imported, "import_jsonl");
			expect(imported.data.cancelled).toBe(false);

			const tree = await sendWithTimeout(rpc, { type: "get_tree" });
			expectSuccess(tree, "get_tree");
			const entryId = tree.data.tree[0]?.entry.id;
			expect(entryId).toBeDefined();
			if (!entryId) throw new Error("Expected imported session tree entry");

			const navigated = await sendWithTimeout(rpc, { type: "navigate_tree", entryId });
			expectSuccess(navigated, "navigate_tree");
			expect(navigated.data.cancelled).toBe(false);

			const reloaded = await sendWithTimeout(rpc, { type: "reload" });
			expectSuccess(reloaded, "reload");
		} finally {
			await rpc.dispose();
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		}
	}, 30_000);
});
