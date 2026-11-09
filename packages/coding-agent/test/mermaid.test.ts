import { createRequire } from "node:module";
import {
	getCellDimensions,
	type MarkdownCodeBlockRenderer,
	Marked,
	parseColor,
	resetCapabilitiesCache,
	setCapabilities,
	type Tokens,
} from "@earendil-works/pi-tui";
import type * as grokMermaid from "grok-mermaid";
import type * as pele from "pele";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidMarkdownCodeBlockRendererFactory } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { loadPhoton } from "../src/utils/photon.ts";

const require = createRequire(import.meta.url);
const resvgEntry = require.resolve("@resvg/resvg-js");
const { peleRender, unicodeRender } = vi.hoisted(() => ({ peleRender: vi.fn(), unicodeRender: vi.fn() }));
vi.mock("pele", async (importOriginal) => {
	const original = await importOriginal<typeof pele>();
	return {
		...original,
		render: (...args: Parameters<typeof pele.render>) => {
			peleRender();
			return original.render(...args);
		},
	};
});
vi.mock("grok-mermaid", async (importOriginal) => {
	const original = await importOriginal<typeof grokMermaid>();
	return {
		...original,
		render: (...args: Parameters<typeof grokMermaid.render>) => {
			unicodeRender();
			return original.render(...args);
		},
	};
});

const theme = {
	appearance: "dark",
	colors: {
		text: parseColor("#dedede"),
		muted: parseColor("#888888"),
		borderMuted: parseColor("#666666"),
		accent: parseColor("#55aaff"),
		error: parseColor("#ff5555"),
		userMessageBg: parseColor("#112233"),
	},
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;
const defaultImageSettings = { showImages: true, imageWidthCells: 60 };

function renderer(mode: MermaidRenderingMode, isStreaming = false): MarkdownCodeBlockRenderer {
	return createMermaidMarkdownCodeBlockRendererFactory({
		getMode: () => mode,
		getImageSettings: () => defaultImageSettings,
		theme,
	})(isStreaming);
}

function mermaidToken(text: string, lang = "mermaid") {
	return { type: "code" as const, raw: `\`\`\`${lang}\n${text}\n\`\`\``, lang, text };
}

afterEach(() => {
	resetCapabilitiesCache();
	vi.clearAllMocks();
});

describe("Mermaid rendering", () => {
	it("does not load the native renderer when disabled or showing a text preview", () => {
		expect(require.cache[resvgEntry]).toBeUndefined();

		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const partial = { ...mermaidToken("flowchart LR\n  A --> B"), raw: "```mermaid\nflowchart LR\n  A --> B" };
		expect(renderer("streaming", true)(partial, 80)?.type).toBe("rendered");
		expect(peleRender).not.toHaveBeenCalled();
		expect(require.cache[resvgEntry]).toBeUndefined();

		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		expect(renderer("off")(mermaidToken("flowchart LR\n  A --> B"), 80)).toBeUndefined();
		expect(require.cache[resvgEntry]).toBeUndefined();
	});

	it("renders Pele SVG output as a PNG Kitty image", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const result = renderer("final")(mermaidToken("flowchart LR\n  A[Start] --> B[Done]"), 80);

		expect(require.cache[resvgEntry]).toBeDefined();
		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;
		const imageLine = result.lines.find((line) => line.startsWith("\x1b_G"));
		expect(imageLine).toBeDefined();
		const payload = Array.from(
			imageLine?.matchAll(/\x1b_G[^;]*;([\s\S]*?)\x1b\\/g) ?? [],
			(match) => match[1] ?? "",
		).join("");
		expect(payload).toBeDefined();
		expect(Buffer.from(payload ?? "", "base64").subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	});

	it("fills the entire user-message row and insets the diagram within it", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const factory = createMermaidMarkdownCodeBlockRendererFactory({
			getMode: () => "final",
			getImageSettings: () => defaultImageSettings,
			theme,
		});
		const result = factory(false, { paddingX: 1 })(mermaidToken("flowchart LR\n  A --> B"), 38);
		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;

		const imageLine = result.lines.find((line) => line.startsWith("\x1b_G")) ?? "";
		expect(imageLine).toContain(",c=40,");
		const payload = Array.from(imageLine.matchAll(/\x1b_G[^;]*;([\s\S]*?)\x1b\\/g), (match) => match[1] ?? "").join(
			"",
		);
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		if (!photon) return;
		const image = photon.PhotonImage.new_from_byteslice(Buffer.from(payload, "base64"));
		try {
			expect(image.get_width()).toBe(40 * getCellDimensions().widthPx);
			const pixels = image.get_raw_pixels();
			expect(Array.from(pixels.subarray(0, 4))).toEqual([0x11, 0x22, 0x33, 0xff]);
			const rightEdge = (image.get_width() - 1) * 4;
			expect(Array.from(pixels.subarray(rightEdge, rightEdge + 4))).toEqual([0x11, 0x22, 0x33, 0xff]);
			const insetPixels = getCellDimensions().widthPx;
			for (let row = 0; row < image.get_height(); row++) {
				const leftEdge = (row * image.get_width() + insetPixels - 1) * 4;
				expect(Array.from(pixels.subarray(leftEdge, leftEdge + 4))).toEqual([0x11, 0x22, 0x33, 0xff]);
			}
			expect(
				Array.from({ length: pixels.length / 4 }, (_, index) => index).some((index) => {
					const column = index % image.get_width();
					if (column < insetPixels || column >= image.get_width() - insetPixels) return false;
					const offset = index * 4;
					return pixels[offset] !== 0x11 || pixels[offset + 1] !== 0x22 || pixels[offset + 2] !== 0x33;
				}),
			).toBe(true);
		} finally {
			image.free();
		}
	});

	it("reserves the full user-message width in iTerm2 as well", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const factory = createMermaidMarkdownCodeBlockRendererFactory({
			getMode: () => "final",
			getImageSettings: () => defaultImageSettings,
			theme,
		});
		const result = factory(false, { paddingX: 1 })(mermaidToken("flowchart LR\n  A --> B"), 38);

		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;
		expect(result.lines.at(-1)).toContain("width=40;");
		expect(result.lines.at(-1)).toContain("\x1b]1337;File=");
	});

	it("keeps tall diagrams at readable width instead of capping their display height", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const steps = Array.from({ length: 30 }, (_, index) => `  Alice->>Bob: Step ${index + 1}`).join("\n");

		const result = renderer("final")(mermaidToken(`sequenceDiagram\n${steps}`), 80);

		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;
		const defaultHeightCap = Math.ceil((60 * getCellDimensions().widthPx) / getCellDimensions().heightPx);
		expect(result.lines.length).toBeGreaterThan(defaultHeightCap);
		expect(result.lines[0]).toContain(`,c=60,r=${result.lines.length}`);
	});

	it("reuses completed raster data and keeps streaming previews in Unicode", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const colors = { ...theme.colors };
		const factory = createMermaidMarkdownCodeBlockRendererFactory({
			getMode: () => "streaming",
			getImageSettings: () => defaultImageSettings,
			theme: { ...theme, colors } as Theme,
		});
		const token = new Marked().lexer("```mermaid\nflowchart LR\n  A --> B\n```\nFollowing text")[0];
		if (token?.type !== "code" || !("text" in token) || typeof token.text !== "string") {
			throw new Error("Expected a code token");
		}
		const codeToken = token as Tokens.Code;

		const first = factory(true)(codeToken, 80);
		const second = factory(false)(codeToken, 80);

		expect(peleRender).toHaveBeenCalledTimes(1);
		expect(first?.type).toBe("rendered");
		expect(second?.type).toBe("rendered");
		if (first?.type !== "rendered" || second?.type !== "rendered") return;
		const firstId = first.lines.join("").match(/\bi=(\d+)/)?.[1];
		const secondId = second.lines.join("").match(/\bi=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect(secondId).toBeDefined();
		expect(secondId).not.toBe(firstId);

		factory(false)(codeToken, 30);
		expect(peleRender).toHaveBeenCalledTimes(2);

		colors.accent = parseColor("#ff8800");
		factory(false)(codeToken, 80);
		expect(peleRender).toHaveBeenCalledTimes(3);

		const nextToken = mermaidToken("flowchart LR\n  A --> C");
		const partial = { ...nextToken, raw: nextToken.raw.slice(0, -4) };
		const preview = factory(true)(partial, 80);
		expect(preview?.type).toBe("rendered");
		if (preview?.type !== "rendered") return;
		expect(preview.lines.join("\n")).toContain("───▶");
		factory(true)(partial, 80);
		expect(peleRender).toHaveBeenCalledTimes(3);
		expect(unicodeRender).toHaveBeenCalledTimes(2);
		factory(false)(codeToken, 80);
		expect(peleRender).toHaveBeenCalledTimes(3);
	});

	it("uses Unicode diagrams when inline images are unavailable", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });

		const result = renderer("final")(mermaidToken("flowchart LR\n  A --> B"), 80);

		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;
		expect(result.lines.join("\n")).toContain("───▶");
	});

	it("uses image settings for visibility and preferred width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let imageSettings = { showImages: true, imageWidthCells: 20 };
		const factory = createMermaidMarkdownCodeBlockRendererFactory({
			getMode: () => "final",
			getImageSettings: () => imageSettings,
			theme,
		});
		const token = mermaidToken("flowchart LR\n  A --> B");

		const narrow = factory(false)(token, 80);
		expect(narrow?.type).toBe("rendered");
		if (narrow?.type !== "rendered") return;
		expect(narrow.lines[0]).toContain(",c=20,");

		imageSettings = { showImages: false, imageWidthCells: 20 };
		const hidden = factory(false)(token, 80);
		expect(hidden?.type).toBe("rendered");
		if (hidden?.type !== "rendered") return;
		expect(hidden.lines.join("\n")).toContain("───▶");
		expect(hidden.lines.join("\n")).not.toContain("\x1b_G");

		imageSettings = { showImages: true, imageWidthCells: 60 };
		const wide = factory(false)(token, 80);
		expect(wide?.type).toBe("rendered");
		if (wide?.type !== "rendered") return;
		expect(wide.lines[0]).toContain(",c=60,");
	});

	it("keeps labels readable on light-filled shapes in a dark theme", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const result = renderer("final")(
			mermaidToken("flowchart LR\n  A[Readable]:::light\n  classDef light fill:#ffffff,stroke:#dddddd"),
			80,
		);
		expect(result?.type).toBe("rendered");
		if (result?.type !== "rendered") return;

		const imageLine = result.lines.find((line) => line.startsWith("\x1b_G")) ?? "";
		const payload = Array.from(imageLine.matchAll(/\x1b_G[^;]*;([\s\S]*?)\x1b\\/g), (match) => match[1] ?? "").join(
			"",
		);
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		if (!photon) return;
		const image = photon.PhotonImage.new_from_byteslice(Buffer.from(payload, "base64"));
		try {
			const pixels = image.get_raw_pixels();
			let hasDarkText = false;
			for (let offset = 0; offset < pixels.length; offset += 4) {
				if (pixels[offset] === 0x1f && pixels[offset + 1] === 0x1f && pixels[offset + 2] === 0x1f) {
					hasDarkText = true;
					break;
				}
			}
			expect(hasDarkText).toBe(true);
		} finally {
			image.free();
		}
	});

	it("reuses completed Unicode diagrams across rebuilds and widths, but not partial fences", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const factory = createMermaidMarkdownCodeBlockRendererFactory({
			getMode: () => "streaming",
			getImageSettings: () => defaultImageSettings,
			theme,
		});
		const token = new Marked().lexer("```mermaid\nflowchart LR\n  A --> B\n```")[0];
		if (token?.type !== "code" || !("text" in token) || typeof token.text !== "string") {
			throw new Error("Expected a code token");
		}
		const codeToken = token as Tokens.Code;

		factory(true)(codeToken, 80);
		factory(false)(codeToken, 50);
		expect(unicodeRender).toHaveBeenCalledTimes(1);

		const partial = { ...codeToken, text: "flowchart LR\n  A --> C", raw: "```mermaid\nflowchart LR\n  A --> C" };
		factory(true)(partial, 80);
		factory(true)(partial, 80);
		expect(unicodeRender).toHaveBeenCalledTimes(3);
	});

	it("respects off, final, and streaming modes", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const token = mermaidToken("flowchart LR\n  A --> B");

		expect(renderer("off")(token, 80)).toBeUndefined();
		expect(renderer("final", true)(token, 80)).toBeUndefined();
		expect(renderer("streaming", true)(token, 80)?.type).toBe("rendered");
		expect(renderer("final", false)(token, 80)?.type).toBe("rendered");
	});

	it("leaves non-Mermaid code blocks unchanged", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		expect(renderer("final")(mermaidToken("flowchart LR\n  A --> B", "typescript"), 80)).toBeUndefined();
	});

	it("falls back to the source with a warning for invalid final diagrams", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const result = renderer("final")(mermaidToken("flowchart LR\n  A[Foo] invalid"), 80);

		expect(result?.type).toBe("fallback");
		if (result?.type !== "fallback") return;
		expect(result.warning).toContain("Mermaid diagram not rendered");
	});

	it("does not show parse warnings for incomplete streaming diagrams", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const result = renderer("streaming", true)(mermaidToken("flowchart LR\n  A[Foo] invalid"), 80);

		expect(result).toEqual({ type: "fallback" });
	});
});
