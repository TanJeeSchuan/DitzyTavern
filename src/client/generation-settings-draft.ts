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

export const SAMPLING_FIELD_LABELS = {
	temperature: "Temperature",
	topP: "Top P",
	frequencyPenalty: "Frequency penalty",
	presencePenalty: "Presence penalty",
} as const;

export type SamplingField = keyof typeof SAMPLING_FIELD_LABELS;
export const SAMPLING_FIELDS = /* SAFETY: these keys come from the closed field declaration above. */ Object.keys(SAMPLING_FIELD_LABELS) as SamplingField[];
export type SamplingDrafts = Record<SamplingField, string>;
export type SamplingValues = Pick<ConversationGenerationSettings, SamplingField>;
export const makeEmptySamplingDrafts = (): SamplingDrafts => /* SAFETY: mapping every sampling key supplies a string for every field. */ Object.fromEntries(SAMPLING_FIELDS.map((key) => [key, ""])) as SamplingDrafts;

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
	// SAFETY: mapping the complete field list supplies every key with a string value.
	return Object.fromEntries(SAMPLING_FIELDS.map((key) => [key, settings[key] === null ? "" : String(settings[key])])) as SamplingDrafts;
}

export const BUDGET_FIELD_LABELS = {
	contextLimit: "Context limit",
	responseBudget: "Response budget",
	safetyAllowance: "Safety allowance",
	siblingGenerationLimit: "Sibling Generation limit",
} as const;

// ==[HUMAN APPROVED]== Matches the server command's per-field messages so client feedback reads as
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

export type BudgetField = keyof typeof BUDGET_FIELD_LABELS;
export const BUDGET_FIELDS = /* SAFETY: these keys come from the closed field declaration above. */ Object.keys(BUDGET_FIELD_LABELS) as BudgetField[];
export type BudgetDrafts = Record<BudgetField, string>;
export type BudgetValues = Pick<ConversationGenerationSettings, BudgetField>;
export const makeEmptyBudgetDrafts = (): BudgetDrafts => /* SAFETY: mapping every budget key supplies a string for every field. */ Object.fromEntries(BUDGET_FIELDS.map((key) => [key, ""])) as BudgetDrafts;

export type BudgetDraftValue =
	| { status: "valid"; value: number }
	| { status: "invalid" };

// ==[HUMAN APPROVED]== Mirrors the server's whole-number rule by accepting only canonical digit
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
	// SAFETY: mapping the complete field list supplies every key with a string value.
	return Object.fromEntries(BUDGET_FIELDS.map((key) => [key, String(settings[key])])) as BudgetDrafts;
}

export function resolveBudgetValues(drafts: BudgetDrafts): BudgetValues | null {
	const entries = BUDGET_FIELDS.map((key) => [key, parseBudgetDraft(key, drafts[key])] as const);
	if (entries.some(([, parsed]) => parsed.status === "invalid")) return null;
	// SAFETY: every budget key is present and invalid values were rejected above.
	return Object.fromEntries(entries.map(([key, parsed]) => [key, parsed.status === "valid" ? parsed.value : null])) as BudgetValues;
}

export function resolveSamplingValues(drafts: SamplingDrafts): SamplingValues | null {
	const entries = SAMPLING_FIELDS.map((key) => [key, parseSamplingDraft(drafts[key])] as const);
	if (entries.some(([, parsed]) => parsed.status === "invalid")) return null;
	// SAFETY: every sampling key is present; blanks map to null after rejecting invalid values.
	return Object.fromEntries(entries.map(([key, parsed]) => [key, parsed.status === "valid" ? parsed.value : null])) as SamplingValues;
}

// ==[HUMAN APPROVED]== Request Overrides drafts. Each namespace is an independent JSON object and
// the closed namespace set mirrors the Conversation Generation Settings
// contract, so switching the selected Connection Profile never transmits
// overrides authored for another API Format.
export type OverridesNamespace = keyof ConversationGenerationSettings["requestOverrides"];

export const OVERRIDES_NAMESPACE_LABELS = {
	"chat-completions": "Chat Completions",
	responses: "Responses",
	"anthropic-messages": "Anthropic Messages",
} as const;

export const OVERRIDES_NAMESPACES = /* SAFETY: these keys come from the closed field declaration above. */ Object.keys(OVERRIDES_NAMESPACE_LABELS) as OverridesNamespace[];
export type OverridesDrafts = Record<OverridesNamespace, JsonData>;

export function makeEmptyOverridesDrafts() {
	return { "chat-completions": {}, responses: {}, "anthropic-messages": {} };
}

export function overridesDraftsFromSettings(
	settings: Pick<ConversationGenerationSettings, "requestOverrides">,
) {
	return { ...settings.requestOverrides };
}

export type OverridesDraftValue =
	| { status: "valid"; value: GenerationRequestOverrides }
	| { status: "invalid" };

// ==[HUMAN APPROVED]== Matches the server command's JSON-value message so client feedback reads
// as one system: the namespace must be an object whose JSON serialization
// succeeds. Arrays and scalars are invalid because the shared contract
// requires a Record per namespace.
export const OVERRIDES_DRAFT_ERROR = "Request Overrides must be JSON values.";

export function parseOverridesDraft(value: JsonData): OverridesDraftValue {
	// ==[HUMAN APPROVED]== SAFETY: the object-tag check establishes a plain object (null, arrays,
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
		// ==[HUMAN APPROVED]== SAFETY: serializing an object and parsing the result restores the
		// closed JSON value domain the shared contract allows, mirroring the
		// server's cloneRequestOverrides normalization.
		value: JSON.parse(serialized) as GenerationRequestOverrides,
	};
}

// ==[HUMAN APPROVED]== Returns null whenever any namespace draft is invalid so Apply cannot send
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

export function requestOverridesSummary(
	drafts: OverridesDrafts,
	transmittingNamespace: OverridesNamespace | null,
): string {
	const overrides = resolveOverridesValues(drafts);
	if (overrides === null) return "Fix invalid values";
	if (transmittingNamespace === null) return "Nothing sent without a selected API Format";
	const count = Object.keys(overrides[transmittingNamespace]).length;
	const label = OVERRIDES_NAMESPACE_LABELS[transmittingNamespace];
	return count === 0 ? `No custom fields for ${label}` : `${count} custom field${count === 1 ? "" : "s"} sent to ${label}`;
}

// ==[HUMAN APPROVED]== The first-class Sampling wire keys and the two managed key families are
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

// ==[HUMAN APPROVED]== Chat Completions is the only namespace with a server-side merge today, and
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
