import { posix } from "node:path";
import { type ParsedCommandInput, valueOption } from "./command.ts";

interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

export type TransportAddress = UnixTransportAddress;

function parseTransportAddress(value: string): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (url.protocol !== "unix:") return { error: `Unsupported --connect transport "${url.protocol}"` };
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid --connect address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid --connect address "${value}"` };
	}
	if (path.includes("\0")) return { error: `Invalid --connect address "${value}"` };
	if (!posix.isAbsolute(path)) return { error: "Unix transport address requires an absolute path" };
	return { address: { transport: "unix", path } };
}

export const connectOption = valueOption("--connect", (value) => {
	const result = parseTransportAddress(value);
	return result.address
		? { ok: true, value: result.address }
		: { ok: false, error: result.error ?? `Invalid --connect address "${value}"` };
});

export function unsupportedOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
