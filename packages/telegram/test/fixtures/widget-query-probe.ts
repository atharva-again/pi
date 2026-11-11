import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestTelegramQueryAnswer } from "../../src/widget-query-channel.ts";

export default function widgetQueryProbe(pi: ExtensionAPI): void {
	pi.registerCommand("widget_answer_probe", {
		description: "Exercise the Telegram query answer channel without a model.",
		handler: async (args) => {
			const outcome = await requestTelegramQueryAnswer(
				args === "inline"
					? {
							kind: "inline",
							options: {
								inlineQueryId: "inline-query",
								resultId: "result",
								title: "Test widget",
								content: { html: "<p>Ready</p>" },
							},
						}
					: { kind: "widget", queryId: "widget-query", data: "ready" },
				undefined,
			);
			pi.appendEntry("widget_answer_probe", { outcome });
		},
	});
}
