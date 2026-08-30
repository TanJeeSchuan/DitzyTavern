import { ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import {
	loadConnectionSettings,
	saveConnectionCommand,
	type ConnectionSettings,
} from "./connection-settings";
import { useAsyncEffect } from "./lib/use-async";
import { modelSuggestions, commitModelId, togglePinnedModel } from "./model-selection";

// The wording this surface shows whenever the model-selection command could
// not be saved; the runner owns when each notice appears.
const MODEL_SELECTION_UNAVAILABLE_NOTICE = "The model selection could not be saved.";

export function ModelSelector({
	conversation,
	disabled = false,
	onConversationChange,
}: {
	conversation: ConversationSummary;
	disabled?: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const [generation, setGeneration] = useState<ConversationGenerationSettings | null>(null);
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	useAsyncEffect((isCancelled) => {
		void Promise.all([
			loadConversationGenerationSettings(conversation.id),
			loadConnectionSettings(),
		])
			.then(([loadedGeneration, loadedSettings]) => {
				if (isCancelled()) return;
				setGeneration(loadedGeneration);
				setSettings(loadedSettings);
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
			const target = event.target;
			if (target instanceof Node && rootRef.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	const activeProfile = settings?.profiles.find(
		(profile) => profile.id === settings.activeProfileId,
	);
	const suggestions = useMemo(() => {
		if (activeProfile === undefined) return [];
		return modelSuggestions({
			query,
			discoveryCatalog: activeProfile.discoveryCatalog,
			pinnedModels: activeProfile.pinnedModels,
		});
	}, [activeProfile, query]);

	const updateGeneration = async (modelId: string) => {
		if (disabled) return;
		const committed = commitModelId(modelId);
		if (committed === null || generation === null || committed === generation.modelId) {
			if (committed !== null) setQuery("");
			setOpen(false);
			return;
		}
		setPending(true);
		setError(null);
		setNotice(null);
		const showUnreachable = () => setError(MODEL_SELECTION_UNAVAILABLE_NOTICE);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversation.id, expectedRevision, {
						type: "update-generation-settings",
						settings: { ...generation, modelId: committed },
					}),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setError,
				},
				notices: {
					conflict: "This Conversation changed elsewhere. Its model settings were reloaded.",
					notFound: MODEL_SELECTION_UNAVAILABLE_NOTICE,
					unreachable: MODEL_SELECTION_UNAVAILABLE_NOTICE,
				},
				callbacks: {
					onApplied: () => {
						setGeneration({ ...generation, modelId: committed });
						setNotice(`Model set to ${committed}.`);
						setQuery("");
						setOpen(false);
					},
					onNotPlayable: showUnreachable,
					onNotRemovable: showUnreachable,
				},
			});
		} finally {
			setPending(false);
		}
	};

	const togglePin = async (modelId: string) => {
		if (disabled) return;
		if (settings === null || activeProfile === undefined) return;
		setPending(true);
		setError(null);
		setNotice(null);
		const nextPins = togglePinnedModel(activeProfile.pinnedModels, modelId);
		try {
			const result = await saveConnectionCommand({
				type: "set-pinned-models",
				expectedRevision: settings.revision,
				profileId: activeProfile.id,
				pinnedModels: nextPins,
			});
			if (result.outcome === "applied") {
				setSettings(result.settings);
				setNotice(nextPins.includes(modelId) ? `${modelId} pinned.` : `${modelId} unpinned.`);
			} else if (result.outcome === "conflict") {
				setSettings(result.currentSettings);
				setError("Connection Settings changed elsewhere; pins were not changed.");
			} else if (result.outcome === "invalid") {
				setError(result.reason);
			} else {
				setError("The active connection could not be reached.");
			}
		} catch {
			setError("The active connection could not be reached.");
		} finally {
			setPending(false);
		}
	};

	if (generation === null) return null;

	return (
		<div className="model-selector" ref={rootRef}>
			<label htmlFor={`model-selector-${conversation.id}`}>Model</label>
			<button
				id={`model-selector-${conversation.id}`}
				className="model-selector-trigger"
				type="button"
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled || pending}
				onClick={() => {
					setOpen((current) => !current);
					setQuery("");
					void loadConnectionSettings().then(setSettings).catch(() => setError("Connection Settings could not be loaded."));
				}}
			>
				<span>{generation.modelId}</span>
				<ChevronDown aria-hidden="true" />
			</button>
			{open && (
				<div className="model-selector-menu">
					<input
						className="field-input"
						aria-label="Search models"
						value={query}
						disabled={disabled}
						autoFocus
						placeholder="Search or enter any model ID"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void updateGeneration(query);
							}
						}}
					/>
					<div className="model-selector-options" role="listbox" aria-label="Model choices">
						{suggestions.map((modelId) => (
							<div className="model-selector-option" key={modelId} role="option" aria-selected={modelId === generation.modelId}>
								<button type="button" disabled={disabled || pending} onClick={() => void updateGeneration(modelId)}>{modelId}</button>
								<button
									type="button"
									className="model-pin-button"
									aria-label={`${activeProfile?.pinnedModels.includes(modelId) ? "Unstar" : "Star"} ${modelId}`}
									disabled={disabled || pending}
									onClick={(event) => {
										event.stopPropagation();
										void togglePin(modelId);
									}}
								>
									<Star aria-hidden="true" fill={activeProfile?.pinnedModels.includes(modelId) ? "currentColor" : "none"} />
								</button>
							</div>
						))}
						{suggestions.length === 0 && <p className="model-selector-empty">No pinned or discovered models match. Press Enter to use the typed ID.</p>}
					</div>
				</div>
			)}
			{(notice !== null || error !== null) && <small className={error === null ? "model-selector-note" : "model-selector-note is-error"} role={error === null ? "status" : "alert"}>{error ?? notice}</small>}
		</div>
	);
}
