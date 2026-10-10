import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type JsonData } from "json-edit-react";
import { generationSettingsKey, publishGenerationSettings, useGenerationSettingsQuery } from "../generation-settings-query";
import type { ConnectionProfile } from "../connection-settings";
import {
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
	options.signal?.throwIfAborted();
	const base = await loadConversationGenerationSettings(options.conversation.id, options.signal);
	options.signal?.throwIfAborted();
	const next = applyDraftsToGenerationSettings(base, options.drafts);
	return runConversationCommand(options.surface, {
		type: "update-generation-settings",
		settings: next,
	}, {
		notices: SAVE_NOTICES,
		onApplied: (conversation) => options.onApplied(next, conversation),
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
	const form = useForm<GenerationSettingsFields>({ defaultValues: {
		instruction: "", strategy: "instruction", prefillSuffix: "", imagePlacement: "last",
		samplingDrafts: makeEmptySamplingDrafts(), budgetDrafts: makeEmptyBudgetDrafts(), overridesDrafts: makeEmptyOverridesDrafts(),
	} });
	const { reset, getValues, setValue, watch, formState: { isDirty } } = form;
	const { instruction, strategy, prefillSuffix, imagePlacement, samplingDrafts, budgetDrafts, overridesDrafts } = watch();
	const [problem, setProblem] = useState<string | null>(null);
	const session = useRef({ cancellation: new AbortController(), editorIdentity: Symbol(), saving: false });
	const initializedConversation = useRef<number | null>(null);
	useEffect(() => {
		session.current = { cancellation: new AbortController(), editorIdentity: Symbol(), saving: false };
		setProblem(null);
		return () => session.current.cancellation.abort();
	}, [conversationId]);
	const resetDraft = (authoritative: ConversationGenerationSettings, preserve: boolean) => {
		const current = getValues();
		reset(fieldsFromSettings(authoritative));
		if (preserve) reset(current, { keepDefaultValues: true });
	};
	const syncDraft = useEffectEvent(() => {
		if (settings === null) return;
		const sameConversation = initializedConversation.current === conversationId;
		resetDraft(settings, sameConversation && isDirty);
		if (!sameConversation) { initializedConversation.current = conversationId; setProblem(null); }
	});
	useEffect(() => { syncDraft(); }, [conversationId, settings]);
	const selectedProfile = connectionProfiles?.find((profile) => profile.id === settings?.connectionProfileId);
	const transmittingNamespace: TransmittingNamespace = settings === null || connectionProfiles === undefined
		? { status: "loading" }
		: selectedProfile === undefined || selectedProfile.apiFormat === "embeddings" || selectedProfile.apiFormat === "system-one"
			? { status: "no-active-profile" }
			: { status: "known", namespace: selectedProfile.apiFormat };

	const samplingValues = resolveSamplingValues(samplingDrafts);
	const budgetValues = resolveBudgetValues(budgetDrafts);
	const overridesValues = resolveOverridesValues(overridesDrafts);
	const validDraft =
		!query.isError &&
		settings !== null &&
		samplingValues !== null &&
		budgetValues !== null &&
		overridesValues !== null &&
		instruction.trim() !== "";
	const dirty = settings !== null && isDirty;
	const edited = () => { session.current.editorIdentity = Symbol(); setProblem(null); };
	const updateSampling = (field: SamplingField, raw: string) => { edited(); setValue("samplingDrafts", { ...getValues("samplingDrafts"), [field]: raw }, { shouldDirty: true }); };
	const updateBudget = (field: BudgetField, raw: string) => { edited(); setValue("budgetDrafts", { ...getValues("budgetDrafts"), [field]: raw }, { shouldDirty: true }); };
	const updateOverrides = (namespace: OverridesNamespace, value: JsonData) => { edited(); setValue("overridesDrafts", { ...getValues("overridesDrafts"), [namespace]: value }, { shouldDirty: true }); };
	const updateInstruction = (value: string) => { edited(); setValue("instruction", value, { shouldDirty: true }); };
	const updateStrategy = (value: GenerationSettingsFields["strategy"]) => { edited(); setValue("strategy", value, { shouldDirty: true }); };
	const updatePrefillSuffix = (value: ContinuationPrefillSuffix) => { edited(); setValue("prefillSuffix", value, { shouldDirty: true }); };
	const updateImagePlacement = (value: GenerationSettingsFields["imagePlacement"]) => { edited(); setValue("imagePlacement", value, { shouldDirty: true }); };

	const write = useMutation({
		mutationKey: ["generation-settings", conversationId, "save"],
		mutationFn: async (submission: { conversation: ConversationSummary; drafts: GenerationSettingsDraftValues; signal: AbortSignal; editorIdentity: symbol }) => {
			let applied = false;
			const ownsEditor = () => !submission.signal.aborted && session.current.editorIdentity === submission.editorIdentity;
			try {
				await saveGenerationSettingsDraft({
					...submission,
					surface: {
						conversationId: submission.conversation.id,
						revision: () => submission.conversation.revision,
						isCurrent: () => !submission.signal.aborted,
						onConversationChange: (current) => {
							const authority = client.getQueryData<{ revision: number }>(generationSettingsKey(current.id));
							if (authority === undefined || authority.revision <= current.revision) onConversationChange(current);
						},
						setNotice: (message) => { if (ownsEditor()) setProblem(message); },
					},
					onApplied: (next, current) => {
						if (submission.signal.aborted) return;
						const authority = publishGenerationSettings(client, current, next);
						if (authority?.revision !== current.revision || !ownsEditor()) return;
						applied = true;
						resetDraft(next, false);
						setProblem(null);
					},
					onConflict: (current) => {
						if (!submission.signal.aborted) void client.invalidateQueries({ queryKey: generationSettingsKey(current.id) });
					},
				});
			} catch {
				if (ownsEditor()) setProblem(SAVE_NOTICES.unreachable);
			} finally {
				if (!submission.signal.aborted) session.current.saving = false;
			}
			return applied && ownsEditor();
		},
	});
	const resetWrite = write.reset;
	useEffect(() => { resetWrite(); }, [conversationId, resetWrite]);
	const status: GenerationSettingsDraftStatus = settings === null ? query.isError ? "load-error" : "loading" : write.isPending ? "saving" : "ready";
	const canSave = status === "ready" && validDraft;
	const save = async () => {
		if (conversation === null || !canSave || samplingValues === null || budgetValues === null || overridesValues === null || session.current.saving) return false;
		session.current.saving = true;
		return write.mutateAsync({
			conversation, signal: session.current.cancellation.signal, editorIdentity: session.current.editorIdentity,
			drafts: { sampling: samplingValues, budget: budgetValues, overrides: overridesValues, strategy, instruction, prefillSuffix, imagePlacement },
		});
	};
	const discard = () => {
		if (settings === null) return;
		session.current.editorIdentity = Symbol();
		reset(fieldsFromSettings(settings));
		setProblem(null);
	};

	return {
		settings,
		status,
		problem,
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
