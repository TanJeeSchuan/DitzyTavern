import { redact } from "flare-redact";
import { isTextualContentType } from "./provider-errors";

const MAX_DIAGNOSTIC_BYTES = 16_384;
const OMITTED = "[Provider response omitted: exceeds 16 KiB]";

export function redactProviderDiagnostic(text: string, secrets: readonly string[]): string {
	if (new TextEncoder().encode(text).byteLength > MAX_DIAGNOSTIC_BYTES) return OMITTED;
	for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
		text = text.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]").replaceAll(secret, "[REDACTED]");
	}
	const redacted = redact(text, { disable: ["pii", "network", "crypto", "finance", "vehicle"], mask: "[REDACTED]" });
	return new TextEncoder().encode(redacted).byteLength > MAX_DIAGNOSTIC_BYTES ? OMITTED : redacted;
}

export async function readProviderDiagnostic(response: Response, secrets: readonly string[]): Promise<string> {
	const contentType = response.headers.get("content-type");
	if (contentType !== null && !isTextualContentType(contentType)) {
		await response.body?.cancel();
		return "[Provider response omitted: binary body]";
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return redactProviderDiagnostic(text + decoder.decode(), secrets);
			bytes += value.byteLength;
			if (bytes > MAX_DIAGNOSTIC_BYTES) {
				await reader.cancel();
				return OMITTED;
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}
