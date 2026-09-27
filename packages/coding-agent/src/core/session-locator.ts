import { basename } from "node:path";
import { resolvePath } from "../utils/paths.ts";

const SESSION_LOCATOR_PREFIX = "pi-session://";
const SESSION_DATABASE_FILENAME = "sessions.db";

export interface SessionLocator {
	databasePath: string;
	sessionId: string;
	cwd?: string;
}

export function createSessionLocator(databasePath: string, sessionId: string, cwd: string): string {
	const encodedDatabasePath = Buffer.from(resolvePath(databasePath)).toString("base64url");
	const encodedCwd = Buffer.from(cwd ? resolvePath(cwd) : "").toString("base64url");
	const encodedSessionId = Buffer.from(sessionId).toString("base64url");
	return `${SESSION_LOCATOR_PREFIX}${encodedDatabasePath}/${encodedCwd}/${encodedSessionId}`;
}

export function parseSessionLocator(value: string): SessionLocator | undefined {
	if (!value.startsWith(SESSION_LOCATOR_PREFIX)) return undefined;
	const parts = value.slice(SESSION_LOCATOR_PREFIX.length).split("/");
	if (parts.length !== 2 && parts.length !== 3) {
		throw new Error(`Invalid session locator: ${value}`);
	}
	const encodedDatabasePath = parts[0];
	const legacyLocator = parts.length === 2;
	const encodedCwd = legacyLocator ? undefined : parts[1];
	const encodedSessionId = legacyLocator ? parts[1] : parts[2];
	const decode = (encoded: string | undefined): string | undefined => {
		if (encoded === undefined) return undefined;
		if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error(`Invalid session locator: ${value}`);
		const decoded = Buffer.from(encoded, "base64url").toString("utf8");
		if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
			throw new Error(`Invalid session locator: ${value}`);
		}
		return decoded;
	};
	const databasePath = decode(encodedDatabasePath);
	const sessionId = decode(encodedSessionId);
	const decodedCwd = decode(encodedCwd);
	if (!databasePath || !sessionId) throw new Error(`Invalid session locator: ${value}`);
	const cwd = decodedCwd === undefined ? undefined : decodedCwd ? resolvePath(decodedCwd) : "";
	const resolvedDatabasePath = resolvePath(databasePath);
	if (basename(resolvedDatabasePath) !== SESSION_DATABASE_FILENAME) {
		throw new Error(`Invalid session locator database path: ${value}`);
	}
	return { databasePath: resolvedDatabasePath, sessionId, cwd };
}

export function isSessionLocatorPath(value: string): boolean {
	return parseSessionLocator(value) !== undefined;
}

export function getSessionDatabasePathFromLocator(value: string): string | undefined {
	return parseSessionLocator(value)?.databasePath;
}
