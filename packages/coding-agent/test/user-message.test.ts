import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createMermaidMarkdownCodeBlockRendererFactory } from "../src/modes/interactive/components/mermaid.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("renders a Mermaid image across the user-message panel", () => {
		initTheme("dark");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			let showImages = true;
			const factory = createMermaidMarkdownCodeBlockRendererFactory({
				getMode: () => "final",
				getImageSettings: () => ({ showImages, imageWidthCells: 60 }),
				theme,
			});
			const component = new UserMessageComponent(
				"Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter",
				undefined,
				1,
				[],
				factory,
			);
			const lines = component.render(40);
			const imageLine = lines.find((line) => line.includes("\x1b_G"));

			expect(imageLine).toContain(",c=40,");
			expect(lines.some((line) => line.includes("```mermaid"))).toBe(false);
			expect(lines.some((line) => line.includes("After") && line.includes(theme.getBgAnsi("userMessageBg")))).toBe(
				true,
			);

			showImages = false;
			component.invalidate();
			const withoutImages = component.render(40);
			expect(withoutImages.some((line) => line.includes("\x1b_G"))).toBe(false);
			expect(stripAnsi(withoutImages.join("\n"))).toContain("───▶");
		} finally {
			resetCapabilitiesCache();
		}
	});
});
