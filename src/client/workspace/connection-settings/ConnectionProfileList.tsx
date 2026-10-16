import { ChevronRight, Copy, Ellipsis, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CONNECTION_ADAPTER_LABELS, isEmbeddingsProfile, type ConnectionProfile, type ConnectionSettings } from "../../connection-settings";
import type { SemanticTriggerSettings } from "../../semantic-trigger-settings";
import type { BoxDecisionSettings, BoxDescriptor, BoxId } from "../../../shared/contract/box";
import type { ConnectionSettingsController } from "./useConnectionSettingsController";

/** @approved The Decision Model settings the Connections list previews. */
type SettingsPreview<S> = { settings: S | null; loading: boolean };

const rowClass = "flex w-full min-w-0 flex-col gap-0.5 px-4 py-3 text-left";

const listOf = (items: readonly string[], conjunction: "and" | "or") => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;

export function ConnectionProfileList({ controller, settings, activeProfileId, semanticTriggers, onOpenSemanticTrigger, boxDecisions, onOpenBoxDecision }: {
	controller: ConnectionSettingsController;
	settings: ConnectionSettings;
	activeProfileId: number | null;
	semanticTriggers: SettingsPreview<SemanticTriggerSettings>;
	onOpenSemanticTrigger: () => void;
	boxDecisions: readonly { box: BoxId; label: string; decision: NonNullable<BoxDescriptor["decision"]>; editor: SettingsPreview<BoxDecisionSettings> }[];
	onOpenBoxDecision: (box: BoxId) => void;
}) {
	const boxes = boxDecisions.map(({ label }) => label);
	const roles = ["Semantic Triggers", ...boxes];
	const pending = controller.pendingDeletionProfile;
	const feedback = controller.error ?? controller.notice;
	const embeddingsPreset = controller.presets.find((preset) => preset.profile.apiFormat === "embeddings");
	return (
		<div className="grid grid-cols-1 gap-8">
			<section aria-labelledby="connections-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="connections-title">Chat models</h3>
					<PresetMenu controller={controller} apiFormat="chat-completions" label="Add chat connection" />
				</div>
				<p>Write Messages and run Box tasks.</p>
				<ProfileRows label="Chat connections" profiles={settings.profiles.filter((profile) => profile.apiFormat === "chat-completions")} controller={controller}
					describe={(profile) => CONNECTION_ADAPTER_LABELS[profile.adapter]}
					badge={(profile) => profile.id === activeProfileId ? "This chat" : null}
					empty={<EmptyProfiles title="No connections yet">Add one to start generating. Chats and imports work without it.</EmptyProfiles>} />
			</section>

			<section aria-labelledby="embeddings-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="embeddings-title">Embeddings</h3>
					{embeddingsPreset && (
						<Button type="button" size="sm" variant="outline" aria-label="Add embeddings endpoint" onClick={() => controller.choosePreset(embeddingsPreset)}>
							<Plus aria-hidden="true" /> Add
						</Button>
					)}
				</div>
				<p>Find related text. Each Box selects its embedding model in its settings.</p>
				<ProfileRows label="Embeddings endpoints" profiles={settings.profiles.filter(isEmbeddingsProfile)} controller={controller}
					describe={(profile) => hostOf(profile.requestUrl)}
					badge={() => null}
					empty={<EmptyProfiles title="No endpoints yet">Embedding tasks stay off until you add an endpoint.</EmptyProfiles>} />
				{feedback !== null && <p className={`mt-3 text-xs ${controller.error ? "text-destructive" : "text-muted-foreground"}`} role={controller.error ? "alert" : "status"}>{feedback}</p>}
			</section>

			<section aria-labelledby="decisions-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="decisions-title">Decision Models</h3>
					<PresetMenu controller={controller} apiFormat="system-one" label="Add Decision Model connection" />
				</div>
				<p>Judge Semantic Triggers and read passages for {listOf(boxes, "and")}. Each role chooses its own model.</p>
				<ProfileRows
				label="Decision Model connections"
				profiles={settings.profiles.filter(profile => profile.apiFormat === "system-one")}
				controller={controller}
				describe={profile => hostOf(profile.requestUrl)}
				badge={() => null}
				empty={
					<EmptyProfiles title="No Decision Models yet">Add a System One endpoint, then select it in {listOf(roles, "or")}.</EmptyProfiles>
				}
			/>
			</section>
			<section aria-labelledby="semanticTriggers-title">
				<h3 id="semanticTriggers-title">Semantic Triggers</h3>
				<p>Chooses the Decision Model and threshold for Lore matching.</p>
				<DecisionSummary preview={semanticTriggers} name="Semantic Trigger" onOpen={onOpenSemanticTrigger}
					describe={(settings) => settings.decisionProfileId === null ? "Keyword-only matching" : `Decision Model · threshold ${settings.triggerThreshold.toFixed(2)}`} />
			</section>
			{boxDecisions.map(({ box, label, decision, editor }) => <section key={box} aria-labelledby={`${box}-title`}>
				<h3 id={`${box}-title`}>{label}</h3>
				<p>{decision.summary}</p>
				<DecisionSummary preview={editor} name={label} onOpen={() => onOpenBoxDecision(box)}
					describe={(settings) => settings.decisionProfileId === null ? decision.off : "Decision Model"} />
			</section>)}

			<Dialog open={pending !== undefined} onOpenChange={(open) => { if (!open) controller.setPendingDeletionProfileId(null); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete {pending?.displayName}?</DialogTitle>
						<DialogDescription>
							{pending?.apiFormat === "system-one"
								? `${listOf(roles, "and")} using it will need another Decision Model.`
								: pending?.apiFormat === "embeddings"
									? "Tasks using this endpoint stop until you choose another embedding model."
									: "Chats using it will need another connection before they can generate."}
						</DialogDescription>
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

function DecisionSummary<S extends { decisionModel: string }>({ preview, name, describe, onOpen }: {
	preview: SettingsPreview<S>;
	name: string;
	describe: (settings: S) => string;
	onOpen: () => void;
}) {
	const { settings } = preview;
	return (
		<button type="button" className="flex w-full items-center justify-between gap-3 rounded-xl border border-border text-left hover:bg-muted/50" onClick={onOpen}>
			<span className={rowClass}>
				{settings === null ? <>
					<span className="text-[0.86rem] font-semibold">{preview.loading ? "Loading…" : "Unavailable"}</span>
					<span className="text-xs text-muted-foreground">{preview.loading ? `Reading ${name} settings` : "Open to retry"}</span>
				</> : <>
					<span className="truncate font-mono text-[0.8rem] font-semibold">{settings.decisionModel || "Off"}</span>
					<span className="truncate text-xs text-muted-foreground">{describe(settings)}</span>
				</>}
			</span>
			<ChevronRight className="mr-4 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		</button>
	);
}

const hostOf = (url: string) => URL.canParse(url) ? new URL(url).host : url;

function PresetMenu({ controller, apiFormat, label }: { controller: ConnectionSettingsController; apiFormat: ConnectionProfile["apiFormat"]; label: string }) {
	return <DropdownMenu>
		<DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" aria-label={label}><Plus aria-hidden="true" /> Add</Button></DropdownMenuTrigger>
		<DropdownMenuContent align="end" className="w-64">
			{controller.presets
				.filter(preset => preset.profile.apiFormat === apiFormat)
				.map(preset => (
					<DropdownMenuItem key={preset.id} className="flex-col items-start gap-0.5" onSelect={() => controller.choosePreset(preset)}>
						<span className="font-medium">{preset.label}</span>
						<span className="text-xs text-muted-foreground">{preset.description}</span>
					</DropdownMenuItem>
				))}
		</DropdownMenuContent>
	</DropdownMenu>;
}
