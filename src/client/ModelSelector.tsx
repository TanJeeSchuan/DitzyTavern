import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem } from "@/components/ui/command";
import { ChevronDown, Star } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { loadConversationGenerationSettings, type ConversationSummary } from "./conversation";
import { commitConversationModel, MODEL_SELECTION_UNAVAILABLE_NOTICE } from "./model-selection-command";
import { loadConnectionSettings, saveConnectionCommand, type ConnectionProfile, type ConnectionSettings } from "./connection-settings";
import { useAsyncEffect } from "./lib/use-async";
import { commitModelId, modelSuggestions, togglePinnedModel } from "./model-selection";

interface SelectedModel {
	connectionProfileId: number | null;
	modelId: string;
}

export function ModelSelector({ conversation, disabled = false, disabledReason, onConversationChange, onSelectionChange }: {
	conversation: ConversationSummary;
	disabled?: boolean;
	disabledReason?: string;
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

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

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

	return (
		<div className="model-selector">
			<Popover open={open} onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setQuery("");
					void loadConnectionSettings().then(setSettings).catch(() => setError("Connection Settings could not be loaded."));
				}
			}}>
				<PopoverTrigger asChild>
					<button className="model-selector-trigger" type="button" disabled={disabled || pending || selected === null}
						aria-label={`Model: ${selected?.modelId || "Choose a model"}`}
						aria-describedby={disabledReason ? reasonId : undefined}
						title={disabledReason ?? (selectedProfile ? `${selectedProfile.displayName} / ${selected?.modelId}` : "Choose a model")}>
						<span>{selected === null ? "Loading model…" : selectedProfile === undefined ? "Choose a model" : selected.modelId || "Choose a model"}</span>
						<ChevronDown aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContent side="top" align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
					<Command shouldFilter={false}>
						<CommandInput aria-label="Search models" value={query} disabled={pending} autoFocus placeholder="Search or enter a model ID" onValueChange={setQuery} />
						<CommandList aria-label="Model choices">
							{groups.map(({ profile, models }) => <CommandGroup heading={profile.displayName} key={profile.id}>
								{models.map((modelId) => {
									const isPinned = profile.pinnedModels.includes(modelId);
									return <div className="model-selector-option" key={modelId}>
										<CommandItem value={`${profile.id}/${modelId}`} disabled={pending} onSelect={() => void updateSelection(profile, modelId)}>
											<span className="truncate" title={modelId}>{modelId}</span>
											{profile.id === selected?.connectionProfileId && modelId === selected.modelId && <span className="sr-only">Current model</span>}
										</CommandItem>
										<button type="button" className="model-pin-button" aria-label={`${isPinned ? "Unstar" : "Star"} ${modelId} in ${profile.displayName}`} disabled={pending} onClick={() => void togglePin(profile, modelId)}>
											<Star aria-hidden="true" fill={isPinned ? "currentColor" : "none"} />
										</button>
									</div>;
								})}
							</CommandGroup>)}
							{settings?.profiles.length === 0 && <p className="model-selector-empty">Add a connection in Connections to choose a model.</p>}
							{settings !== null && settings.profiles.length > 0 && groups.length === 0 && <p className="model-selector-empty">Search or enter a model ID to choose it for a connection.</p>}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{disabledReason && <small id={reasonId} className="model-selector-note">{disabledReason}</small>}
			{error !== null && <small className="model-selector-note is-error" role="alert">{error}</small>}
			{notice !== null && <span className="sr-only" role="status">{notice}</span>}
		</div>
	);
}
