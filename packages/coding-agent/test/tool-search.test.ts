import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Bm25Ranker, createToolSearchDocument, tokenize } from "../src/extensions/tool-search/tool.ts";

function tool(name: string, description: string, properties: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Unsafe({ type: "object", properties }),
		execute: async () => ({ content: [], details: undefined }),
	};
}

describe("tokenize", () => {
	it("splits camelCase and snake_case, drops stop words, and folds plurals", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
		expect(tokenize("repo.issues/search:queries")).toEqual(["repo", "issue", "search", "query"]);
	});

	it.each([
		["搜索仓库问题", ["搜索", "仓库", "问题"]],
		["文書を検索", ["文書", "を", "検索"]],
		["문서 검색", ["문서", "검색"]],
		["ค้นหาเอกสาร", ["ค้นหา", "เอกสาร"]],
		["Поиск документов", ["поиск", "документов"]],
		["البحث عن الملفات", ["البحث", "عن", "الملفات"]],
		["फ़ाइल खोजें", ["फ़ाइल", "खोजें"]],
		["Éléments cafés", ["éléments", "cafés"]],
	])("segments Unicode words in %s", (text, expected) => {
		expect(tokenize(text)).toEqual(expected);
	});

	it("preserves non-ASCII words and splits mixed-language identifiers", () => {
		expect(tokenize("搜索GitHub_repoIssues résumé cafés")).toEqual([
			"搜索",
			"git",
			"hub",
			"repo",
			"issue",
			"résumé",
			"cafés",
		]);
	});

	it("normalizes canonically equivalent Unicode text", () => {
		expect(tokenize("CAFÉ cafe\u0301")).toEqual(["café", "café"]);
	});

	it("ignores whitespace, punctuation, and emoji", () => {
		expect(tokenize(" \t，。!? 😀 ")).toEqual([]);
	});
});

describe("Bm25Ranker", () => {
	const tools = [
		tool("github__list_issues", "List issues in a repository.", {
			state: { type: "string", description: "open or closed" },
		}),
		tool("github__create_pull_request", "Open a pull request."),
		tool("linear__search_issues", "Search Linear issues by text."),
		tool("docs__search", "Search the documentation."),
	];
	const documents = tools.map((entry) => createToolSearchDocument(entry));

	it("ranks by term relevance and respects the limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("issue", documents, 8).map((match) => match.name)).toEqual([
			"linear__search_issues",
			"github__list_issues",
		]);
		expect(ranker.rank("pull requests", documents, 8)[0].name).toBe("github__create_pull_request");
		expect(ranker.rank("search", documents, 1)).toHaveLength(1);
		// Property names and descriptions are searchable.
		expect(ranker.rank("closed", documents, 8).map((match) => match.name)).toEqual(["github__list_issues"]);
	});

	it.each([
		["搜索仓库问题", "问题"],
		["文書を検索", "検索"],
		["문서 검색", "검색"],
		["ค้นหาเอกสาร", "เอกสาร"],
		["Поиск документов", "документов"],
		["البحث عن الملفات", "الملفات"],
		["फ़ाइल खोजें", "खोजें"],
		["Rechercher un café", "cafe\u0301"],
	])("matches Unicode queries against %s", (description, query) => {
		const localized = createToolSearchDocument(tool("localized", description));
		expect(new Bm25Ranker().rank(query, [...documents, localized], 8)).toEqual([
			{ name: "localized", score: expect.any(Number) },
		]);
	});

	it("returns nothing for unknown or empty queries", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("kubernetes", documents, 8)).toEqual([]);
		expect(ranker.rank("the", documents, 8)).toEqual([]);
		// Known v1 limit: no synonyms, so "tickets" does not find "issues".
		expect(ranker.rank("tickets", documents, 8)).toEqual([]);
	});

	// https://github.com/earendil-works/pi/issues/11331
	it("ranks a tool first when the query is its name", () => {
		const named = [
			tool("server__app__queue_read", "Read a queued message of this thread."),
			tool(
				"server__dev-app__thread_read",
				"Read durable state and a paginated timeline from any thread. The default view returns user messages, assistant messages and plans. Continue with afterPosition until hasMore is false.",
			),
		].map((entry) => createToolSearchDocument(entry));
		const ranker = new Bm25Ranker();
		for (const query of [
			"thread_read",
			"dev_app__thread_read",
			"server__dev-app__thread_read",
			"Thread_Read",
			"thread read",
		]) {
			expect(ranker.rank(query, named, 1).map((match) => match.name)).toEqual(["server__dev-app__thread_read"]);
		}
		// Partial names still rank by BM25.
		expect(ranker.rank("read", named, 1).map((match) => match.name)).toEqual(["server__app__queue_read"]);
	});

	// https://github.com/earendil-works/pi/issues/11331
	it("ranks a name match above mentions in descriptions", () => {
		const documents = [
			tool("server__ci__status", "Deploy status: last deploy, deploy log, deploy errors."),
			tool(
				"server__ci__deploy_release",
				"Start a release of the current branch to an environment, run the migrations, switch traffic over, and wait until the new version is live and healthy.",
			),
		].map((entry) => createToolSearchDocument(entry));
		expect(new Bm25Ranker().rank("deploy", documents, 1).map((match) => match.name)).toEqual([
			"server__ci__deploy_release",
		]);
	});

	// https://github.com/earendil-works/pi/issues/11331
	it("ranks a tool first when the query contains its whole name", () => {
		const peekaboo = { name: "server__peekaboo", instructions: "Peekaboo controls macOS apps by app name." };
		const documents = [
			tool("server__peekaboo__see", "Capture the app window of the peekaboo app and describe the app."),
			tool("server__peekaboo__menu", "Click a menu item of an app."),
			tool(
				"server__peekaboo__app",
				"Launch, quit, relaunch, focus, hide, or switch applications. Targets an application by name, bundle identifier, or process ID, and can wait until it is ready.",
			),
			tool("server__app__queue_read", "Read a queued message of this thread."),
			tool(
				"server__dev-app__thread_read",
				"Read durable state and a paginated timeline from any thread. The default view returns user messages, assistant messages and plans.",
			),
		].map((entry) =>
			createToolSearchDocument(entry, entry.name.startsWith("server__peekaboo__") ? peekaboo : undefined),
		);
		const ranker = new Bm25Ranker();
		const first = (query: string) => ranker.rank(query, documents, 1).map((match) => match.name);
		expect(first("peekaboo app")).toEqual(["server__peekaboo__app"]);
		expect(first("open the peekaboo app tool")).toEqual(["server__peekaboo__app"]);
		expect(first("read thread_read state")).toEqual(["server__dev-app__thread_read"]);
		// Without the whole name, mentions in descriptions decide.
		expect(first("describe window")).toEqual(["server__peekaboo__see"]);
	});

	// https://github.com/earendil-works/pi/issues/11331
	it("ranks a tool matching more query terms first, whatever the scores", () => {
		const documents = [
			tool("server__peekaboo__app", "Launch, quit, focus, or switch applications by name or bundle identifier."),
			tool("server__peekaboo__see", "Capture the app window and describe the UI elements of the app."),
			tool("server__peekaboo__window", "Move, resize, or close a window of an app."),
			tool("server__peekaboo__image", "Take a screenshot of the screen, an app, or a window."),
		].map((entry) => createToolSearchDocument(entry));
		const ranker = new Bm25Ranker();
		const first = (query: string) => ranker.rank(query, documents, 1).map((match) => match.name);
		// `window` and `app` are whole names, but each covers one of the two terms.
		expect(first("screenshot window")).toEqual(["server__peekaboo__image"]);
		expect(first("describe app")).toEqual(["server__peekaboo__see"]);
		// An exact name still ranks first.
		expect(first("window")).toEqual(["server__peekaboo__window"]);
	});

	it("includes the namespace in the search text", () => {
		const document = createToolSearchDocument(tool("cluster__run", "Run it."), {
			name: "cluster",
			description: "Kubernetes cluster tools",
		});
		expect(new Bm25Ranker().rank("kubernetes", [document], 8)).toEqual([
			{ name: "cluster__run", score: expect.any(Number) },
		]);
	});
});
// #11803
describe("schema references in the search text", () => {
	function searchText(parameters: Record<string, unknown>): string {
		const entry = tool("ledger__inspect", "Inspect records");
		return createToolSearchDocument({ ...entry, parameters: Type.Unsafe(parameters) }).text;
	}

	it("reads names and descriptions behind local references", () => {
		const text = searchText({
			type: "object",
			properties: { options: { $ref: "#/$defs/options" } },
			$defs: {
				options: { type: "object", properties: { mode: { type: "string", description: "reconciliation" } } },
			},
		});
		expect(text).toBe("Inspect records options mode reconciliation");
	});

	it("follows escaped pointer segments", () => {
		const text = searchText({
			type: "object",
			properties: { range: { $ref: "#/$defs/date~1range" } },
			$defs: { "date/range": { description: "fiscal period" } },
		});
		expect(text).toBe("Inspect records range fiscal period");
	});

	it("reads recursive and shared definitions once", () => {
		const text = searchText({
			type: "object",
			properties: { root: { $ref: "#/$defs/node" }, other: { $ref: "#/$defs/node" }, self: { $ref: "#" } },
			$defs: {
				node: {
					description: "tree node",
					properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
				},
			},
		});
		expect(text).toBe("Inspect records root tree node children other self");
	});

	it("leaves out unreferenced definitions and remote or missing references", () => {
		const text = searchText({
			type: "object",
			properties: {
				remote: { $ref: "https://example.com/schema.json#/$defs/x" },
				missing: { $ref: "#/$defs/missing" },
				malformed: { $ref: "#/$defs/%E0%A4%A" },
			},
			$defs: { unused: { description: "reconciliation" } },
		});
		expect(text).toBe("Inspect records remote missing malformed");
	});
});
