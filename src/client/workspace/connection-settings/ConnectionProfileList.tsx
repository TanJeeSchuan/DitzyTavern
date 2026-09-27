import { ChevronRight, Copy, Ellipsis, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CONNECTION_ADAPTER_LABELS, type ConnectionSettings } from "../../connection-settings";
import type { EmbeddingSettingsController } from "../EmbeddingSettingsEditor";
import type { TypesafeSettingsController } from "../TypesafeSettingsEditor";
import type { ConnectionSettingsController } from "./useConnectionSettingsController";

const rowClass = "flex w-full min-w-0 flex-col gap-0.5 px-4 py-3 text-left";

export function ConnectionProfileList({ controller, settings, activeProfileId, embedding, onOpenEmbedding, typesafe, onOpenTypesafe }: {
	controller: ConnectionSettingsController;
	settings: ConnectionSettings;
	activeProfileId: number | null;
	embedding: EmbeddingSettingsController;
	onOpenEmbedding: () => void;
	typesafe: TypesafeSettingsController;
	onOpenTypesafe: () => void;
}) {
	const pending = controller.pendingDeletionProfile;
	const feedback = controller.error ?? controller.notice;
	return (
		<div className="grid gap-8">
			<section aria-labelledby="connections-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="connections-title">Generation</h3>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline"><Plus aria-hidden="true" /> Add</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-64">
							{controller.presets.map((preset) => (
								<DropdownMenuItem key={preset.id} className="flex-col items-start gap-0.5" onSelect={() => controller.choosePreset(preset)}>
									<span className="font-medium">{preset.label}</span>
									<span className="text-xs text-muted-foreground">{preset.description}</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<p>Model endpoints any Chat can generate with.</p>
				{settings.profiles.length === 0 ? (
					<div className="grid gap-1 rounded-xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
						<strong className="text-sm text-foreground">No connections yet</strong>
						Add one to start generating. Chats and imports work without it.
					</div>
				) : (
					<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" aria-label="Connections">
						{settings.profiles.map((profile) => (
							<li key={profile.id} className="flex items-center hover:bg-muted/50">
								<button type="button" className={rowClass} onClick={() => controller.chooseProfile(profile)}>
									<span className="flex items-center gap-2 text-[0.86rem] font-semibold">
										<span className="truncate">{profile.displayName}</span>
										{profile.id === activeProfileId && <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[0.68rem] font-medium text-primary">This chat</span>}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{CONNECTION_ADAPTER_LABELS[profile.adapter]}
										{profile.pinnedModels[0] !== undefined && <> · <span className="font-mono">{profile.pinnedModels[0]}</span></>}
										{" · "}{profile.credentialConfigured ? "Key saved" : <span className="text-destructive">No key</span>}
									</span>
								</button>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" size="icon-sm" variant="ghost" className="mr-2 text-muted-foreground" aria-label={`More actions for ${profile.displayName}`}><Ellipsis aria-hidden="true" /></Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem onSelect={() => controller.duplicateProfile(profile)}><Copy aria-hidden="true" /> Duplicate</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onSelect={() => controller.requestProfileDeletion(profile)}><Trash2 aria-hidden="true" /> Delete</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</li>
						))}
					</ul>
				)}
				{feedback !== null && <p className={`mt-3 text-xs ${controller.error ? "text-destructive" : "text-muted-foreground"}`} role={controller.error ? "alert" : "status"}>{feedback}</p>}
			</section>

			<section aria-labelledby="typesafe-title">
				<h3 id="typesafe-title">Typesafe Jev</h3>
				<p>Judges Memory and matches Lore Entries by their Semantic Triggers.</p>
				<button type="button" className="flex w-full items-center justify-between gap-3 rounded-xl border border-border text-left hover:bg-muted/50" onClick={onOpenTypesafe}>
					<TypesafeSummary typesafe={typesafe} />
					<ChevronRight className="mr-4 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</section>

			<section aria-labelledby="memory-embeddings-title">
				<h3 id="memory-embeddings-title">Memory recall embeddings</h3>
				<p>An embedding service that shortlists saved Memories for recall.</p>
				<button type="button" className="flex w-full items-center justify-between gap-3 rounded-xl border border-border text-left hover:bg-muted/50" onClick={onOpenEmbedding}>
					<EmbeddingSummary embedding={embedding} />
					<ChevronRight className="mr-4 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</section>

			<Dialog open={pending !== undefined} onOpenChange={(open) => { if (!open) controller.setPendingDeletionProfileId(null); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete {pending?.displayName}?</DialogTitle>
						<DialogDescription>Chats using it will need another connection before they can generate.</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => controller.setPendingDeletionProfileId(null)}>Cancel</Button>
						<Button type="button" variant="destructive" onClick={() => void controller.deletePendingProfile()}><Trash2 aria-hidden="true" /> Delete</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function EmbeddingSummary({ embedding }: { embedding: EmbeddingSettingsController }) {
	const { settings } = embedding;
	if (settings === null) return <span className={rowClass}><span className="text-[0.86rem] font-semibold">{embedding.loading ? "Loading…" : "Unavailable"}</span><span className="text-xs text-muted-foreground">{embedding.loading ? "Reading embedding settings" : "Open to retry"}</span></span>;
	const configured = settings.endpoint.length > 0 && settings.model.length > 0;
	return (
		<span className={rowClass}>
			<span className={`truncate text-[0.86rem] font-semibold ${configured ? "font-mono text-[0.8rem]" : ""}`}>{configured ? settings.model : "Off"}</span>
			<span className="truncate text-xs text-muted-foreground">{configured ? hostOf(settings.endpoint) : "Memory recall off"}</span>
		</span>
	);
}

function TypesafeSummary({ typesafe }: { typesafe: TypesafeSettingsController }) {
	const { settings } = typesafe;
	if (settings === null) return <span className={rowClass}><span className="text-[0.86rem] font-semibold">{typesafe.loading ? "Loading…" : "Unavailable"}</span><span className="text-xs text-muted-foreground">{typesafe.loading ? "Reading Typesafe settings" : "Open to retry"}</span></span>;
	return (
		<span className={rowClass}>
			<span className="truncate font-mono text-[0.8rem] font-semibold">{settings.jevModel}</span>
			<span className="truncate text-xs text-muted-foreground">{settings.credentialConfigured ? `Semantic Triggers ${settings.loreTriggerMode === "jev" ? `by Jev · threshold ${settings.loreTriggerThreshold.toFixed(2)}` : "off"}` : "API key needed"}</span>
		</span>
	);
}

const hostOf = (endpoint: string) => URL.canParse(endpoint) ? new URL(endpoint).host : endpoint;
