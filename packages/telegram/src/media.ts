import { basename } from "node:path";
import type { DocumentContent } from "@earendil-works/pi-ai";
import type { TelegramApi, TelegramDocument } from "./telegram-api.ts";

const MAX_TELEGRAM_PDF_BYTES = 20 * 1024 * 1024;
const PDF_HEADER = Buffer.from("%PDF-");

function pdfFilename(document: TelegramDocument, fallbackFilename: string): string {
	const candidate = document.file_name?.replace(/\\/g, "/");
	const filename = candidate ? basename(candidate) : fallbackFilename;
	const sanitized = filename.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
	return sanitized || fallbackFilename;
}

export function isPdfDocument(document: TelegramDocument | undefined): document is TelegramDocument {
	if (!document) return false;
	if (document.mime_type?.split(";")[0]?.trim().toLowerCase() === "application/pdf") {
		return true;
	}
	return document.file_name?.toLowerCase().endsWith(".pdf") ?? false;
}

export async function downloadPdfDocument(
	api: Pick<TelegramApi, "getFile" | "downloadFile">,
	document: TelegramDocument,
	fallbackFilename: string,
): Promise<DocumentContent> {
	if (!isPdfDocument(document)) {
		throw new Error("Telegram document is not a PDF");
	}
	if (document.file_size !== undefined && document.file_size > MAX_TELEGRAM_PDF_BYTES) {
		throw new Error("PDF is larger than Telegram's 20 MB download limit");
	}

	const file = await api.getFile(document.file_id);
	if (!file.file_path) {
		throw new Error("Telegram did not return a file path for the PDF");
	}
	const data = await api.downloadFile(file.file_path);
	if (data.byteLength > MAX_TELEGRAM_PDF_BYTES) {
		throw new Error("PDF is larger than Telegram's 20 MB download limit");
	}
	if (!data.subarray(0, 1024).includes(PDF_HEADER)) {
		throw new Error("Telegram document does not contain a valid PDF header");
	}

	return {
		type: "document",
		data: data.toString("base64"),
		mimeType: "application/pdf",
		filename: pdfFilename(document, fallbackFilename),
	};
}
