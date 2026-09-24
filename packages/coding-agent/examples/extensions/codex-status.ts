import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const CODEX_PROVIDER = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const ENTRY_TYPE = "codex-status";
const ERROR_ENTRY_TYPE = "codex-status-error";

type JsonObject = Record<string, unknown>;

type UsageWindow = {
	usedPercent: number;
	leftPercent: number;
	windowSeconds?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
};

type UsageLimit = {
	name: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

type Credits = {
	hasCredits?: boolean;
	unlimited?: boolean;
	balance?: string;
};

type CodexReport = {
	email?: string;
	plan?: string;
	fetchedAt: number;
	defaultLimit?: UsageLimit;
	additionalLimits: UsageLimit[];
	credits?: Credits;
	resetCredits?: number;
};

type StoredStatus = {
	report: CodexReport;
};

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizeResetAt(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return value > 10_000_000_000 ? Math.round(value / 1000) : value;
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
	const object = asObject(value);
	if (!object) return undefined;

	const usedPercent = asNumber(object.used_percent) ?? asNumber(object.usedPercent);
	if (usedPercent === undefined) return undefined;

	const clampedUsed = Math.max(0, Math.min(100, usedPercent));
	const resetAt = normalizeResetAt(asNumber(object.reset_at) ?? asNumber(object.resetAt));
	const resetAfterSeconds =
		asNumber(object.reset_after_seconds) ??
		asNumber(object.resetAfterSeconds) ??
		(resetAt === undefined ? undefined : Math.max(0, Math.round(resetAt - Date.now() / 1000)));
	const windowSeconds =
		asNumber(object.limit_window_seconds) ??
		asNumber(object.windowSeconds) ??
		(asNumber(object.window_minutes) === undefined ? undefined : asNumber(object.window_minutes)! * 60);

	return {
		usedPercent: clampedUsed,
		leftPercent: Math.max(0, Math.min(100, 100 - clampedUsed)),
		...(windowSeconds === undefined ? {} : { windowSeconds }),
		...(resetAt === undefined ? {} : { resetAt }),
		...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
	};
}

function normalizeLimit(name: string, value: unknown): UsageLimit | undefined {
	const object = asObject(value);
	if (!object) return undefined;

	const primary = normalizeWindow(object.primary_window ?? object.primaryWindow);
	const secondary = normalizeWindow(object.secondary_window ?? object.secondaryWindow);
	const allowed = asBoolean(object.allowed);
	const limitReached = asBoolean(object.limit_reached) ?? asBoolean(object.limitReached);
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return undefined;

	return {
		name,
		...(allowed === undefined ? {} : { allowed }),
		...(limitReached === undefined ? {} : { limitReached }),
		...(primary === undefined ? {} : { primary }),
		...(secondary === undefined ? {} : { secondary }),
	};
}

function normalizeReport(payload: unknown): CodexReport {
	const api = asObject(payload);
	if (!api) throw new Error("Codex usage response was not a JSON object");

	const defaultLimit = normalizeLimit("Codex", api.rate_limit);
	const additionalLimits: UsageLimit[] = [];
	if (Array.isArray(api.additional_rate_limits)) {
		for (const item of api.additional_rate_limits) {
			const object = asObject(item);
			if (!object) continue;
			const name = asString(object.limit_name) ?? asString(object.metered_feature) ?? "Additional limit";
			const limit = normalizeLimit(name, object.rate_limit);
			if (limit) additionalLimits.push(limit);
		}
	}

	const creditObject = asObject(api.credits);
	const credits = creditObject
		? {
				...(asBoolean(creditObject.has_credits) === undefined
					? {}
					: { hasCredits: asBoolean(creditObject.has_credits) }),
				...(asBoolean(creditObject.unlimited) === undefined
					? {}
					: { unlimited: asBoolean(creditObject.unlimited) }),
				...(creditObject.balance === undefined ? {} : { balance: String(creditObject.balance) }),
			}
		: undefined;

	const resetCreditsObject = asObject(api.rate_limit_reset_credits);
	const resetCredits = resetCreditsObject ? asNumber(resetCreditsObject.available_count) : undefined;

	const codeReviewLimit = normalizeLimit("Code Review", api.code_review_rate_limit);
	if (codeReviewLimit) additionalLimits.push(codeReviewLimit);

	if (!defaultLimit && additionalLimits.length === 0 && !credits && resetCredits === undefined) {
		throw new Error("Codex usage response contained no rate-limit windows");
	}

	return {
		...(asString(api.email) === undefined ? {} : { email: asString(api.email) }),
		...(asString(api.plan_type) === undefined ? {} : { plan: asString(api.plan_type) }),
		fetchedAt: Date.now(),
		...(defaultLimit === undefined ? {} : { defaultLimit }),
		additionalLimits,
		...(credits === undefined ? {} : { credits }),
		...(resetCredits === undefined ? {} : { resetCredits }),
	};
}

function extractAccountId(token: string): string {
	const payloadPart = token.split(".")[1];
	if (!payloadPart) throw new Error("OpenAI Codex access token has no account information");

	try {
		const payload = asObject(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
		const authClaims = payload ? asObject(payload["https://api.openai.com/auth"]) : undefined;
		const accountId = authClaims ? asString(authClaims.chatgpt_account_id) : undefined;
		if (accountId) return accountId;
	} catch {
		// Report a stable authentication error below without exposing the token.
	}

	throw new Error("Could not read the ChatGPT account ID from OpenAI Codex auth");
}

async function buildHeaders(ctx: ExtensionContext): Promise<Record<string, string>> {
	const resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
	const token = resolved?.auth.apiKey;
	if (!token) {
		throw new Error("OpenAI Codex auth is not configured; run /login first");
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
		if (value !== null) headers[name] = value;
	}

	headers.authorization = `Bearer ${token}`;
	headers["chatgpt-account-id"] = extractAccountId(token);
	headers.accept = "application/json";
	headers["user-agent"] = "pi-codex-status-local";
	return headers;
}

function errorDetail(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "request failed";
	try {
		const object = asObject(JSON.parse(trimmed));
		const error = object ? asObject(object.error) : undefined;
		const message = error ? (asString(error.message) ?? asString(error.code)) : undefined;
		if (message) return message;
	} catch {
		// Non-JSON responses are summarized below.
	}
	return trimmed.startsWith("<") ? "server returned HTML instead of JSON" : trimmed.slice(0, 240);
}

async function fetchUsage(ctx: ExtensionContext): Promise<CodexReport> {
	const response = await fetch(CODEX_USAGE_URL, {
		headers: await buildHeaders(ctx),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`usage request failed (${response.status}): ${errorDetail(body)}`);
	}

	try {
		return normalizeReport(JSON.parse(body) as unknown);
	} catch (error) {
		throw new Error(`invalid Codex usage response: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function formatDuration(seconds: number | undefined): string | undefined {
	if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
	const remaining = Math.max(0, Math.round(seconds));
	if (remaining < 60) return `${remaining}s`;
	const minutes = Math.floor(remaining / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

function formatWindowName(window: UsageWindow, fallback: string): string {
	if (window.windowSeconds === 18_000) return "5h";
	if (window.windowSeconds === 604_800) return "7d";
	return fallback;
}

function formatWindow(window: UsageWindow, fallback: string, blocked: boolean): string {
	if (blocked) return `${formatWindowName(window, fallback)}: BLOCKED by server`;
	const width = 20;
	const filled = Math.round((window.leftPercent / 100) * width);
	const bar = `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
	const reset = formatDuration(window.resetAfterSeconds);
	return `${formatWindowName(window, fallback)}: ${bar} ${Math.round(window.leftPercent)}% left${reset ? ` (resets in ${reset})` : ""}`;
}

function appendLimit(lines: string[], limit: UsageLimit, indent = ""): void {
	const blocked = limit.allowed === false || limit.limitReached === true;
	if (limit.primary) lines.push(`${indent}${formatWindow(limit.primary, "Primary", blocked)}`);
	if (limit.secondary) lines.push(`${indent}${formatWindow(limit.secondary, "Secondary", blocked)}`);
	if (!limit.primary && !limit.secondary) {
		lines.push(`${indent}${limit.name}: ${blocked ? "BLOCKED by server" : "No usage window reported"}`);
	}
}

function formatReport(report: CodexReport): string {
	const lines = ["Codex usage"];
	if (report.email || report.plan) {
		const account = report.email && report.plan ? `${report.email} (${report.plan})` : (report.email ?? report.plan);
		if (account) lines.push(`Account: ${account}`);
	}
	lines.push(`Updated: ${new Date(report.fetchedAt).toLocaleString()}`);

	if (report.defaultLimit) {
		appendLimit(lines, report.defaultLimit);
	} else {
		lines.push("Limits: not available");
	}
	for (const limit of report.additionalLimits) {
		lines.push(`${limit.name}:`);
		appendLimit(lines, limit, "  ");
	}

	if (report.credits) {
		const balance = report.credits.unlimited ? "unlimited" : (report.credits.balance ?? "0");
		const hasBalance = report.credits.balance !== undefined && report.credits.balance !== "0";
		lines.push(`Credits: ${report.credits.unlimited || report.credits.hasCredits || hasBalance ? balance : "none"}`);
	}
	if (report.resetCredits !== undefined) lines.push(`Reset credits available: ${report.resetCredits}`);
	return lines.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function codexStatusExtension(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<StoredStatus>(ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		return new Text(theme.fg("accent", formatReport(entry.data.report)), 0, 0);
	});

	pi.registerEntryRenderer<{ message: string }>(ERROR_ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		return new Text(theme.fg("error", entry.data.message), 0, 0);
	});

	const showReport = (ctx: ExtensionContext, report: CodexReport): void => {
		if (ctx.mode === "print") {
			console.log(formatReport(report));
			return;
		}
		if (ctx.mode === "rpc") {
			ctx.ui.notify(formatReport(report), "info");
			return;
		}
		pi.appendEntry(ENTRY_TYPE, { report });
	};

	const showError = (ctx: ExtensionContext, error: unknown): void => {
		const message = errorMessage(error);
		if (ctx.mode === "json") {
			pi.appendEntry(ERROR_ENTRY_TYPE, { message });
			return;
		}
		if (ctx.mode === "print") {
			console.error(message);
			return;
		}
		ctx.ui.notify(message, "error");
	};

	pi.registerCommand("status", {
		description: "Show ChatGPT Codex usage limits",
		handler: async (args, ctx) => {
			if (args.trim()) {
				showError(ctx, new Error("Usage: /status"));
				return;
			}
			try {
				showReport(ctx, await fetchUsage(ctx));
			} catch (error) {
				showError(ctx, error);
			}
		},
	});
}
