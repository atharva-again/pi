/**
 * Built-in tool renderers, without the tools themselves.
 *
 * A presentation displays tool calls and results; it does not execute them and does not need their
 * typebox parameter schemas. Importing this instead of `core/tools/index.ts` keeps ~17 MB of module
 * graph out of a process that only renders.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { ToolName } from "../index.ts";
import { getTextOutput, str } from "../render-utils.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type ToolRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

function createSessionToolRenderers(name: "search_sessions" | "read_session_context"): ToolRenderers {
	return {
		renderCall(args, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = theme.fg("toolTitle", theme.bold(name));
			const parameters = args as Record<string, unknown>;
			const detail =
				name === "search_sessions"
					? str(parameters.query)
					: [str(parameters.session_id), str(parameters.entry_id)]
							.filter((value) => value && value !== "")
							.join("#");
			text.setText(detail ? `${title} ${theme.fg("accent", detail)}` : title);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lines = getTextOutput(result, context.showImages).trim().split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const remaining = Math.max(0, lines.length - maxLines);
			const output = lines
				.slice(0, maxLines)
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			text.setText(
				output ? `\n${output}${remaining ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""}` : "",
			);
			return text;
		},
	};
}

export {
	createShellRenderers,
	editRenderers,
	findRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

/** Renderers for every built-in tool, keyed by tool name. */
export function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		powershell: createShellRenderers("PS>"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		find: findRenderers,
		ls: lsRenderers,
		search_sessions: createSessionToolRenderers("search_sessions"),
		read_session_context: createSessionToolRenderers("read_session_context"),
	};
}

/**
 * Merge built-in renderers into a tool definition that does not supply its own.
 *
 * `ToolExecutionComponent` used to do this lookup itself, which forced every presentation to import
 * the tool implementations. Callers do it now, so a process that renders can import renderers alone.
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
