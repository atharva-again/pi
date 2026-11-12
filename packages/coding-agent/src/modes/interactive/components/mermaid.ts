import { createRequire } from "node:module";
import {
	colorToHex,
	getCapabilities,
	getCellDimensions,
	Image,
	type MarkdownCodeBlockRenderer,
	Marked,
	type Token,
} from "@earendil-works/pi-tui";
import type { Resvg as ResvgConstructor } from "@resvg/resvg-js";
import { type AnsiTheme, type MermaidArt, render as renderUnicode, toAnsi } from "lovely-mermaid";
import { render as renderPele } from "pele";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";

const require = createRequire(import.meta.url);
const markdownParser = new Marked();

const MAX_RASTER_DIMENSION = 4096;
const MAX_RASTER_PIXELS = 12_000_000;
const MAX_CACHED_PNG_CHARS = 8_000_000;
const MAX_CACHED_DIAGRAMS = 32;
const MAX_CACHED_UNICODE_CELLS = 20_000;
const MAX_CACHED_UNICODE_DIAGRAMS = 16;
type MermaidTheme = Pick<Theme, "fg" | "getFgAnsi">;

interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: MermaidTheme;
}

interface MermaidRendererOptions {
	getMode: () => MermaidRenderingMode;
	getImageSettings: () => { showImages: boolean; imageWidthCells: number };
	theme: Theme;
}

export type MermaidMarkdownCodeBlockRendererFactory = (
	isStreaming: boolean,
	panel?: { paddingX: number },
) => MarkdownCodeBlockRenderer;

function themeSvg(svg: string, theme: Theme): string {
	const dark = theme.appearance === "dark";
	const background = dark ? "#1c1b1a" : "#ffffff";
	const foreground = colorToHex(theme.colors.text);
	const muted = colorToHex(theme.colors.muted);
	const border = colorToHex(theme.colors.borderMuted);
	const accent = colorToHex(theme.colors.accent);
	const error = colorToHex(theme.colors.error);
	const surface = dark ? "#282726" : "#f3f3f3";
	const surfaceAlt = dark ? "#343331" : "#e6e6e6";
	const themeVariables: Record<string, string> = {
		"--pele-bg": background,
		"--pele-fg": foreground,
		"--pele-fg-on-light": "#1f1f1f",
		"--pele-fg-on-dark": "#ffffff",
		"--pele-muted": muted,
		"--pele-line": border,
		"--pele-surface": surface,
		"--pele-surface-alt": surfaceAlt,
		"--pele-border": border,
		"--pele-accent": accent,
		"--pele-critical": error,
		"--pele-error": error,
		"--pele-radius": "4px",
		"--pele-font": "sans-serif",
		"--pele-font-mono": "monospace",
	};
	// Pele defines its own shorthand variables on the root SVG. Read those
	// definitions rather than maintaining a second map of Pele's private names.
	const rootStyle = /<svg\b[^>]*\bstyle="([^"]*)"/.exec(svg)?.[1];
	if (!rootStyle) throw new Error("Pele SVG has no root style");
	const definitions = new Map(
		Array.from(rootStyle.matchAll(/(?:^|;)\s*(--[\w-]+):([^;]*)/g), ([, name, value]) => [name, value.trim()]),
	);
	const variablePattern = /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g;
	const resolveVariable = (name: string, fallback?: string, seen = new Set<string>()): string => {
		if (seen.has(name)) throw new Error(`Circular Pele SVG variable: ${name}`);
		const value = themeVariables[name] ?? definitions.get(name) ?? fallback?.trim();
		if (value === undefined) throw new Error(`Unresolved Pele SVG variable: ${name}`);
		seen.add(name);
		const resolved = value.replace(variablePattern, (_match, nested: string, defaultValue?: string) =>
			resolveVariable(nested, defaultValue, seen),
		);
		seen.delete(name);
		return resolved;
	};
	return svg.replace(/<[^>]+>/g, (tag) => {
		const resolved = tag.replace(variablePattern, (_match, name: string, fallback?: string) =>
			resolveVariable(name, fallback),
		);
		if (resolved.includes("var(")) throw new Error("Unresolved Pele SVG variable");
		return resolved;
	});
}

function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function themedLines(art: MermaidArt, theme: MermaidTheme): string[] {
	const foreground = (color: ThemeColor) => theme.getFgAnsi(color).slice(2, -1);
	const ansiTheme: AnsiTheme = {
		border: foreground("borderMuted"),
		text: foreground("text"),
		edge: foreground("accent"),
		edgeLabel: foreground("text"),
		title: `1;${foreground("accent")}`,
	};
	const linkLabels = getCapabilities().hyperlinks;
	const displayArt: MermaidArt = {
		...art,
		// Only osc 8 the text, not the whole box.
		styled: art.styled.map((row) =>
			row.map((span) => {
				if (span.href === undefined || (linkLabels && span.role === "text")) return span;
				const unlinked = { ...span };
				delete unlinked.href;
				return unlinked;
			}),
		),
	};
	return toAnsi(displayArt, ansiTheme);
}

function unicodeFallback(art: MermaidArt | null, width: number, theme: Theme, isStreaming: boolean) {
	if (!art || art.width > width) return undefined;
	if (!isStreaming && art.warnings.length > 0) {
		const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
		const warning = theme.fg("warning", `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`);
		return { type: "fallback" as const, warning };
	}
	return { type: "rendered" as const, lines: themedLines(art, theme) };
}

/** Create a transformer for Unicode Mermaid diagrams in model-written summaries. */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	return (markdown, context) => {
		const mode = options.getMode();
		// User and assistant messages use the code-block renderer, which can display raster images.
		if (mode === "off" || context.messageType !== "summary" || (context.isStreaming && mode !== "streaming")) {
			return markdown;
		}

		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = renderUnicode(token.text);
				if (!art || art.width > context.availableWidth) return token.raw;
				if (!context.isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	};
}

function renderPng(svg: string, width: number, height: number, maxWidthPixels: number): Buffer {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error("Pele returned invalid diagram dimensions");
	}

	const maxDimensionScale = MAX_RASTER_DIMENSION / Math.max(width, height);
	const maxPixelScale = Math.sqrt(MAX_RASTER_PIXELS / (width * height));
	const scale = Math.min(maxWidthPixels / width, maxDimensionScale, maxPixelScale);
	const outputWidth = Math.max(1, Math.floor(width * scale));
	const { Resvg } = require("@resvg/resvg-js") as { Resvg: typeof ResvgConstructor };
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: outputWidth },
	});
	return resvg.render().asPng();
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0] ?? "invalid diagram";
	return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

export function createMermaidMarkdownCodeBlockRendererFactory(
	options: MermaidRendererOptions,
): MermaidMarkdownCodeBlockRendererFactory {
	// Assistant streaming rebuilds Markdown components on every update. Keep only the raster
	// data across rebuilds; each placement still gets its own Kitty image ID.
	const pngCache = new Map<string, string>();
	const unicodeCache = new Map<string, MermaidArt | null>();
	let cachedChars = 0;

	return (isStreaming, panel) => (token, availableWidth) => {
		if (token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() !== "mermaid") return undefined;

		const mode = options.getMode();
		if (mode === "off" || (isStreaming && mode !== "streaming")) return undefined;
		if (panel && availableWidth <= 1) return undefined;
		const { showImages, imageWidthCells: preferredImageWidthCells } = options.getImageSettings();

		// A partial fence changes on every streamed token; caching it would displace
		// completed diagrams that remain visible throughout the same message.
		const complete = !isStreaming || /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*\n?$/.test(token.raw);
		if (!showImages || !getCapabilities().images || !complete) {
			const cachedArt = complete ? unicodeCache.get(token.text) : undefined;
			const art = cachedArt === undefined ? renderUnicode(token.text) : cachedArt;
			if (cachedArt !== undefined) {
				unicodeCache.delete(token.text);
				unicodeCache.set(token.text, art);
			} else if (
				complete &&
				token.text.length <= MAX_CACHED_UNICODE_CELLS &&
				(!art || art.plain.reduce((length, row) => length + row.length, 0) <= MAX_CACHED_UNICODE_CELLS)
			) {
				if (unicodeCache.size >= MAX_CACHED_UNICODE_DIAGRAMS) {
					const oldest = unicodeCache.keys().next().value;
					if (oldest !== undefined) unicodeCache.delete(oldest);
				}
				unicodeCache.set(token.text, art);
			}
			return unicodeFallback(art, availableWidth, options.theme, isStreaming);
		}

		try {
			const imageWidthCells = Math.max(1, Math.min(availableWidth - 2, preferredImageWidthCells));
			const cellWidthPixels = getCellDimensions().widthPx;
			const maxWidthPixels = Math.max(1, imageWidthCells * cellWidthPixels);
			const panelWidthCells = panel ? availableWidth + 2 * panel.paddingX : undefined;
			const panelBackground = panel ? colorToHex(options.theme.colors.userMessageBg) : undefined;
			const colors = options.theme.colors;
			const key = JSON.stringify([
				token.text,
				maxWidthPixels,
				panelWidthCells,
				panelBackground,
				options.theme.appearance,
				colorToHex(colors.text),
				colorToHex(colors.muted),
				colorToHex(colors.borderMuted),
				colorToHex(colors.accent),
				colorToHex(colors.error),
			]);
			let png = pngCache.get(key);
			if (png !== undefined) {
				pngCache.delete(key);
				pngCache.set(key, png);
			} else {
				const diagram = renderPele(token.text, {
					maxWidth: maxWidthPixels,
					links: false,
					images: false,
					limit: 50_000,
					outputLimit: 4_000_000,
					maxEdges: 5_000,
					idPrefix: "pi-mermaid",
				});
				let svg = themeSvg(diagram.svg, options.theme);
				let { width, height } = diagram;
				let outputWidth = maxWidthPixels;
				if (panel && panelWidthCells !== undefined && panelBackground) {
					if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
						throw new Error("Pele returned invalid diagram dimensions");
					}
					const scale = maxWidthPixels / width;
					width = panelWidthCells * cellWidthPixels;
					height = Math.ceil(height * scale);
					outputWidth = width;
					// Image lines bypass Markdown's text background and margins. Make the
					// complete user-message row opaque, with the diagram inset like its text.
					svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${panelBackground}"/><g transform="translate(${panel.paddingX * cellWidthPixels},0) scale(${scale})">${svg}</g></svg>`;
				}
				png = renderPng(svg, width, height, outputWidth).toString("base64");
				if (png.length <= MAX_CACHED_PNG_CHARS) {
					while (cachedChars + png.length > MAX_CACHED_PNG_CHARS || pngCache.size >= MAX_CACHED_DIAGRAMS) {
						const oldest = pngCache.keys().next().value;
						if (oldest === undefined) break;
						cachedChars -= pngCache.get(oldest)?.length ?? 0;
						pngCache.delete(oldest);
					}
					pngCache.set(key, png);
					cachedChars += png.length;
				}
			}

			const image = new Image(
				png,
				"image/png",
				{ fallbackColor: (text) => options.theme.fg("warning", text) },
				{ maxWidthCells: panelWidthCells ?? imageWidthCells, maxHeightCells: null },
			);
			return {
				type: "rendered",
				lines: image.render(panelWidthCells === undefined ? availableWidth : panelWidthCells + 2),
			};
		} catch (error) {
			if (isStreaming) {
				return { type: "fallback" };
			}
			return {
				type: "fallback",
				warning: options.theme.fg("warning", `Mermaid diagram not rendered: ${errorMessage(error)}`),
			};
		}
	};
}
