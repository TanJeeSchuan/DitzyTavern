import { expect, test } from "bun:test";
import { readProviderDiagnostic, redactProviderDiagnostic } from "./diagnostics";

test("removes configured secrets inside larger strings and JSON escapes without removing personal details", () => {
	const secret = 'custom"credential';
	const text = JSON.stringify({ error: `prefix${secret}suffix`, email: "writer@example.com", address: "127.0.0.1" });
	expect(redactProviderDiagnostic(text, [secret])).toBe(JSON.stringify({
		error: "prefix[REDACTED]suffix", email: "writer@example.com", address: "127.0.0.1",
	}));
	expect(redactProviderDiagnostic(`Invalid token ghp_${"A".repeat(36)}`, [])).toBe("Invalid token [REDACTED]");
});

test("cancels oversized error streams without returning a partial secret at the limit", async () => {
	let cancelled = false;
	let reads = 0;
	const response = new Response(new ReadableStream({
		pull(controller) {
			reads++;
			controller.enqueue(new TextEncoder().encode("x".repeat(16_380) + "secret-crossing-limit"));
		},
		cancel() { cancelled = true; },
	}));
	expect(await readProviderDiagnostic(response, ["secret-crossing-limit"])).toBe("[Provider response omitted: exceeds 16 KiB]");
	expect(cancelled).toBe(true);
	expect(reads).toBeLessThanOrEqual(2);
});

test("redacts a secret split across response chunks", async () => {
	const response = new Response(new ReadableStream({
		start(controller) {
			for (const part of ["bad secret-", "value"]) controller.enqueue(new TextEncoder().encode(part));
			controller.close();
		},
	}));
	expect(await readProviderDiagnostic(response, ["secret-value"])).toBe("bad [REDACTED]");
});
