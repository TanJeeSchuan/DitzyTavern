import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { loadConversationGenerationSettings, type ConversationSummary } from "./conversation";
import { commitConversationModel, MODEL_SELECTION_UNAVAILABLE_NOTICE } from "./model-selection-command";
import { loadConnectionSettings, type ConnectionProfile, type ConnectionSettings } from "./connection-settings";
import { useAsyncEffect } from "./lib/use-async";
import { ProfileModelPicker, type ProfileModelChoice } from "./ProfileModelPicker";

export function ModelSelector({ conversation, disabled = false, disabledReason, onConversationChange, onSelectionChange }: {
	conversation: ConversationSummary;
	disabled?: boolean;
	disabledReason?: string;
	onConversationChange: (conversation: ConversationSummary) => void;
	onSelectionChange: (connectionProfileId: number, modelId: string) => void;
}) {
	const [selected, setSelected] = useState<ProfileModelChoice | null>(null);
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reasonId = useId();

	useAsyncEffect((isCancelled) => {
		void Promise.all([loadConversationGenerationSettings(conversation.id), loadConnectionSettings()])
			.then(([generation, connections]) => {
				if (isCancelled()) return;
				setSelected({ connectionProfileId: generation.connectionProfileId, modelId: generation.modelId });
				setSettings(connections);
			})
			.catch(() => {
				if (!isCancelled()) setError("Model settings could not be loaded.");
			});
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
					setSelected({ connectionProfileId: profile.id, modelId });
					onSelectionChange(profile.id, modelId);
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
			<ProfileModelPicker settings={settings} onSettingsChange={setSettings} selected={selected} onSelect={updateSelection} disabled={disabled || pending} side="top" emptyLabel="Add a connection in Connections to choose a model.">
				<button className="model-selector-trigger" type="button" disabled={disabled || pending || selected === null}
					aria-label={`Model: ${selected?.modelId || "Choose a model"}`}
					aria-describedby={disabledReason ? reasonId : undefined}
					title={disabledReason ?? (selectedProfile ? `${selectedProfile.displayName} / ${selected?.modelId}` : "Choose a model")}>
					<span>{selected === null ? "Loading model…" : selectedProfile === undefined ? "Choose a model" : selected.modelId || "Choose a model"}</span>
					<ChevronDown aria-hidden="true" />
				</button>
			</ProfileModelPicker>
			{disabledReason && <small id={reasonId} className="model-selector-note">{disabledReason}</small>}
			{error !== null && <small className="model-selector-note is-error" role="alert">{error}</small>}
			{notice !== null && <span className="sr-only" role="status">{notice}</span>}
		</div>
	);
}
