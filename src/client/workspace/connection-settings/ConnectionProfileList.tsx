import { ChevronRight, Copy, Ellipsis, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CONNECTION_ADAPTER_LABELS, isEmbeddingsProfile, type ConnectionProfile, type ConnectionSettings } from "../../connection-settings";
import type { TypesafeSettingsController } from "../TypesafeSettingsEditor";
import type { ConnectionSettingsController } from "./useConnectionSettingsController";

const rowClass = "flex w-full min-w-0 flex-col gap-0.5 px-4 py-3 text-left";

export function ConnectionProfileList({ controller, settings, activeProfileId, typesafe, onOpenTypesafe }: {
	controller: ConnectionSettingsController;
	settings: ConnectionSettings;
	activeProfileId: number | null;
	typesafe: TypesafeSettingsController;
	onOpenTypesafe: () => void;
}) {
	const pending = controller.pendingDeletionProfile;
	const feedback = controller.error ?? controller.notice;
	const embeddingsPreset = controller.presets.find((preset) => preset.profile.apiFormat === "embeddings");
	return (
		<div className="grid grid-cols-1 gap-8">
			<section aria-labelledby="connections-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="connections-title">Chat models</h3>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline" aria-label="Add chat connection"><Plus aria-hidden="true" /> Add</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-64">
							{controller.presets.filter((preset) => preset !== embeddingsPreset).map((preset) => (
								<DropdownMenuItem key={preset.id} className="flex-col items-start gap-0.5" onSelect={() => controller.choosePreset(preset)}>
									<span className="font-medium">{preset.label}</span>
									<span className="text-xs text-muted-foreground">{preset.description}</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<p>Write Messages and extract Memories.</p>
				<ProfileRows label="Chat connections" profiles={settings.profiles.filter((profile) => !isEmbeddingsProfile(profile))} controller={controller}
					describe={(profile) => CONNECTION_ADAPTER_LABELS[profile.adapter]}
					badge={(profile) => profile.id === activeProfileId ? "This chat" : null}
					empty={<EmptyProfiles title="No connections yet">Add one to start generating. Chats and imports work without it.</EmptyProfiles>} />
			</section>

			<section aria-labelledby="embeddings-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="embeddings-title">Embeddings</h3>
					{embeddingsPreset && <Button type="button" size="sm" variant="outline" aria-label="Add embeddings endpoint" onClick={() => controller.choosePreset(embeddingsPreset)}><Plus aria-hidden="true" /> Add</Button>}
				</div>
				<p>Shortlist saved Memories for recall. The Memory tab picks which one recall uses.</p>
				<ProfileRows label="Embeddings endpoints" profiles={settings.profiles.filter(isEmbeddingsProfile)} controller={controller}
					describe={(profile) => hostOf(profile.requestUrl)}
					badge={() => null}
					empty={<EmptyProfiles title="No endpoints yet">Memory recall stays off until you add one.</EmptyProfiles>} />
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

			<Dialog open={pending !== undefined} onOpenChange={(open) => { if (!open) controller.setPendingDeletionProfileId(null); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete {pending?.displayName}?</DialogTitle>
						<DialogDescription>{pending?.apiFormat === "embeddings" ? "Memory recall stops until you choose another embedding model." : "Chats using it will need another connection before they can generate."}</DialogDescription>
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

function EmptyProfiles({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="grid gap-1 rounded-xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
			<strong className="text-sm text-foreground">{title}</strong>
			{children}
		</div>
	);
}

function ProfileRows({ label, profiles, controller, describe, badge, empty }: {
	label: string;
	profiles: ConnectionProfile[];
	controller: ConnectionSettingsController;
	describe: (profile: ConnectionProfile) => string;
	badge: (profile: ConnectionProfile) => string | null;
	empty: ReactNode;
}) {
	if (profiles.length === 0) return empty;
	return (
		<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" aria-label={label}>
			{profiles.map((profile) => (
				<li key={profile.id} className="flex items-center hover:bg-muted/50">
					<button type="button" className={rowClass} onClick={() => controller.chooseProfile(profile)}>
						<span className="flex items-center gap-2 text-[0.86rem] font-semibold">
							<span className="truncate">{profile.displayName}</span>
							{badge(profile) !== null && <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[0.68rem] font-medium text-primary">{badge(profile)}</span>}
						</span>
						<span className="truncate text-xs text-muted-foreground">
							{describe(profile)}
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

const hostOf = (url: string) => URL.canParse(url) ? new URL(url).host : url;
