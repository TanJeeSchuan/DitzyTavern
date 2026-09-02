import {
	InvalidConnectionProfileError,
} from "./errors";
import { compareModelIds } from "../../shared/model-identifier";
import type {
	ConnectionHeaderOperation,
	ConnectionProfileDraft,
	ConnectionProfileSecretSnapshot,
} from "./types";

export function validateConnectionProfileDraft(
	input: ConnectionProfileDraft,
): ConnectionProfileDraft {
	const displayName = normalizeDisplayName(input.displayName);
	if (input.apiFormat !== "chat-completions") {
		throw new InvalidConnectionProfileError(
			"Only the Chat Completions API Format is available in version one.",
		);
	}
	if (input.modelBackend !== "automatic" && input.modelBackend !== "ai-sdk") {
		throw new InvalidConnectionProfileError("The selected Model Backend is unavailable.");
	}
	if (!["openai-compatible", "deepseek", "openrouter"].includes(input.adapter)) {
		throw new InvalidConnectionProfileError("The selected AI SDK Adapter is unavailable.");
	}
	if (!["automatic", "max_tokens", "max_completion_tokens", "omit"].includes(input.outputTokenRepresentation)) {
		throw new InvalidConnectionProfileError(
			"The selected output-token representation is unavailable.",
		);
	}
	const requestUrl = validateUrl(input.requestUrl, "request URL", true);
	const modelsUrl = validateUrl(input.modelsUrl, "Models URL", true);
	if (
		input.timeoutMs !== null &&
		(!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0)
	) {
		throw new InvalidConnectionProfileError(
			"Timeout must be zero, null, or a positive whole number of milliseconds.",
		);
	}
	const pinnedModels = normalizePinnedModels(input.pinnedModels);
	return {
		displayName,
		apiFormat: "chat-completions",
		requestUrl,
		modelsUrl,
		modelBackend: input.modelBackend,
		adapter: input.adapter,
		outputTokenRepresentation: input.outputTokenRepresentation,
		timeoutMs: input.timeoutMs,
		pinnedModels,
	};
}

export function applyConnectionHeaderOperations(
	current: ConnectionProfileSecretSnapshot | null,
	operations: readonly ConnectionHeaderOperation[],
): ConnectionProfileSecretSnapshot | null {
	const validated = validateHeaderOperations(operations);
	const headers = applyHeaderOperations(current?.headers ?? {}, validated);
	if ((current?.credential ?? null) === null && Object.keys(headers).length === 0) return null;
	return { credential: current?.credential ?? null, headers };
}

export function validateHeaderOperations(
	operations: readonly ConnectionHeaderOperation[],
): readonly ConnectionHeaderOperation[] {
	const seen = new Set<string>();
	return operations.map((operation) => {
		const normalized = operation.name.toLowerCase();
		if (!HTTP_TOKEN.test(operation.name) || TRANSPORT_OWNED_HEADERS.has(normalized)) {
			throw new InvalidConnectionProfileError(
				`Custom header name "${operation.name}" is not a valid user-controlled HTTP header.`,
			);
		}
		if (seen.has(normalized)) {
			throw new InvalidConnectionProfileError(
				`Custom header names must be unique case-insensitively: "${operation.name}".`,
			);
		}
		seen.add(normalized);
		return operation;
	});
}

export function applyHeaderOperations(
	current: Readonly<Record<string, string>>,
	operations: readonly ConnectionHeaderOperation[],
): ConnectionProfileSecretSnapshot["headers"] {
	const next = { ...current } satisfies ConnectionProfileSecretSnapshot["headers"];
	for (const operation of operations) {
		const existingName = Object.keys(next).find(
			(name) => name.toLowerCase() === operation.name.toLowerCase(),
		);
		if (operation.operation === "keep") continue;
		if (operation.operation === "remove") {
			if (existingName !== undefined) delete next[existingName];
			continue;
		}
		if (existingName !== undefined) delete next[existingName];
		next[operation.name] = operation.value;
	}
	return next;
}

export function normalizeDisplayName(value: string): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		throw new InvalidConnectionProfileError("A Connection Profile display name is required.");
	}
	return normalized;
}

export function normalizePinnedModels(models: readonly string[]): string[] {
	const result: string[] = [];
	for (const model of models) {
		const normalized = model.trim();
		if (normalized.length === 0) {
			throw new InvalidConnectionProfileError("Pinned model IDs cannot be blank.");
		}
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result;
}

export function normalizeDiscoveryCatalog(models: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const model of models) {
		const normalized = model.trim();
		if (normalized.length > 0) unique.add(normalized);
	}
	return [...unique].sort(compareModelIds);
}

export function normalizeCredential(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.length === 0) return null;
	if (value.trim().length === 0) return null;
	return value;
}

function validateUrl(value: string, label: string, allowBlank: boolean): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		if (allowBlank) return "";
		throw new InvalidConnectionProfileError(`A ${label} is required.`);
	}
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new InvalidConnectionProfileError(`The ${label} must be a valid HTTP or HTTPS URL.`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0
	) {
		throw new InvalidConnectionProfileError(
			`${label} must use HTTP or HTTPS without user information or a fragment.`,
		);
	}
	return normalized;
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TRANSPORT_OWNED_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
