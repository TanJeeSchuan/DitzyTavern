import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type JsonData } from "json-edit-react";
import { generationSettingsKey, publishGenerationSettings, useGenerationSettingsQuery, type SettingsRead } from "../generation-settings-query";
import { useRevisionedDraft, type DraftSaveResult } from "../lib/revisioned-draft";
import { useVisitSignal } from "../lib/visit";
import type { ConnectionProfile } from "../connection-settings";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ContinuationPrefillSuffix,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand, type ConversationCommandSurface } from "../conversation-command-runner";
import {
	budgetDraftsFromSettings,
	makeEmptyBudgetDrafts,
	makeEmptyOverridesDrafts,
	makeEmptySamplingDrafts,
	overridesDraftsFromSettings,
	resolveBudgetValues,
	resolveOverridesValues,
	resolveSamplingValues,
	samplingDraftsFromSettings,
	type BudgetDrafts,
	type BudgetField,
	type BudgetValues,
	type OverridesDrafts,
	type OverridesNamespace,
	type SamplingDrafts,
	type SamplingField,
	type SamplingValues,
} from "../generation-settings-draft";

export type GenerationSettingsDraftStatus = "loading" | "load-error" | "saving" | "ready";

/** @approved Whether the selected Connection Profile can carry Request Overrides, and under which namespace. */
export type TransmittingNamespace =
	| { status: "loading" }
	| { status: "no-active-profile" }
	| { status: "known"; namespace: OverridesNamespace };

// @approved
//  The Generation Settings save wording: each notice names what this surface
// preserved or could not reach, while the runner owns when each notice is
// shown.
const SAVE_NOTICES = {
	conflict: "These Generation Settings changed elsewhere. Your unsaved changes are preserved.",
	notFound: "This Chat no longer exists.",
	unreachable: "The Generation Settings could not be saved.",
};

// @approved
//  The draft values the panel resolves from its local editor state: every
// field a draft owns, resolved and validated before save.
export interface GenerationSettingsDraftValues {
	sampling: SamplingValues;
	budget: BudgetValues;
	overrides: ConversationGenerationSettings["requestOverrides"];
	strategy: ConversationGenerationSettings["continuationStrategy"];
	instruction: string;
	prefillSuffix: ContinuationPrefillSuffix;
	imagePlacement: ConversationGenerationSettings["repeatedImagePlacement"];
}

export interface SaveGenerationSettingsDraftOptions {
	conversation: ConversationSummary;
	drafts: GenerationSettingsDraftValues;
	surface: ConversationCommandSurface;
	onApplied: (settings: ConversationGenerationSettings, conversation: ConversationSummary) => void;
	signal?: AbortSignal;
	onConflict?: (conversation: ConversationSummary) => void;
}

// @approved
//  The panel's full-object write — the one client writer of the whole
// Generation Settings aggregate. The base is read at write time, so a model
// selection the composer's selector committed after this panel loaded is
// never restored stale, and every draft-owned field then overrides its base
// value. Revision conflicts keep the ADR-0023 behavior: the complete local
// draft is preserved for comparison or retry.
export async function saveGenerationSettingsDraft(
	options: SaveGenerationSettingsDraftOptions,
): Promise<boolean> {
	// The base is read in the save's own queue turn, so a model selection queued ahead of it is never restored.
	let next: ConversationGenerationSettings | undefined;
	return runConversationCommand(options.surface, async (expectedRevision) => {
		options.signal?.throwIfAborted();
		const base = await loadConversationGenerationSettings(options.conversation.id, options.signal);
		options.signal?.throwIfAborted();
		next = applyDraftsToGenerationSettings(base, options.drafts);
		return applyConversationCommand(options.conversation.id, expectedRevision, { type: "update-generation-settings", settings: next });
	}, {
		notices: SAVE_NOTICES,
		onApplied: (conversation) => { if (next !== undefined) options.onApplied(next, conversation); },
		onConflict: options.onConflict,
	});
}

// @approved
//  The written aggregate: the freshly read authoritative settings contribute
// the model selection no draft edits, and every draft-owned field overrides
// its base value.
function applyDraftsToGenerationSettings(
	base: ConversationGenerationSettings,
	drafts: GenerationSettingsDraftValues,
): ConversationGenerationSettings {
	return {
		...base,
		...drafts.sampling,
		...drafts.budget,
		continuationStrategy: drafts.strategy,
		continuationInstruction: drafts.instruction,
		continuationPrefillSuffix: drafts.prefillSuffix,
		repeatedImagePlacement: drafts.imagePlacement,
		requestOverrides: drafts.overrides,
	};
}

interface GenerationSettingsFields {
	instruction: string;
	strategy: ConversationGenerationSettings["continuationStrategy"];
	prefillSuffix: ContinuationPrefillSuffix;
	imagePlacement: ConversationGenerationSettings["repeatedImagePlacement"];
	samplingDrafts: SamplingDrafts;
	budgetDrafts: BudgetDrafts;
	overridesDrafts: OverridesDrafts;
}

const fieldsFromSettings = (settings: ConversationGenerationSettings): GenerationSettingsFields => ({
	instruction: settings.continuationInstruction,
	strategy: settings.continuationStrategy,
	prefillSuffix: settings.continuationPrefillSuffix,
	imagePlacement: settings.repeatedImagePlacement,
	samplingDrafts: samplingDraftsFromSettings(settings),
	budgetDrafts: budgetDraftsFromSettings(settings),
	overridesDrafts: overridesDraftsFromSettings(settings),
});

const EMPTY_FIELDS: GenerationSettingsFields = {
	instruction: "", strategy: "instruction", prefillSuffix: "", imagePlacement: "last",
	samplingDrafts: makeEmptySamplingDrafts(), budgetDrafts: makeEmptyBudgetDrafts(), overridesDrafts: makeEmptyOverridesDrafts(),
};
const sameFields = (left: GenerationSettingsFields, right: GenerationSettingsFields) => JSON.stringify(left) === JSON.stringify(right);
/** @approved The fields resolved for a save, or null while any of them is invalid. */
const draftValues = (fields: GenerationSettingsFields): GenerationSettingsDraftValues | null => {
	const sampling = resolveSamplingValues(fields.samplingDrafts);
	const budget = resolveBudgetValues(fields.budgetDrafts);
	const overrides = resolveOverridesValues(fields.overridesDrafts);
	if (sampling === null || budget === null || overrides === null || fields.instruction.trim() === "") return null;
	return { sampling, budget, overrides, strategy: fields.strategy, instruction: fields.instruction, prefillSuffix: fields.prefillSuffix, imagePlacement: fields.imagePlacement };
};

interface GenerationSettingsDraftOptions {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	connectionProfiles?: readonly ConnectionProfile[];
}

/** @approved
 * Owns the editable Generation Settings draft: the authoritative load, the
 * per-section drafts, and the revision-guarded save with conflict recovery
 * (a conflict refreshes the authoritative settings while every local draft
 * stays untouched). The panel renders the current draft state and wires the
 * returned updaters to its controls.
 */
export function useGenerationSettingsDraft({
	conversation,
	onConversationChange,
	connectionProfiles,
}: GenerationSettingsDraftOptions) {
	const client = useQueryClient();
	const conversationId = conversation?.id ?? null;
	const query = useGenerationSettingsQuery(conversation);
	const settings = query.data ?? null;
	const signal = useVisitSignal(conversationId);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => { setProblem(null); }, [conversationId]);
	// @approved
	//  The settings belong to the Conversation revision they were read or
	// written at; a save that lost only to a newer revision is sent again.
	const revisioned = (read: ConversationGenerationSettings, revision: number) => ({ value: fieldsFromSettings(read), revision });
	const readRevision = client.getQueryData<SettingsRead>(generationSettingsKey(conversationId))?.revision ?? 0;
	const editor = useRevisionedDraft<GenerationSettingsFields>(settings === null ? null : revisioned(settings, readRevision), {
		key: conversationId,
		equals: sameFields,
		save: async (fields, revision) => {
			const drafts = draftValues(fields);
			if (conversation === null || drafts === null) return { outcome: "failed" };
			let result: DraftSaveResult<GenerationSettingsFields> = { outcome: "failed" };
			let lost: ConversationSummary | null = null;
			try {
				await saveGenerationSettingsDraft({
					conversation, drafts, signal,
					surface: {
						conversationId: conversation.id,
						revision: () => revision,
						exact: true,
						isCurrent: () => !signal.aborted,
						onConversationChange: (current) => {
							const authority = client.getQueryData<SettingsRead>(generationSettingsKey(current.id));
							if (authority === undefined || authority.revision <= current.revision) onConversationChange(current);
						},
						setNotice: setProblem,
					},
					onApplied: (next, current) => {
						publishGenerationSettings(client, current, next);
						result = { outcome: "saved", saved: revisioned(next, current.revision) };
						setProblem(null);
					},
					onConflict: (current) => { lost = current; },
				});
			} catch {
				if (!signal.aborted) setProblem(SAVE_NOTICES.unreachable);
			}
			if (lost === null || signal.aborted) return result;
			const current: ConversationSummary = lost;
			// @approved
			//  Only settings read after the conflict are as new as the revision it
			// reported; without them the draft stays unsaved against its own base.
			const read = await client.refetchQueries({ queryKey: generationSettingsKey(current.id) }, { throwOnError: true }).then(() => true, () => false);
			const theirs = client.getQueryData<SettingsRead>(generationSettingsKey(current.id));
			return !read || theirs === undefined ? result : { outcome: "conflict", theirs: revisioned(theirs.settings, Math.max(theirs.revision, current.revision)) };
		},
	});
	const { instruction, strategy, prefillSuffix, imagePlacement, samplingDrafts, budgetDrafts, overridesDrafts } = editor.value ?? EMPTY_FIELDS;
	const selectedProfile = connectionProfiles?.find((profile) => profile.id === settings?.connectionProfileId);
	const transmittingNamespace: TransmittingNamespace = settings === null || connectionProfiles === undefined
		? { status: "loading" }
		: selectedProfile === undefined || selectedProfile.apiFormat === "images" || selectedProfile.apiFormat === "embeddings" || selectedProfile.apiFormat === "system-one"
			? { status: "no-active-profile" }
			: { status: "known", namespace: selectedProfile.apiFormat };

	const validDraft = !query.isError && settings !== null && draftValues(editor.value ?? EMPTY_FIELDS) !== null;
	const edit = (patch: (fields: GenerationSettingsFields) => Partial<GenerationSettingsFields>) => {
		editor.update((fields) => ({ ...fields, ...patch(fields) }));
		setProblem(null);
	};
	const updateSampling = (field: SamplingField, raw: string) => edit((fields) => ({ samplingDrafts: { ...fields.samplingDrafts, [field]: raw } }));
	const updateBudget = (field: BudgetField, raw: string) => edit((fields) => ({ budgetDrafts: { ...fields.budgetDrafts, [field]: raw } }));
	const updateOverrides = (namespace: OverridesNamespace, value: JsonData) => edit((fields) => ({ overridesDrafts: { ...fields.overridesDrafts, [namespace]: value } }));
	const updateInstruction = (value: string) => edit(() => ({ instruction: value }));
	const updateStrategy = (value: GenerationSettingsFields["strategy"]) => edit(() => ({ strategy: value }));
	const updatePrefillSuffix = (value: ContinuationPrefillSuffix) => edit(() => ({ prefillSuffix: value }));
	const updateImagePlacement = (value: GenerationSettingsFields["imagePlacement"]) => edit(() => ({ imagePlacement: value }));

	const status: GenerationSettingsDraftStatus = settings === null ? query.isError ? "load-error" : "loading" : editor.saving ? "saving" : "ready";
	const canSave = status === "ready" && validDraft;
	const save = async () => {
		if (!canSave) return false;
		// @approved
		//  ADR-0023: a conflict keeps the whole draft, and saving it again
		// replaces the change elsewhere, as the conflict notice says.
		editor.keepMine();
		return editor.save();
	};
	const discard = () => { editor.discard(); setProblem(null); };
	const dirty = editor.dirty;

	return {
		settings,
		status,
		problem: editor.conflict ? SAVE_NOTICES.conflict : problem,
		transmittingNamespace,
		instruction,
		strategy,
		setStrategy: updateStrategy,
		prefillSuffix,
		setPrefillSuffix: updatePrefillSuffix,
		imagePlacement,
		setImagePlacement: updateImagePlacement,
		samplingDrafts,
		updateSampling,
		budgetDrafts,
		updateBudget,
		overridesDrafts,
		updateOverrides,
		updateInstruction,
		canSave,
		dirty,
		save,
		discard,
	};
}
