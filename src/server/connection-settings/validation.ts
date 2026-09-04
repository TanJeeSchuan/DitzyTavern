import {
	InvalidConnectionProfileError,
} from "./errors";
import { compareModelIds } from "../../shared/model-identifier";
import {
	validateConnectionProfileHeaderNames,
	validateConnectionProfileSharedDraft,
} from "../../shared/connection-profile-validation";
import type {
	ConnectionHeaderOperation,
	ConnectionProfileDraft,
	ConnectionProfileSecretSnapshot,
} from "./types";

export function validateConnectionProfileDraft(
	input: ConnectionProfileDraft,
): ConnectionProfileDraft {
	const displayName = normalizeDisplayName(input.displayName);
	const sharedFailure = validateConnectionProfileSharedDraft(input);
	if (sharedFailure !== null) {
		throw new InvalidConnectionProfileError(sharedFailure.message);
	}
	const requestUrl = input.requestUrl.trim();
	const modelsUrl = input.modelsUrl.trim();
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
	const failure = validateConnectionProfileHeaderNames(
		operations.map((operation) => operation.name),
	);
	if (failure !== null) {
		throw new InvalidConnectionProfileError(failure.message);
	}
	return operations;
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
