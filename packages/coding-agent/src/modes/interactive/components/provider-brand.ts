/**
 * Animated brand styles for the names of preferred providers in selectors. Selectors apply them to the selected row only.
 */

import { foregroundAnsi, mixColors, parseColor, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Colors `text` for animation time `elapsedMs`. */
export type ProviderBrandStyle = (text: string, elapsedMs: number) => string;

/** The animated style of a provider's name, or `undefined` when the provider has none. */
export function getProviderBrandStyle(providerId: string): ProviderBrandStyle | undefined {
	if (providerId === "openrouter") return openRouterGlow;
	return undefined;
}

/**
 * OpenRouter's brand colors per theme appearance: lime on dark backgrounds, violet on light ones, where lime would
 * be unreadable. The glow breathes between `base` and the brighter `peak`.
 */
const OPENROUTER_GLOW = {
	dark: { base: parseColor("#c6f243"), peak: parseColor("#efffb0") },
	light: { base: parseColor("#5d32e1"), peak: parseColor("#8f6bff") },
} as const;
const GLOW_PERIOD_MS = 2400;

/** Colors `text` in OpenRouter's brand color, slowly brightening and dimming. */
function openRouterGlow(text: string, elapsedMs: number): string {
	const { base, peak } = OPENROUTER_GLOW[theme.appearance];
	const amount = (1 - Math.cos((2 * Math.PI * elapsedMs) / GLOW_PERIOD_MS)) / 2;
	return `${foregroundAnsi(mixColors(base, peak, amount, "oklch"), theme.getColorMode())}${text}\x1b[39m`;
}

const ANIMATION_FRAME_MS = 50;

/** Re-renders `tui` every animation frame while `isAnimating()` holds; returns the function that stops it. */
export function startBrandAnimation(tui: TUI, isAnimating: () => boolean): () => void {
	const timer = setInterval(() => {
		if (isAnimating()) tui.requestRender();
	}, ANIMATION_FRAME_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
