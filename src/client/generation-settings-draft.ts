import type { JsonData } from "json-edit-react";
import {
	FIRST_CLASS_SAMPLING_WIRE_KEYS,
	OUTPUT_LIMIT_CHAT_COMPLETIONS_WIRE_KEYS,
	STRUCTURAL_CHAT_COMPLETIONS_WIRE_KEYS,
} from "../shared/generation-overrides";
import type {
	ConversationGenerationSettings,
	GenerationRequestOverrides,
} from "./conversation";

// The four first-class sampling keys mirror the server validation domain:
// null means the provider default, otherwise a finite number between -2 and 2.
export type SamplingField =
	| "temperature"
	| "topP"
	| "frequencyPenalty"
	| "presencePenalty";

export const SAMPLING_FIELDS = [
	"temperature",
	"topP",
	"frequencyPenalty",
	"presencePenalty",
] as const satisfies readonly SamplingField[];

export const SAMPLING_FIELD_LABELS = {
	temperature: "Temperature",
	topP: "Top P",
	frequencyPenalty: "Frequency penalty",
	presencePenalty: "Presence penalty",
} as const;

export interface SamplingDrafts {
	temperature: string;
	topP: string;
	frequencyPenalty: string;
	presencePenalty: string;
}

export function makeEmptySamplingDrafts(): SamplingDrafts {
	return { temperature: "", topP: "", frequencyPenalty: "", presencePenalty: "" };
}

export interface SamplingValues {
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
}

export type SamplingDraftValue =
	| { status: "empty" }
	| { status: "valid"; value: number }
	| { status: "invalid" };

export const SAMPLING_DRAFT_ERROR = "Enter a number between -2 and 2, or leave the field empty.";

export function parseSamplingDraft(raw: string): SamplingDraftValue {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { status: "empty" };
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value < -2 || value > 2) return { status: "invalid" };
	return { status: "valid", value };
}

export function samplingDraftsFromSettings(
	settings: Pick<ConversationGenerationSettings, SamplingField>,
): SamplingDrafts {
	return {
		temperature: samplingValueToDraft(settings.temperature),
		topP: samplingValueToDraft(settings.topP),
		frequencyPenalty: samplingValueToDraft(settings.frequencyPenalty),
		presencePenalty: samplingValueToDraft(settings.presencePenalty),
	};
}

function samplingValueToDraft(value: number | null): string {
	return value === null ? "" : String(value);
}

function draftNumber(parsed: SamplingDraftValue): number | null {
	return parsed.status === "valid" ? parsed.value : null;
}

// The four budget keys mirror the server validation domain: positive whole
// numbers for the first three, and a non-negative whole number for the Safety
// allowance. Unlike Sampling, a budget is always a concrete value, so a blank
// draft is invalid rather than a provider default.
export type BudgetField =
	| "contextLimit"
	| "responseBudget"
	| "safetyAllowance"
	| "siblingGenerationLimit";

export const BUDGET_FIELDS = [
	"contextLimit",
	"responseBudget",
	"safetyAllowance",
	"siblingGenerationLimit",
] as const satisfies readonly BudgetField[];

export const BUDGET_FIELD_LABELS = {
	contextLimit: "Context limit",
	responseBudget: "Response budget",
	safetyAllowance: "Safety allowance",
	siblingGenerationLimit: "Sibling Generation limit",
} as const;

// Matches the server command's per-field messages so client feedback reads as
// one system. The Safety allowance is the only field accepting zero.
export const BUDGET_FIELD_ERROR = {
	contextLimit: "Context limit must be a positive whole number.",
	responseBudget: "Response budget must be a positive whole number.",
	safetyAllowance: "Safety allowance must be a non-negative whole number.",
	siblingGenerationLimit: "Sibling Generation limit must be a positive whole number.",
} as const;

const BUDGET_FIELD_MINIMUM = {
	contextLimit: 1,
	responseBudget: 1,
	safetyAllowance: 0,
	siblingGenerationLimit: 1,
} as const satisfies Record<BudgetField, number>;

export interface BudgetDrafts {
	contextLimit: string;
	responseBudget: string;
	safetyAllowance: string;
	siblingGenerationLimit: string;
}

export function makeEmptyBudgetDrafts(): BudgetDrafts {
	return {
		contextLimit: "",
		responseBudget: "",
		safetyAllowance: "",
		siblingGenerationLimit: "",
	};
}

export interface BudgetValues {
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	siblingGenerationLimit: number;
}

export type BudgetDraftValue =
	| { status: "valid"; value: number }
	| { status: "invalid" };

// Mirrors the server's whole-number rule by accepting only canonical digit
// strings. Blank, negative, decimal, and exponent text all land as invalid so
// Apply cannot send a partially resolved aggregate; the parsed numeric value
// is then checked against the field minimum exactly like Number.isInteger.
export function parseBudgetDraft(field: BudgetField, raw: string): BudgetDraftValue {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return { status: "invalid" };
	const value = Number(trimmed);
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < BUDGET_FIELD_MINIMUM[field]) {
		return { status: "invalid" };
	}
	return { status: "valid", value };
}

export function budgetDraftsFromSettings(
	settings: Pick<ConversationGenerationSettings, BudgetField>,
): BudgetDrafts {
	return {
		contextLimit: String(settings.contextLimit),
		responseBudget: String(settings.responseBudget),
		safetyAllowance: String(settings.safetyAllowance),
		siblingGenerationLimit: String(settings.siblingGenerationLimit),
	};
}

// Returns null whenever any draft is invalid so Apply cannot send a partially
// resolved aggregate; unlike Sampling, budgets resolve to always-concrete numbers.
export function resolveBudgetValues(drafts: BudgetDrafts): BudgetValues | null {
	const contextLimit = parseBudgetDraft("contextLimit", drafts.contextLimit);
	if (contextLimit.status === "invalid") return null;
	const responseBudget = parseBudgetDraft("responseBudget", drafts.responseBudget);
	if (responseBudget.status === "invalid") return null;
	const safetyAllowance = parseBudgetDraft("safetyAllowance", drafts.safetyAllowance);
	if (safetyAllowance.status === "invalid") return null;
	const siblingGenerationLimit = parseBudgetDraft(
		"siblingGenerationLimit",
		drafts.siblingGenerationLimit,
	);
	if (siblingGenerationLimit.status === "invalid") return null;
	return {
		contextLimit: contextLimit.value,
		responseBudget: responseBudget.value,
		safetyAllowance: safetyAllowance.value,
		siblingGenerationLimit: siblingGenerationLimit.value,
	};
}

// Returns null whenever any draft is invalid so Apply cannot send a partially
// resolved aggregate; valid blanks become explicit nulls (provider default).
export function resolveSamplingValues(
	drafts: SamplingDrafts,
): SamplingValues | null {
	const temperature = parseSamplingDraft(drafts.temperature);
	const topP = parseSamplingDraft(drafts.topP);
	const frequencyPenalty = parseSamplingDraft(drafts.frequencyPenalty);
	const presencePenalty = parseSamplingDraft(drafts.presencePenalty);
	for (const parsed of [temperature, topP, frequencyPenalty, presencePenalty]) {
		if (parsed.status === "invalid") return null;
	}
	return {
		temperature: draftNumber(temperature),
		topP: draftNumber(topP),
		frequencyPenalty: draftNumber(frequencyPenalty),
		presencePenalty: draftNumber(presencePenalty),
	};
}

// Request Overrides drafts. Each namespace is an independent JSON object and
// the closed namespace set mirrors the Conversation Generation Settings
// contract, so switching the active Connection Profile never transmits
// overrides authored for another API Format.
export type OverridesNamespace =
	| "chat-completions"
	| "responses"
	| "anthropic-messages";

export const OVERRIDES_NAMESPACES = [
	"chat-completions",
	"responses",
	"anthropic-messages",
] as const satisfies readonly OverridesNamespace[];

export const OVERRIDES_NAMESPACE_LABELS = {
	"chat-completions": "Chat Completions",
	responses: "Responses",
	"anthropic-messages": "Anthropic Messages",
} as const;

export interface OverridesDrafts {
	"chat-completions": unknown;
	responses: unknown;
	"anthropic-messages": unknown;
}

export function makeEmptyOverridesDrafts(): OverridesDrafts {
	return { "chat-completions": {}, responses: {}, "anthropic-messages": {} };
}

export function overridesDraftsFromSettings(
	settings: Pick<ConversationGenerationSettings, "requestOverrides">,
): OverridesDrafts {
	return {
		"chat-completions": settings.requestOverrides["chat-completions"],
		responses: settings.requestOverrides["responses"],
		"anthropic-messages": settings.requestOverrides["anthropic-messages"],
	};
}

export type OverridesDraftValue =
	| { status: "valid"; value: GenerationRequestOverrides }
	| { status: "invalid" };

// Matches the server command's JSON-value message so client feedback reads
// as one system: the namespace must be an object whose JSON serialization
// succeeds. Arrays and scalars are invalid because the shared contract
// requires a Record per namespace.
export const OVERRIDES_DRAFT_ERROR = "Request Overrides must be JSON values.";

export function parseOverridesDraft(value: JsonData): OverridesDraftValue {
	// SAFETY: the object-tag check establishes a plain object (null, arrays,
	// and scalars all carry other tags) accepted by JSON.stringify.
	if (Object.prototype.toString.call(value) !== "[object Object]") {
		return { status: "invalid" };
	}
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return { status: "invalid" };
	}
	if (serialized === undefined) return { status: "invalid" };
	return {
		status: "valid",
		// SAFETY: serializing an object and parsing the result restores the
		// closed JSON value domain the shared contract allows, mirroring the
		// server's cloneRequestOverrides normalization.
		value: JSON.parse(serialized) as GenerationRequestOverrides,
	};
}

// Returns null whenever any namespace draft is invalid so Apply cannot send
// a partially resolved aggregate.
export function resolveOverridesValues(
	drafts: OverridesDrafts,
): ConversationGenerationSettings["requestOverrides"] | null {
	const chatCompletions = parseOverridesDraft(drafts["chat-completions"]);
	if (chatCompletions.status === "invalid") return null;
	const responses = parseOverridesDraft(drafts["responses"]);
	if (responses.status === "invalid") return null;
	const anthropicMessages = parseOverridesDraft(drafts["anthropic-messages"]);
	if (anthropicMessages.status === "invalid") return null;
	return {
		"chat-completions": chatCompletions.value,
		responses: responses.value,
		"anthropic-messages": anthropicMessages.value,
	};
}

// The first-class Sampling wire keys and the two managed key families are
// the shared closed sets from src/shared/generation-overrides.ts, so the
// editor notices can never drift from the server merge.
const FIRST_CLASS_SAMPLING_OVERRIDE_KEY_SET = new Set<string>(
	FIRST_CLASS_SAMPLING_WIRE_KEYS,
);

export function collidingSamplingOverrideKeys(
	overrides: GenerationRequestOverrides,
): string[] {
	return Object.keys(overrides).filter((key) =>
		FIRST_CLASS_SAMPLING_OVERRIDE_KEY_SET.has(key),
	);
}

// Chat Completions is the only namespace with a server-side merge today, and
// the merge skips the two shared managed key families rather than failing.
// Other namespaces are never transmitted, so nothing is managed for them and
// no key is rejected silently.
const MANAGED_OVERRIDE_KEY_SETS = {
	"chat-completions": {
		structural: STRUCTURAL_CHAT_COMPLETIONS_WIRE_KEYS,
		outputLimit: OUTPUT_LIMIT_CHAT_COMPLETIONS_WIRE_KEYS,
	},
	responses: { structural: [], outputLimit: [] },
	"anthropic-messages": { structural: [], outputLimit: [] },
} as const satisfies Record<
	OverridesNamespace,
	{ structural: readonly string[]; outputLimit: readonly string[] }
>;

export interface ManagedOverrideKeys {
	structural: string[];
	outputLimit: string[];
}

export function managedOverrideKeys(
	namespace: OverridesNamespace,
	overrides: GenerationRequestOverrides,
): ManagedOverrideKeys {
	const managed = MANAGED_OVERRIDE_KEY_SETS[namespace];
	return {
		structural: managed.structural.filter((key: string) => key in overrides),
		outputLimit: managed.outputLimit.filter((key: string) => key in overrides),
	};
}
