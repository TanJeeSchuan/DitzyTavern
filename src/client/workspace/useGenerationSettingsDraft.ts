import { useEffect, useRef, useState } from "react";
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
import { useAsyncEffect } from "../lib/use-async";

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
		temperature: drafts.sampling.temperature,
		topP: drafts.sampling.topP,
		frequencyPenalty: drafts.sampling.frequencyPenalty,
		presencePenalty: drafts.sampling.presencePenalty,
		contextLimit: drafts.budget.contextLimit,
		responseBudget: drafts.budget.responseBudget,
		safetyAllowance: drafts.budget.safetyAllowance,
		siblingGenerationLimit: drafts.budget.siblingGenerationLimit,
		continuationStrategy: drafts.strategy,
		continuationInstruction: drafts.instruction,
		continuationPrefillSuffix: drafts.prefillSuffix,
		requestOverrides: drafts.overrides,
	};
}

type LoadStatus = "loading" | "ready" | "saving" | "load-error";

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
	const [settings, setSettings] = useState<ConversationGenerationSettings | null>(null);
	const [instruction, setInstruction] = useState("");
	const [strategy, setStrategy] = useState<ConversationGenerationSettings["continuationStrategy"]>("instruction");
	const [prefillSuffix, setPrefillSuffix] = useState<ContinuationPrefillSuffix>("");
	const [samplingDrafts, setSamplingDrafts] = useState<SamplingDrafts>(makeEmptySamplingDrafts());
	const [budgetDrafts, setBudgetDrafts] = useState<BudgetDrafts>(makeEmptyBudgetDrafts());
	const [overridesDrafts, setOverridesDrafts] = useState<OverridesDrafts>(makeEmptyOverridesDrafts());
	// ==[HUMAN APPROVED]== The namespace transmitted with requests follows the active Connection
	// Profile's API Format. The state is a discriminated union so the badges
	// only claim a namespace is transmitted after Contact resolves one; the
	// no-active-profile and load-failure cases carry their own status lines.
	const [transmittingNamespace, setTransmittingNamespace] = useState<
		| { status: "loading" }
		| { status: "unavailable" }
		| { status: "no-active-profile" }
		| { status: "known"; namespace: OverridesNamespace }
	>({ status: "loading" });
	const [status, setStatus] = useState<LoadStatus>("loading");
	const [problem, setProblem] = useState<string | null>(null);
	const conversationIdRef = useRef<number | null>(conversation?.id ?? null);
	const draftVersionRef = useRef(0);
	const saveVersionRef = useRef(0);
	conversationIdRef.current = conversation?.id ?? null;

	useAsyncEffect((isCancelled) => {
		if (conversation === null) {
			setSettings(null);
			setStatus("loading");
			return;
		}
		const loadDraftVersion = draftVersionRef.current;
		setStatus("loading");
		void loadConversationGenerationSettings(conversation.id)
			.then((loaded) => {
				if (isCancelled()) return;
				setSettings(loaded);
				if (draftVersionRef.current !== loadDraftVersion) {
					setProblem(null);
					setStatus("ready");
					return;
				}
				setInstruction(loaded.continuationInstruction);
				setStrategy(loaded.continuationStrategy);
				setPrefillSuffix(loaded.continuationPrefillSuffix);
				setSamplingDrafts(samplingDraftsFromSettings(loaded));
				setBudgetDrafts(budgetDraftsFromSettings(loaded));
				setOverridesDrafts(overridesDraftsFromSettings(loaded));
				setProblem(null);
				setStatus("ready");
			})
			.catch(() => {
				if (!isCancelled()) setStatus("load-error");
			});
	}, [conversation?.id]);

	useEffect(() => {
		if (connectionProfiles === undefined || settings === null) {
			setTransmittingNamespace({ status: "loading" });
			return;
		}
		const selectedProfile = connectionProfiles.find(
			(profile) => profile.id === settings.connectionProfileId,
		);
		setTransmittingNamespace(selectedProfile === undefined || selectedProfile.apiFormat === "embeddings"
			? { status: "no-active-profile" }
			: { status: "known", namespace: selectedProfile.apiFormat });
	}, [connectionProfiles, settings]);

	const adoptModelSelection = (connectionProfileId: number, modelId: string) => {
		setSettings((current) => current === null ? null : { ...current, connectionProfileId, modelId });
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
	const dirty = settings !== null && (
		instruction !== settings.continuationInstruction || strategy !== settings.continuationStrategy || prefillSuffix !== settings.continuationPrefillSuffix ||
		JSON.stringify(samplingDrafts) !== JSON.stringify(samplingDraftsFromSettings(settings)) ||
		JSON.stringify(budgetDrafts) !== JSON.stringify(budgetDraftsFromSettings(settings)) ||
		JSON.stringify(overridesDrafts) !== JSON.stringify(overridesDraftsFromSettings(settings))
	);

	const updateSampling = (field: SamplingField, raw: string) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setSamplingDrafts((current) => ({ ...current, [field]: raw }));
	};

	const updateBudget = (field: BudgetField, raw: string) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setBudgetDrafts((current) => ({ ...current, [field]: raw }));
	};

	const updateOverrides = (namespace: OverridesNamespace, value: JsonData) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setOverridesDrafts((current) => ({ ...current, [namespace]: value }));
	};

	const updateInstruction = (value: string) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setInstruction(value);
	};

	const updateStrategy = (value: ConversationGenerationSettings["continuationStrategy"]) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setStrategy(value);
	};

	const updatePrefillSuffix = (value: ContinuationPrefillSuffix) => {
		draftVersionRef.current += 1;
		setProblem(null);
		setPrefillSuffix(value);
	};

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
		setStatus("saving");
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
					if (!ownsSave()) return;
					applied = true;
					setSettings(next);
					if (draftVersionRef.current === draftVersion) {
						setStrategy(next.continuationStrategy);
						setPrefillSuffix(next.continuationPrefillSuffix);
					}
					setProblem(null);
				},
				onConflict: (current) => {
					// ==[HUMAN APPROVED]== Refresh the displayed authoritative settings so a retry starts
					// from fresh values; every local draft stays untouched. The
					// write itself re-reads the authoritative settings anyway.
					void loadConversationGenerationSettings(current.id)
						.then((fresh) => {
							if (ownsSave() && conversationIdRef.current === current.id) setSettings(fresh);
						})
						.catch(() => undefined);
				},
				onNotPlayable: showUnreachable,
				onNotRemovable: showUnreachable,
			});
		} catch {
			// ==[HUMAN APPROVED]== The write-time read can fail before any command is sent; this
			// surface owns the unreachable presentation for that case too.
			if (ownsSave()) setProblem(SAVE_NOTICES.unreachable);
		} finally {
			if (ownsSave()) setStatus("ready");
		}
		return applied && draftVersionRef.current === draftVersion;
	};
	const discard = () => {
		if (settings === null) return;
		draftVersionRef.current += 1;
		setInstruction(settings.continuationInstruction);
		setStrategy(settings.continuationStrategy);
		setPrefillSuffix(settings.continuationPrefillSuffix);
		setSamplingDrafts(samplingDraftsFromSettings(settings));
		setBudgetDrafts(budgetDraftsFromSettings(settings));
		setOverridesDrafts(overridesDraftsFromSettings(settings));
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
