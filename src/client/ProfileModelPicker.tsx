import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem } from "@/components/ui/command";
import { Star } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { loadConnectionSettings, saveConnectionCommand, type ConnectionProfile, type ConnectionSettings } from "./connection-settings";
import { commitModelId, modelSuggestions, togglePinnedModel } from "./model-selection";

export interface ProfileModelChoice {
	connectionProfileId: number | null;
	modelId: string;
}

export function ProfileModelPicker({ settings, onSettingsChange, accepts, selected, onSelect, disabled = false, side = "bottom", emptyLabel, children }: {
	settings: ConnectionSettings | null;
	onSettingsChange: (settings: ConnectionSettings) => void;
	accepts: (profile: ConnectionProfile) => boolean;
	selected: ProfileModelChoice | null;
	onSelect: (profile: ConnectionProfile, modelId: string) => Promise<void> | void;
	disabled?: boolean;
	side?: "top" | "bottom";
	emptyLabel: string;
	children: ReactElement;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const profiles = useMemo(() => (settings?.profiles ?? []).filter(accepts), [settings, accepts]);
	const groups = useMemo(() => profiles.map((profile) => ({
		profile,
		models: modelSuggestions({ query, discoveryCatalog: profile.discoveryCatalog, pinnedModels: profile.pinnedModels }),
	})).filter(({ models }) => models.length > 0), [profiles, query]);
	const busy = disabled || pending;
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const choose = async (profile: ConnectionProfile, submitted: string) => {
		const modelId = commitModelId(submitted);
		if (busy || modelId === null) return;
		if (selected?.connectionProfileId !== profile.id || selected.modelId !== modelId) await onSelect(profile, modelId);
		setQuery("");
		setOpen(false);
	};

	const togglePin = async (profile: ConnectionProfile, modelId: string) => {
		if (busy || settings === null) return;
		setPending(true);
		setError(null);
		setNotice(null);
		const pinnedModels = togglePinnedModel(profile.pinnedModels, modelId);
		try {
			const result = await saveConnectionCommand({ type: "set-pinned-models", expectedRevision: settings.revision, profileId: profile.id, pinnedModels });
			if (result.outcome === "applied") {
				onSettingsChange(result.settings);
				setNotice(pinnedModels.includes(modelId) ? `${modelId} pinned.` : `${modelId} unpinned.`);
			} else if (result.outcome === "conflict") {
				onSettingsChange(result.currentSettings);
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
		<Popover open={open} onOpenChange={(next) => {
			setOpen(next);
			if (next) {
				setQuery("");
				setError(null);
				void loadConnectionSettings().then(onSettingsChange).catch(() => setError("Connection Settings could not be loaded."));
			}
		}}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent side={side} align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
				<Command shouldFilter={false}>
					<CommandInput aria-label="Search models" value={query} disabled={busy} autoFocus placeholder="Search or enter a model ID" onValueChange={setQuery} />
					<CommandList aria-label="Model choices">
						{groups.map(({ profile, models }) => <CommandGroup heading={profile.displayName} key={profile.id}>
							{models.map((modelId) => {
								const isPinned = profile.pinnedModels.includes(modelId);
								return <div className="model-selector-option" key={modelId}>
									<CommandItem value={`${profile.id}/${modelId}`} disabled={busy} onSelect={() => void choose(profile, modelId)}>
										<span className="truncate" title={modelId}>{modelId}</span>
										{profile.id === selected?.connectionProfileId && modelId === selected.modelId && <span className="sr-only">Current model</span>}
									</CommandItem>
									<button type="button" className="model-pin-button" aria-label={`${isPinned ? "Unstar" : "Star"} ${modelId} in ${profile.displayName}`} disabled={busy} onClick={() => void togglePin(profile, modelId)}>
										<Star aria-hidden="true" fill={isPinned ? "currentColor" : "none"} />
									</button>
								</div>;
							})}
						</CommandGroup>)}
						{settings !== null && profiles.length === 0 && <p className="model-selector-empty">{emptyLabel}</p>}
						{profiles.length > 0 && groups.length === 0 && <p className="model-selector-empty">Search or enter a model ID to choose it for a connection.</p>}
						{error !== null && <p className="model-selector-empty is-error" role="alert">{error}</p>}
					</CommandList>
				</Command>
				{notice !== null && <span className="sr-only" role="status">{notice}</span>}
			</PopoverContent>
		</Popover>
	);
}
