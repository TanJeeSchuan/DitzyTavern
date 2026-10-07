import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loadConversationGenerationSettings, type ConversationGenerationSettings, type ConversationSummary } from "./conversation";
import { commitConversationModel, MODEL_SELECTION_UNAVAILABLE_NOTICE } from "./model-selection-command";
import { loadConnectionSettings, type ConnectionProfile, type ConnectionSettings } from "./connection-settings";
import { useAsyncEffect } from "./lib/use-async";
import { ProfileModelPicker, type ProfileModelChoice } from "./ProfileModelPicker";

export function ModelSelector({ conversation, disabled = false, disabledReason, onConversationChange }: {
	conversation: ConversationSummary;
	disabled?: boolean;
	disabledReason?: string;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const client = useQueryClient();
	const generation = useQuery({ queryKey: ["generation-settings", conversation.id], queryFn: ({ signal }) => loadConversationGenerationSettings(conversation.id, signal) });
	const selected: ProfileModelChoice | null = generation.data === undefined ? null : { connectionProfileId: generation.data.connectionProfileId, modelId: generation.data.modelId };
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reasonId = useId();

	useAsyncEffect((isCancelled) => {
		void loadConnectionSettings().then((connections) => { if (!isCancelled()) setSettings(connections); }).catch(() => { if (!isCancelled()) setError("Model settings could not be loaded."); });
	}, [conversation.id]);

	const selectedProfile = settings?.profiles.find((profile) => profile.id === selected?.connectionProfileId);

	const updateSelection = async (profile: ConnectionProfile, modelId: string) => {
		setPending(true);
		setError(null);
		setNotice(null);
		try {
			await commitConversationModel({
				conversation,
				connectionProfileId: profile.id,
				modelId,
				reconciliation: { adoptSnapshot: onConversationChange, showNotice: setError },
				onCommitted: () => {
					const queryKey = ["generation-settings", conversation.id];
					void client.cancelQueries({ queryKey });
					client.setQueryData<ConversationGenerationSettings>(queryKey, (current) => current && { ...current, connectionProfileId: profile.id, modelId });
					void client.invalidateQueries({ queryKey });
					setNotice(`Model set to ${profile.displayName} / ${modelId}.`);
				},
				onUnavailable: () => setError(MODEL_SELECTION_UNAVAILABLE_NOTICE),
			});
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="model-selector">
			<ProfileModelPicker
			settings={settings}
			onSettingsChange={setSettings}
			selected={selected}
			onSelect={updateSelection}
			disabled={disabled || pending}
			side="top"
			emptyLabel="Add a connection in Connections to choose a model."
		>
				<button className="model-selector-trigger" type="button" disabled={disabled || pending || selected === null}
					aria-label={`Model: ${selected?.modelId || "Choose a model"}`}
					aria-describedby={disabledReason ? reasonId : undefined}
					title={disabledReason ?? (selectedProfile ? `${selectedProfile.displayName} / ${selected?.modelId}` : "Choose a model")}>
					<span>{selected === null ? "Loading model…" : selectedProfile === undefined ? "Choose a model" : selected.modelId || "Choose a model"}</span>
					<ChevronDown aria-hidden="true" />
				</button>
			</ProfileModelPicker>
			{disabledReason && <small id={reasonId} className="model-selector-note">{disabledReason}</small>}
			{(error !== null || generation.isError) && <small className="model-selector-note is-error" role="alert">{error ?? "Model settings could not be loaded."}</small>}
			{notice !== null && <span className="sr-only" role="status">{notice}</span>}
		</div>
	);
}
