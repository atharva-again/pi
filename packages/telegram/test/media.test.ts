import { describe, expect, it } from "vitest";
import { downloadPdfDocument, isPdfDocument } from "../src/media.ts";

const pdf = Buffer.from("%PDF-1.7\nsample PDF bytes\n%%EOF");

describe("Telegram PDF attachments", () => {
	it("recognizes PDF MIME types and case-insensitive file extensions", () => {
		expect(isPdfDocument({ file_id: "one", mime_type: "application/pdf" })).toBe(true);
		expect(isPdfDocument({ file_id: "two", file_name: "report.PDF" })).toBe(true);
		expect(isPdfDocument({ file_id: "three", file_name: "report.txt" })).toBe(false);
		expect(isPdfDocument(undefined)).toBe(false);
	});

	it("preserves downloaded PDF bytes and its filename as a document attachment", async () => {
		const document = await downloadPdfDocument(
			{
				getFile: async (fileId) => ({
					file_id: fileId,
					file_unique_id: "unique",
					file_path: "documents/report.pdf",
				}),
				downloadFile: async () => pdf,
			},
			{ file_id: "pdf-id", file_name: "report.pdf", mime_type: "application/pdf" },
			"telegram-1.pdf",
		);

		expect(document).toEqual({
			type: "document",
			data: pdf.toString("base64"),
			mimeType: "application/pdf",
			filename: "report.pdf",
		});
		expect(Buffer.from(document.data, "base64")).toEqual(pdf);
	});

	it("uses a safe fallback filename and rejects invalid or oversized PDFs", async () => {
		const api = {
			getFile: async (fileId: string) => ({
				file_id: fileId,
				file_unique_id: "unique",
				file_path: "documents/report.pdf",
			}),
			downloadFile: async () => pdf,
		};
		const document = await downloadPdfDocument(
			api,
			{ file_id: "pdf-id", file_name: "../../\u0000.pdf", mime_type: "application/pdf" },
			"telegram-2.pdf",
		);

		expect(document.filename).toBe("_.pdf");

		await expect(
			downloadPdfDocument(
				api,
				{ file_id: "large", file_name: "large.pdf", file_size: 20 * 1024 * 1024 + 1 },
				"telegram-3.pdf",
			),
		).rejects.toThrow("20 MB");
		await expect(
			downloadPdfDocument(
				{ ...api, downloadFile: async () => Buffer.from("not a PDF") },
				{
					file_id: "invalid",
					file_name: "report.pdf",
				},
				"telegram-4.pdf",
			),
		).rejects.toThrow("valid PDF header");
	});
});
