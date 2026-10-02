import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type JsonData } from "json-edit-react";
import type { ConnectionProfile } from "../connection-settings";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ContinuationPrefillSuffix,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand, type ConversationCommandReconciliation } from "../conversation-command-runner";
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

// ==[HUMAN APPROVED]== The Generation Settings save wording: each notice names what this surface
// preserved or could not reach, while the runner owns when each notice is
// shown.
const SAVE_NOTICES = {
	conflict: "These Generation Settings changed elsewhere. Your unsaved changes are preserved.",
	notFound: "This Chat no longer exists.",
	unreachable: "The Generation Settings could not be saved.",
};

// ==[HUMAN APPROVED]== The draft values the panel resolves from its local editor state: every
// field a draft owns, resolved and validated before save.
export interface GenerationSettingsDraftValues {
	sampling: SamplingValues;
	budget: BudgetValues;
	overrides: ConversationGenerationSettings["requestOverrides"];
	strategy: ConversationGenerationSettings["continuationStrategy"];
	instruction: string;
	prefillSuffix: ContinuationPrefillSuffix;
}

export interface SaveGenerationSettingsDraftOptions {
	conversation: ConversationSummary;
	drafts: GenerationSettingsDraftValues;
	reconciliation: ConversationCommandReconciliation;
	onApplied: (settings: ConversationGenerationSettings) => void;
	onConflict?: (conversation: ConversationSummary) => void;
	onNotPlayable: (reason: string) => void;
	onNotRemovable: (reason: string) => void;
}

// ==[HUMAN APPROVED]== The panel's full-object write — the one client writer of the whole
// Generation Settings aggregate. The base is read at write time, so a model
// selection the composer's selector committed after this panel loaded is
// never restored stale, and every draft-owned field then overrides its base
// value. Revision conflicts keep the ADR-0023 behavior: the complete local
// draft is preserved for comparison or retry.
export async function saveGenerationSettingsDraft(
	options: SaveGenerationSettingsDraftOptions,
): Promise<void> {
	const base = await loadConversationGenerationSettings(options.conversation.id);
	const next = applyDraftsToGenerationSettings(base, options.drafts);
	return runConversationCommand({
		revision: () => options.conversation.revision,
		send: (expectedRevision) =>
			applyConversationCommand(options.conversation.id, expectedRevision, {
				type: "update-generation-settings",
				settings: next,
			}),
		reconciliation: options.reconciliation,
		notices: SAVE_NOTICES,
		callbacks: {
			onApplied: () => options.onApplied(next),
			onConflict: options.onConflict,
			onNotPlayable: options.onNotPlayable,
			onNotRemovable: options.onNotRemovable,
		},
	});
}

// ==[HUMAN APPROVED]== The written aggregate: the freshly read authoritative settings contribute
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
		requestOverrides: drafts.overrides,
	};
}

interface GenerationSettingsFields {
	instruction: string;
	strategy: ConversationGenerationSettings["continuationStrategy"];
	prefillSuffix: ContinuationPrefillSuffix;
	samplingDrafts: SamplingDrafts;
	budgetDrafts: BudgetDrafts;
	overridesDrafts: OverridesDrafts;
}

const fieldsFromSettings = (settings: ConversationGenerationSettings): GenerationSettingsFields => ({
	instruction: settings.continuationInstruction,
	strategy: settings.continuationStrategy,
	prefillSuffix: settings.continuationPrefillSuffix,
	samplingDrafts: samplingDraftsFromSettings(settings),
	budgetDrafts: budgetDraftsFromSettings(settings),
	overridesDrafts: overridesDraftsFromSettings(settings),
});

interface GenerationSettingsDraftOptions {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	connectionProfiles?: readonly ConnectionProfile[];
}

/**
 * ==[HUMAN APPROVED]== Owns the editable Generation Settings draft: the authoritative load, the
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
	const query = useQuery({
		queryKey: ["generation-settings", conversationId],
		queryFn: ({ signal }) => loadConversationGenerationSettings(conversationId!, signal),
		enabled: conversationId !== null,
	});
	const settings = query.data ?? null;
	const form = useForm<GenerationSettingsFields>({ defaultValues: {
		instruction: "", strategy: "instruction", prefillSuffix: "",
		samplingDrafts: makeEmptySamplingDrafts(), budgetDrafts: makeEmptyBudgetDrafts(), overridesDrafts: makeEmptyOverridesDrafts(),
	} });
	const { reset, getValues, setValue, watch, formState: { isDirty } } = form;
	const { instruction, strategy, prefillSuffix, samplingDrafts, budgetDrafts, overridesDrafts } = watch();
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const conversationIdRef = useRef(conversationId);
	const initializedConversation = useRef<number | null>(null);
	const draftVersionRef = useRef(0);
	const saveVersionRef = useRef(0);
	conversationIdRef.current = conversationId;
	const status = settings === null ? query.isError ? "load-error" : "loading" : saving ? "saving" : "ready";
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
	const transmittingNamespace = settings === null || connectionProfiles === undefined
		? { status: "loading" as const }
		: selectedProfile === undefined || selectedProfile.apiFormat === "embeddings"
			? { status: "no-active-profile" as const }
			: { status: "known" as const, namespace: selectedProfile.apiFormat };
	const adoptModelSelection = (connectionProfileId: number, modelId: string) => {
		void client.cancelQueries({ queryKey: ["generation-settings", conversationId] });
		client.setQueryData<ConversationGenerationSettings>(["generation-settings", conversationId], (current) => current && { ...current, connectionProfileId, modelId });
	};

	const samplingValues = resolveSamplingValues(samplingDrafts);
	const budgetValues = resolveBudgetValues(budgetDrafts);
	const overridesValues = resolveOverridesValues(overridesDrafts);
	const canSave =
		status === "ready" &&
		settings !== null &&
		samplingValues !== null &&
		budgetValues !== null &&
		overridesValues !== null &&
		instruction.trim() !== "";
	const dirty = settings !== null && isDirty;
	const edited = () => { draftVersionRef.current += 1; setProblem(null); };
	const updateSampling = (field: SamplingField, raw: string) => { edited(); setValue("samplingDrafts", { ...getValues("samplingDrafts"), [field]: raw }, { shouldDirty: true }); };
	const updateBudget = (field: BudgetField, raw: string) => { edited(); setValue("budgetDrafts", { ...getValues("budgetDrafts"), [field]: raw }, { shouldDirty: true }); };
	const updateOverrides = (namespace: OverridesNamespace, value: JsonData) => { edited(); setValue("overridesDrafts", { ...getValues("overridesDrafts"), [namespace]: value }, { shouldDirty: true }); };
	const updateInstruction = (value: string) => { edited(); setValue("instruction", value, { shouldDirty: true }); };
	const updateStrategy = (value: GenerationSettingsFields["strategy"]) => { edited(); setValue("strategy", value, { shouldDirty: true }); };
	const updatePrefillSuffix = (value: ContinuationPrefillSuffix) => { edited(); setValue("prefillSuffix", value, { shouldDirty: true }); };

	const save = async () => {
		if (
			conversation === null ||
			!canSave ||
			samplingValues === null ||
			budgetValues === null ||
			overridesValues === null
		) return false;
		const conversationId = conversation.id;
		const draftVersion = draftVersionRef.current;
		const saveVersion = ++saveVersionRef.current;
		let applied = false;
		setSaving(true);
		const ownsSave = () => saveVersionRef.current === saveVersion && conversationIdRef.current === conversationId;
		const showUnreachable = () => {
			if (ownsSave()) setProblem(SAVE_NOTICES.unreachable);
		};
		try {
			await saveGenerationSettingsDraft({
				conversation,
				drafts: {
					sampling: samplingValues,
					budget: budgetValues,
					overrides: overridesValues,
					strategy,
					instruction,
					prefillSuffix,
				},
				reconciliation: {
					adoptSnapshot: (snapshot) => {
						if (conversationIdRef.current === conversationId) onConversationChange(snapshot);
					},
					showNotice: (message) => {
						if (ownsSave()) setProblem(message);
					},
				},
				onApplied: (next) => {
					void client.cancelQueries({ queryKey: ["generation-settings", conversationId] });
					client.setQueryData(["generation-settings", conversationId], next);
					if (!ownsSave()) return;
					applied = true;
					resetDraft(next, draftVersionRef.current !== draftVersion);
					setProblem(null);
				},
				onConflict: (current) => { void client.invalidateQueries({ queryKey: ["generation-settings", current.id] }); },
				onNotPlayable: showUnreachable,
				onNotRemovable: showUnreachable,
			});
		} catch {
			// ==[HUMAN APPROVED]== The write-time read can fail before any command is sent; this
			// surface owns the unreachable presentation for that case too.
			if (ownsSave()) setProblem(SAVE_NOTICES.unreachable);
		} finally {
			if (saveVersionRef.current === saveVersion) setSaving(false);
		}
		return applied && draftVersionRef.current === draftVersion;
	};
	const discard = () => {
		if (settings === null) return;
		draftVersionRef.current += 1;
		reset(fieldsFromSettings(settings));
		setProblem(null);
	};

	return {
		settings,
		status,
		problem,
		transmittingNamespace,
		adoptModelSelection,
		instruction,
		strategy,
		setStrategy: updateStrategy,
		prefillSuffix,
		setPrefillSuffix: updatePrefillSuffix,
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

export type GenerationSettingsDraftController = ReturnType<typeof useGenerationSettingsDraft>;
