import { useRef, useState } from "react";
import { type JsonData } from "json-edit-react";
import { loadConnectionSettings } from "../connection-settings";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ContinuationPrefillSuffix,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "../conversation";
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
	type OverridesDrafts,
	type OverridesNamespace,
	type SamplingDrafts,
	type SamplingField,
} from "../generation-settings-draft";
import { useAsyncEffect } from "../lib/use-async";

type LoadStatus = "loading" | "ready" | "saving" | "load-error";

interface GenerationSettingsDraftOptions {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
}

/**
 * Owns the editable Generation Settings draft: the authoritative load, the
 * per-section drafts, and the revision-guarded save with conflict recovery
 * (a conflict refreshes the authoritative settings while every local draft
 * stays untouched). The panel renders the current draft state and wires the
 * returned updaters to its controls.
 */
export function useGenerationSettingsDraft({
	conversation,
	onConversationChange,
}: GenerationSettingsDraftOptions) {
	const [settings, setSettings] = useState<ConversationGenerationSettings | null>(null);
	const [instruction, setInstruction] = useState("");
	const [strategy, setStrategy] = useState<ConversationGenerationSettings["continuationStrategy"]>("instruction");
	const [prefillSuffix, setPrefillSuffix] = useState<ContinuationPrefillSuffix>("");
	const [samplingDrafts, setSamplingDrafts] = useState<SamplingDrafts>(makeEmptySamplingDrafts());
	const [budgetDrafts, setBudgetDrafts] = useState<BudgetDrafts>(makeEmptyBudgetDrafts());
	const [overridesDrafts, setOverridesDrafts] = useState<OverridesDrafts>(makeEmptyOverridesDrafts());
	// The namespace transmitted with requests follows the active Connection
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
	const conversationIdRef = useRef(conversation.id);
	conversationIdRef.current = conversation.id;

	useAsyncEffect((isCancelled) => {
		setStatus("loading");
		void loadConversationGenerationSettings(conversation.id)
			.then((loaded) => {
				if (isCancelled()) return;
				setSettings(loaded);
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
	}, [conversation.id]);

	// Connection Settings are global and this panel remounts on every open, so
	// a single load identifies the transmitting namespace for this visit.
	useAsyncEffect((isCancelled) => {
		void loadConnectionSettings()
			.then((settings) => {
				if (isCancelled()) return;
				const active = settings.profiles.find(
					(profile) => profile.id === settings.activeProfileId,
				);
				setTransmittingNamespace(
					active === undefined
						? { status: "no-active-profile" }
						: { status: "known", namespace: active.apiFormat },
				);
			})
			.catch(() => {
				if (!isCancelled()) setTransmittingNamespace({ status: "unavailable" });
			});
	}, []);

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

	const updateSampling = (field: SamplingField, raw: string) => {
		setProblem(null);
		setSamplingDrafts((current) => ({ ...current, [field]: raw }));
	};

	const updateBudget = (field: BudgetField, raw: string) => {
		setProblem(null);
		setBudgetDrafts((current) => ({ ...current, [field]: raw }));
	};

	const updateOverrides = (namespace: OverridesNamespace, value: JsonData) => {
		setProblem(null);
		setOverridesDrafts((current) => ({ ...current, [namespace]: value }));
	};

	const updateInstruction = (value: string) => {
		setProblem(null);
		setInstruction(value);
	};

	const save = async () => {
		if (
			!canSave ||
			settings === null ||
			samplingValues === null ||
			budgetValues === null ||
			overridesValues === null
		) return;
		setStatus("saving");
		const next: ConversationGenerationSettings = {
			...settings,
			temperature: samplingValues.temperature,
			topP: samplingValues.topP,
			frequencyPenalty: samplingValues.frequencyPenalty,
			presencePenalty: samplingValues.presencePenalty,
			contextLimit: budgetValues.contextLimit,
			responseBudget: budgetValues.responseBudget,
			safetyAllowance: budgetValues.safetyAllowance,
			siblingGenerationLimit: budgetValues.siblingGenerationLimit,
			continuationStrategy: strategy,
			continuationInstruction: instruction,
			continuationPrefillSuffix: prefillSuffix,
			requestOverrides: overridesValues,
		};
		const outcome = await applyConversationCommand(conversation.id, conversation.revision, {
			type: "update-generation-settings",
			settings: next,
		});
		if (outcome.status === "applied") {
			setSettings(next);
			setStrategy(next.continuationStrategy);
			setPrefillSuffix(next.continuationPrefillSuffix);
			onConversationChange(outcome.conversation);
			setProblem(null);
			setStatus("ready");
			return;
		}
		if (outcome.status === "conflict") {
			onConversationChange(outcome.currentConversation);
			setProblem("These Generation Settings changed elsewhere. Your unsaved changes are preserved.");
			// Refresh the authoritative settings so a retry merges fresh values for
			// fields the user did not edit; every local draft stays untouched.
			const conversationId = conversation.id;
			void loadConversationGenerationSettings(conversationId)
				.then((fresh) => {
					if (conversationIdRef.current === conversationId) setSettings(fresh);
				})
				.catch(() => undefined);
		} else if (outcome.status === "invalid") {
			setProblem(outcome.reason);
		} else if (outcome.status === "not-found") {
			setProblem("This Chat no longer exists.");
		} else {
			setProblem("The Generation Settings could not be saved.");
		}
		setStatus("ready");
	};

	return {
		settings,
		status,
		problem,
		transmittingNamespace,
		instruction,
		strategy,
		setStrategy,
		prefillSuffix,
		setPrefillSuffix,
		samplingDrafts,
		updateSampling,
		budgetDrafts,
		updateBudget,
		overridesDrafts,
		updateOverrides,
		updateInstruction,
		canSave,
		save,
	};
}
