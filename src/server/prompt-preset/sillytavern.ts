import { defaultOutgoingRoles, type NativePromptPreset, type PromptOutgoingRole, type SillyTavernImportDiagnostic, type SillyTavernImportPreview, type SillyTavernImportRequest, type SillyTavernJsonValue, type SillyTavernOrderChoice } from "../../shared/contract/prompt-preset";
import { scanMacroToken } from "../../shared/prompt-macros";
import { InvalidPromptPresetCommandError } from "./errors";

type JsonRecord = { [key: string]: SillyTavernJsonValue };

interface SourceDefinition {
	identifier: string;
	name: string;
	content: string;
	role: PromptOutgoingRole;
	roleWasDefaulted: boolean;
	marker: boolean;
	injectionPosition: number;
	injectionPositionWasDefaulted: boolean;
}

interface SourceOrderEntry {
	identifier: string;
	enabled: boolean;
}

interface SourceOrderList {
	id: string;
	entries: SourceOrderEntry[];
}

interface NormalizedSource {
	name: string | undefined;
	definitions: SourceDefinition[];
	duplicateDefinitionIdentifiers: string[];
	orders: SourceOrderList[];
	settings: JsonRecord;
}

const supportedReferences = {
	charDescription: "model-identity",
	personaDescription: "human-identity",
	scenario: "model-scenario",
	dialogueExamples: "model-example-dialogue",
	chatHistory: "history",
} as const;

const unsupportedPlaceholders = new Set([
	"worldInfoBefore",
	"worldInfoAfter",
	"groupNudge",
	"impersonation",
	"new_chat",
	"new_group_chat",
	"new_example_chat",
	"continue_nudge",
	"continue",
	"lastMessage",
	"last_message",
	"task",
	"summary",
]);

const authoredBuiltIns = new Set(["main", "nsfw", "jailbreak", "enhanceDefinitions"]);

export const isSillyTavernJsonValue = (value: unknown): value is SillyTavernJsonValue => {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.every((entry) => isSillyTavernJsonValue(entry));
	if (typeof value !== "object") return false;
	return Object.values(value).every((entry) => isSillyTavernJsonValue(entry));
};

const isJsonObject = (value: SillyTavernJsonValue): value is JsonRecord =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonString = (value: SillyTavernJsonValue): value is string => typeof value === "string";
const isJsonNumber = (value: SillyTavernJsonValue): value is number => typeof value === "number";
const isJsonBoolean = (value: SillyTavernJsonValue | undefined): value is boolean => typeof value === "boolean";

const asJsonRecord = (value: SillyTavernJsonValue): JsonRecord | null =>
	isJsonObject(value) ? value : null;

const requiredString = (value: SillyTavernJsonValue | undefined, field: string): string => {
	if (value === undefined || !isJsonString(value) || value.trim() === "") {
		throw new InvalidPromptPresetCommandError(`SillyTavern JSON must provide a non-empty ${field}.`);
	}
	return value;
};

const sourceRole = (value: SillyTavernJsonValue | undefined): { role: PromptOutgoingRole; wasDefaulted: boolean } =>
	value === "user" || value === "assistant" || value === "system"
		? { role: value, wasDefaulted: false }
		: { role: "system", wasDefaulted: true };

const sourceInjectionPosition = (value: SillyTavernJsonValue | undefined): { position: number; wasDefaulted: boolean } =>
	value !== undefined && isJsonNumber(value) && Number.isFinite(value) && (value === 0 || value === 1)
		? { position: value, wasDefaulted: false }
		: { position: 0, wasDefaulted: value !== undefined };

const sourceName = (source: JsonRecord, requestedName: string | undefined): string => {
	const name = requestedName?.trim() || (source.name !== undefined && isJsonString(source.name) ? source.name.trim() : "");
	return name || "Imported SillyTavern preset";
};

const normalizeSource = (value: SillyTavernJsonValue): NormalizedSource => {
	const source = asJsonRecord(value);
	if (source === null) {
		throw new InvalidPromptPresetCommandError("SillyTavern JSON must be an object.");
	}
	if (!Array.isArray(source.prompts)) {
		throw new InvalidPromptPresetCommandError("SillyTavern JSON is missing its prompts array.");
	}
	if (!Array.isArray(source.prompt_order)) {
		throw new InvalidPromptPresetCommandError("SillyTavern JSON is missing its prompt_order array.");
	}

	const definitions: SourceDefinition[] = [];
	const duplicateDefinitionIdentifiers: string[] = [];
	const seenDefinitions = new Set<string>();
	for (const [index, value] of source.prompts.entries()) {
		const definition = asJsonRecord(value);
		if (definition === null) {
			throw new InvalidPromptPresetCommandError(`SillyTavern prompt definition ${index + 1} must be an object.`);
		}
		const identifier = requiredString(definition.identifier, `prompt definition ${index + 1} identifier`);
		if (seenDefinitions.has(identifier)) {
			duplicateDefinitionIdentifiers.push(identifier);
			continue;
		}
		seenDefinitions.add(identifier);
		const content = definition.content === undefined ? "" : definition.content;
		if (!isJsonString(content)) {
			throw new InvalidPromptPresetCommandError(`SillyTavern definition "${identifier}" has non-text content.`);
		}
		const role = sourceRole(definition.role);
		const injectionPosition = sourceInjectionPosition(definition.injection_position);
		definitions.push({
			identifier,
			name: definition.name !== undefined && isJsonString(definition.name) && definition.name !== "" ? definition.name : identifier,
			content,
			role: role.role,
			roleWasDefaulted: role.wasDefaulted,
			marker: definition.marker === true,
			injectionPosition: injectionPosition.position,
			injectionPositionWasDefaulted: injectionPosition.wasDefaulted,
		});
	}

	const orders: SourceOrderList[] = [];
	for (const [index, value] of source.prompt_order.entries()) {
		const order = asJsonRecord(value);
		if (order === null || !Array.isArray(order.order)) {
			throw new InvalidPromptPresetCommandError(`SillyTavern order list ${index + 1} must provide an order array.`);
		}
		const idValue = order.character_id;
		if (!(idValue !== undefined && (isJsonString(idValue) || isJsonNumber(idValue)))) {
			throw new InvalidPromptPresetCommandError(`SillyTavern order list ${index + 1} is missing character_id.`);
		}
		const entries: SourceOrderEntry[] = [];
		for (const [entryIndex, entryValue] of order.order.entries()) {
			const entry = asJsonRecord(entryValue);
			if (entry === null) {
				throw new InvalidPromptPresetCommandError(`SillyTavern order entry ${entryIndex + 1} must be an object.`);
			}
			const identifier = requiredString(entry.identifier, `order entry ${entryIndex + 1} identifier`);
			if (!isJsonBoolean(entry.enabled)) {
				throw new InvalidPromptPresetCommandError(`SillyTavern order entry "${identifier}" must provide enabled.`);
			}
			entries.push({ identifier, enabled: entry.enabled });
		}
		orders.push({ id: String(idValue), entries });
	}
	if (orders.length === 0) {
		throw new InvalidPromptPresetCommandError("SillyTavern JSON contains no order lists to import.");
	}
	return {
		name: source.name !== undefined && isJsonString(source.name) ? source.name : undefined,
		definitions,
		duplicateDefinitionIdentifiers,
		orders,
		settings: source,
	};
};

const orderChoices = (orders: readonly SourceOrderList[]): SillyTavernOrderChoice[] =>
	orders.map((order) => ({
		id: order.id,
		label: order.id === "100001" ? "OpenAI order (100001)" : `Order ${order.id}`,
		entryCount: order.entries.length,
	}));

const chooseOrder = (orders: readonly SourceOrderList[], requested: string | undefined): SourceOrderList | null => {
	if (requested !== undefined) return orders.find((order) => order.id === requested) ?? null;
	return orders.find((order) => order.id === "100001") ?? (orders.length === 1 ? orders[0] : null);
};

const diagnostic = (code: string, message: string, identifier?: string): SillyTavernImportDiagnostic => {
	const value: SillyTavernImportDiagnostic = { code, message };
	if (identifier !== undefined) value.identifier = identifier;
	return value;
};

// ==[HUMAN APPROVED]== Translation walks the same token stream as expansion (the shared
// scan in `prompt-macros.ts`), so escaping, Prompt Comments and malformed
// delimiters mean the same thing in both passes. Only an active `{{user}}`
// or `{{char}}` macro is rewritten to the native names; a backslash pair,
// an escaped macro or comment, an active comment, an unknown macro and
// every other character are preserved verbatim, so authored formatting
// outside the translation is never rewritten.
const translateCommentsAndMacros = (source: string): string => {
	let output = "";
	let index = 0;
	while (index < source.length) {
		const token = scanMacroToken(source, index, (name) => {
			const normalized = name.toLowerCase();
			return normalized === "user" || normalized === "char";
		});
		if (token.kind === "macro") {
			if (token.name.toLowerCase() === "user") output += "{{self}}";
			else if (token.name.toLowerCase() === "char") output += "{{other}}";
			else output += source.slice(index, token.end);
		} else if (token.kind === "escaped-macro") {
			// ==[HUMAN APPROVED]== SillyTavern keeps `\{{name}}` active: the backslash is ordinary
			// text because the braces remain adjacent. Translate the name while
			// retaining that literal prefix for the runtime evaluator.
			if (token.name.toLowerCase() === "user") output += `\\{{self}}`;
			else if (token.name.toLowerCase() === "char") output += `\\{{other}}`;
			else output += source.slice(index, token.end);
		} else {
			output += source.slice(index, token.end);
		}
		index = token.end;
	}
	return output;
};

const supportedReference = (identifier: string): keyof typeof supportedReferences | null => {
	if (!Object.hasOwn(supportedReferences, identifier)) return null;
	// ==[HUMAN APPROVED]== SAFETY: Object.hasOwn proves the identifier is one of supportedReferences' literal keys.
	return identifier as keyof typeof supportedReferences;
};

const sourceDefinitionMap = (definitions: readonly SourceDefinition[]): Map<string, SourceDefinition> =>
	new Map(definitions.map((definition) => [definition.identifier, definition]));

const pushOnce = (diagnostics: SillyTavernImportDiagnostic[], seen: Set<string>, value: SillyTavernImportDiagnostic): void => {
	const key = `${value.code}:${value.identifier ?? ""}`;
	if (seen.has(key)) return;
	seen.add(key);
	diagnostics.push(value);
};

const reportDefinitionNormalization = (
	diagnostics: SillyTavernImportDiagnostic[],
	seen: Set<string>,
	definition: SourceDefinition,
	converted: Extract<ConvertedDefinition, { slot: unknown }>,
): void => {
	if (converted.slot.reference !== "instruction") return;
	if (definition.roleWasDefaulted) {
		pushOnce(
			diagnostics,
			seen,
			diagnostic(
				"default-role",
				`Authored block "${definition.identifier}" had no supported role; the system role was used.`,
				definition.identifier,
			),
		);
	}
	if (definition.injectionPositionWasDefaulted) {
		pushOnce(
			diagnostics,
			seen,
			diagnostic(
				"invalid-injection-position",
				`Injection position for authored block "${definition.identifier}" was invalid; it was placed using ordinary recipe order.`,
				definition.identifier,
			),
		);
	}
};

// ==[HUMAN APPROVED]== One converted definition, used identically by listed occurrences and
// unlisted definitions so the two paths can never classify the same source
// differently. Conversion decides what the definition is (a supported
// reference with its default outgoing role, an authored instruction with its
// translated text, or an omitted unsupported placeholder); enablement and
// placement are applied separately by the caller.
type ConvertedDefinition =
	| { slot: { reference: "history" } }
	| { slot: { reference: "model-identity" | "human-identity" | "model-scenario" | "model-example-dialogue"; role: PromptOutgoingRole } }
	| { slot: { reference: "instruction"; role: PromptOutgoingRole; name: string; content: string } }
	| { unsupported: SillyTavernImportDiagnostic };

const classifyDefinition = (definition: SourceDefinition): ConvertedDefinition => {
	const sourceReference = supportedReference(definition.identifier);
	if (sourceReference !== null) {
		const reference = supportedReferences[sourceReference];
		if (reference === "history") return { slot: { reference } };
		return { slot: { reference, role: defaultOutgoingRoles[reference] } };
	}
	if (definition.identifier === "charPersonality") {
		return {
			unsupported: diagnostic(
				"unsupported-placeholder",
				"Character personality was omitted because DitzyTavern has one native Identity field.",
				definition.identifier,
			),
		};
	}
	if (!authoredBuiltIns.has(definition.identifier) && (unsupportedPlaceholders.has(definition.identifier) || definition.marker)) {
		return {
			unsupported: diagnostic(
				"unsupported-placeholder",
				`Unsupported SillyTavern placeholder "${definition.identifier}" was omitted.`,
				definition.identifier,
			),
		};
	}
	return {
		slot: {
			reference: "instruction",
			role: definition.role,
			name: definition.name,
			content: translateCommentsAndMacros(definition.content),
		},
	};
};

// ==[HUMAN APPROVED]== Enablement is applied after conversion: listed occurrences take the
// chosen order's enabled value, unlisted definitions become disabled trailing
// slots. References never embed resolved Participant content.
const withEnablement = (
	converted: Extract<ConvertedDefinition, { slot: unknown }>,
	enabled: boolean,
): NativePromptPreset["slots"][number] => {
	if (converted.slot.reference === "history") {
		return { reference: "history", enabled };
	}
	if (converted.slot.reference === "instruction") {
		return {
			reference: "instruction",
			enabled,
			role: converted.slot.role,
			name: converted.slot.name,
			content: converted.slot.content,
		};
	}
	return { reference: converted.slot.reference, enabled, role: converted.slot.role };
};

const buildSillyTavernPreview = (
	normalized: NormalizedSource,
	name: string,
	requestedOrderId: string | undefined,
): SillyTavernImportPreview => {
	const choices = orderChoices(normalized.orders);
	const order = chooseOrder(normalized.orders, requestedOrderId);
	if (requestedOrderId !== undefined && order === null) {
		throw new InvalidPromptPresetCommandError(`SillyTavern order list "${requestedOrderId}" was not found.`);
	}
	if (order === null) {
		return {
			name,
			native: { name, slots: [] },
			diagnostics: [diagnostic("order-selection-required", "Choose one order list before importing this preset.")],
			orderLists: choices,
			selectedOrderId: null,
			requiresOrderSelection: true,
		};
	}

	const definitions = sourceDefinitionMap(normalized.definitions);
	const diagnostics: SillyTavernImportDiagnostic[] = [];
	const diagnosticKeys = new Set<string>();
	const listedIdentifiers = new Set(order.entries.map((entry) => entry.identifier));
	const regular: NativePromptPreset["slots"] = [];
	const depthPlaced: NativePromptPreset["slots"] = [];
	const unlisted: NativePromptPreset["slots"] = [];
	for (const identifier of normalized.duplicateDefinitionIdentifiers) {
		pushOnce(
			diagnostics,
			diagnosticKeys,
			diagnostic(
				"duplicate-definition",
				`Prompt definition "${identifier}" appeared more than once; later definitions were omitted and the first was kept.`,
				identifier,
			),
		);
	}

	for (const entry of order.entries) {
		const definition = definitions.get(entry.identifier);
		if (definition === undefined) {
			pushOnce(diagnostics, diagnosticKeys, diagnostic("missing-definition", `Order entry "${entry.identifier}" has no matching prompt definition and was omitted.`, entry.identifier));
			continue;
		}
		const converted = classifyDefinition(definition);
		if ("unsupported" in converted) {
			pushOnce(diagnostics, diagnosticKeys, converted.unsupported);
			continue;
		}
		reportDefinitionNormalization(diagnostics, diagnosticKeys, definition, converted);
		const slot = withEnablement(converted, entry.enabled);
		if (converted.slot.reference === "instruction" && definition.injectionPosition === 1) {
			depthPlaced.push(slot);
		} else {
			regular.push(slot);
		}
	}

	// ==[HUMAN APPROVED]== Unlisted definitions become disabled trailing slots in source
	// definition order, so an author can inspect and enable any supported
	// reference absent from the chosen order list. Unsupported placeholders
	// are omitted with the same deduplicated diagnostics in either path.
	for (const definition of normalized.definitions) {
		if (listedIdentifiers.has(definition.identifier)) continue;
		const converted = classifyDefinition(definition);
		if ("unsupported" in converted) {
			pushOnce(diagnostics, diagnosticKeys, converted.unsupported);
			continue;
		}
		reportDefinitionNormalization(diagnostics, diagnosticKeys, definition, converted);
		unlisted.push(withEnablement(converted, false));
	}

	if (depthPlaced.length > 0) {
		const historyIndex = regular.map((slot) => slot.reference).lastIndexOf("history");
		const insertAt = historyIndex === -1 ? regular.length : historyIndex + 1;
		regular.splice(insertAt, 0, ...depthPlaced);
		pushOnce(diagnostics, diagnosticKeys, diagnostic("depth-placement", historyIndex === -1
			? "History-depth instructions were placed at the end because this recipe has no history slot."
			: "History-depth instructions were placed after the last history slot; their positions are now ordinary recipe order."));
	}
	regular.push(...unlisted);

	const excludedSettingGroups = [
		{
			code: "excluded-generation-settings",
			keys: [
				"temperature", "top_p", "top_k", "top_a", "min_p", "frequency_penalty", "presence_penalty",
				"repetition_penalty", "openai_max_tokens", "openai_max_context", "max_tokens", "max_context",
				"max_context_unlocked", "seed", "n", "reasoning_effort", "verbosity", "scenario_format",
				"personality_format", "wi_format", "names_behavior", "send_if_empty", "stream_openai",
				"assistant_prefill", "assistant_impersonation", "use_sysprompt", "squash_system_messages",
				"media_inlining", "inline_image_quality", "continue_prefill", "continue_postfix", "show_thoughts",
				"request_images", "request_image_aspect_ratio", "request_image_resolution", "impersonation_prompt",
				"new_chat_prompt", "new_group_chat_prompt", "new_example_chat_prompt", "continue_nudge_prompt",
				"group_nudge_prompt", "bias_preset_selected",
			],
			message: "Generation, sampling and prompt-format settings were not imported; DitzyTavern settings are unchanged.",
		},
		{
			code: "excluded-model-settings",
			keys: ["model", "chat_completion_source", "api_url", "connection_profile", "custom_model"],
			message: "Model, connection and provider settings were not imported; the selected Connection Profile is unchanged.",
		},
		{
			code: "excluded-tool-settings",
			keys: ["tools", "function_calling", "tool_reasoning_mode", "tool_call_recurse_limit", "enable_web_search"],
			message: "Tool and function execution settings were not imported or executed.",
		},
		{
			code: "excluded-scripts",
			keys: ["regex_scripts", "regex", "extensions", "enable_extensions"],
			message: "Regex scripts and extensions were not imported or executed.",
		},
	] as const;
	for (const group of excludedSettingGroups) {
		if (group.keys.some((key) => Object.hasOwn(normalized.settings, key))) {
			pushOnce(diagnostics, diagnosticKeys, diagnostic(group.code, group.message));
		}
	}

	return {
		name,
		native: { name, slots: regular },
		diagnostics,
		orderLists: choices,
		selectedOrderId: order.id,
		requiresOrderSelection: false,
	};
};

const normalizeSillyTavernImportRequest = (value: SillyTavernJsonValue): SillyTavernImportRequest => {
	const envelope = asJsonRecord(value);
	if (envelope === null || !Object.hasOwn(envelope, "source")) {
		throw new InvalidPromptPresetCommandError("SillyTavern import request must provide a source.");
	}
	if (envelope.name !== undefined && !isJsonString(envelope.name)) {
		throw new InvalidPromptPresetCommandError("SillyTavern import name must be text.");
	}
	if (envelope.orderListId !== undefined && !isJsonString(envelope.orderListId)) {
		throw new InvalidPromptPresetCommandError("SillyTavern orderListId must be text.");
	}
	return {
		source: envelope.source,
		name: envelope.name !== undefined && isJsonString(envelope.name) ? envelope.name : undefined,
		orderListId: envelope.orderListId !== undefined && isJsonString(envelope.orderListId) ? envelope.orderListId : undefined,
	};
};

export const reviewSillyTavernPromptPreset = (value: SillyTavernJsonValue): SillyTavernImportPreview => {
	const request = normalizeSillyTavernImportRequest(value);
	if (!isSillyTavernJsonValue(request.source)) {
		throw new InvalidPromptPresetCommandError("SillyTavern import source must be valid JSON.");
	}
	const normalized = normalizeSource(request.source);
	return buildSillyTavernPreview(normalized, sourceName(normalized.settings, request.name), request.orderListId);
};

// ==[HUMAN APPROVED]== Converts one SillyTavern source into the review preview the import flow
// commits; a source that needs an order choice is refused rather than guessed.
export const convertSillyTavernPromptPreset = (value: SillyTavernJsonValue): SillyTavernImportPreview => {
	const preview = reviewSillyTavernPromptPreset(value);
	if (preview.requiresOrderSelection) {
		throw new InvalidPromptPresetCommandError("Choose one SillyTavern order list before importing.");
	}
	return preview;
};
