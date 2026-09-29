import type { Entry } from "./harness/types.ts";
import type { EntryRecord } from "./types.ts";

/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<E extends EntryRecord>(kind: string): Entry<E> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is E => entry !== undefined && entry.kind === kind,
	};
}
