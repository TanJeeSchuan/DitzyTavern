import { ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadConversationGenerationSettings, type ConversationSummary } from "./conversation";
import { commitConversationModel, MODEL_SELECTION_UNAVAILABLE_NOTICE } from "./model-selection-command";
import { loadConnectionSettings, saveConnectionCommand, type ConnectionProfile, type ConnectionSettings } from "./connection-settings";
import { useAsyncEffect } from "./lib/use-async";
import { commitModelId, modelSuggestions, togglePinnedModel } from "./model-selection";

interface SelectedModel {
	connectionProfileId: number | null;
	modelId: string;
}

export function ModelSelector({ conversation, disabled = false, onConversationChange, onSelectionChange }: {
	conversation: ConversationSummary;
	disabled?: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	onSelectionChange: (connectionProfileId: number, modelId: string) => void;
}) {
	const [selected, setSelected] = useState<SelectedModel | null>(null);
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

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

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
			setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	const groups = useMemo(() => (settings?.profiles ?? []).map((profile) => ({
		profile,
		models: modelSuggestions({ query, discoveryCatalog: profile.discoveryCatalog, pinnedModels: profile.pinnedModels }),
	})).filter(({ models }) => models.length > 0), [settings, query]);
	const selectedProfile = settings?.profiles.find((profile) => profile.id === selected?.connectionProfileId);

	const updateSelection = async (profile: ConnectionProfile, submitted: string) => {
		if (disabled) return;
		const modelId = commitModelId(submitted);
		if (modelId === null) return;
		if (selected?.connectionProfileId === profile.id && selected.modelId === modelId) {
			setQuery("");
			setOpen(false);
			return;
		}
		setPending(true);
		setError(null);
		setNotice(null);
		const showUnavailable = () => setError(MODEL_SELECTION_UNAVAILABLE_NOTICE);
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
					setQuery("");
					setOpen(false);
				},
				onUnavailable: showUnavailable,
			});
		} finally {
			setPending(false);
		}
	};

	const togglePin = async (profile: ConnectionProfile, modelId: string) => {
		if (disabled || settings === null) return;
		setPending(true);
		setError(null);
		setNotice(null);
		const pinnedModels = togglePinnedModel(profile.pinnedModels, modelId);
		try {
			const result = await saveConnectionCommand({
				type: "set-pinned-models",
				expectedRevision: settings.revision,
				profileId: profile.id,
				pinnedModels,
			});
			if (result.outcome === "applied") {
				setSettings(result.settings);
				setNotice(pinnedModels.includes(modelId) ? `${modelId} pinned.` : `${modelId} unpinned.`);
			} else if (result.outcome === "conflict") {
				setSettings(result.currentSettings);
				setError("Connection Settings changed elsewhere; pins were not changed.");
			} else if (result.outcome === "invalid") {
				setError(result.reason);
			} else {
				setError("The connection could not be reached.");
			}
		} catch {
			setError("The connection could not be reached.");
		} finally {
			setPending(false);
		}
	};

	if (selected === null) return null;

	return (
		<div className="model-selector" ref={rootRef}>
			<label htmlFor={`model-selector-${conversation.id}`}>Model connection</label>
			<button id={`model-selector-${conversation.id}`} className="model-selector-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} disabled={disabled || pending} onClick={() => {
				setOpen((current) => !current);
				setQuery("");
				void loadConnectionSettings().then(setSettings).catch(() => setError("Connection Settings could not be loaded."));
			}}>
				<span><small>{selectedProfile?.displayName ?? "Choose a connection"}</small><strong>{selectedProfile === undefined ? "Choose a model" : selected.modelId}</strong></span>
				<ChevronDown aria-hidden="true" />
			</button>
			{open && <div className="model-selector-menu">
				<input className="field-input" aria-label="Search models" value={query} disabled={disabled} autoFocus placeholder="Search or enter any model ID" onChange={(event) => setQuery(event.target.value)} />
				<div className="model-selector-options" role="listbox" aria-label="Model choices">
					{groups.map(({ profile, models }) => <section className="model-selector-group" key={profile.id} aria-label={profile.displayName}>
						<h4>{profile.displayName}</h4>
						{models.map((modelId) => {
							const isSelected = profile.id === selected.connectionProfileId && modelId === selected.modelId;
							const isPinned = profile.pinnedModels.includes(modelId);
							return <div className="model-selector-option" key={modelId} role="option" aria-selected={isSelected}>
								<button type="button" disabled={disabled || pending} onClick={() => void updateSelection(profile, modelId)}>{modelId}</button>
								<button type="button" className="model-pin-button" aria-label={`${isPinned ? "Unstar" : "Star"} ${modelId} in ${profile.displayName}`} disabled={disabled || pending} onClick={(event) => {
									event.stopPropagation();
									void togglePin(profile, modelId);
								}}><Star aria-hidden="true" fill={isPinned ? "currentColor" : "none"} /></button>
							</div>;
						})}
					</section>)}
					{settings?.profiles.length === 0 && <p className="model-selector-empty">Add a connection before choosing a model.</p>}
					{settings !== null && settings.profiles.length > 0 && groups.length === 0 && <p className="model-selector-empty">No pinned models yet. Search or enter a model ID to choose it for a connection.</p>}
				</div>
			</div>}
			{(notice !== null || error !== null) && <small className={error === null ? "model-selector-note" : "model-selector-note is-error"} role={error === null ? "status" : "alert"}>{error ?? notice}</small>}
		</div>
	);
}
