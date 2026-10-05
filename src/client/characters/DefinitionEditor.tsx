import { ArrowLeft, ImageUp, Plus, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProseEditor, type ProseEditorHandle } from "../editor/ProseEditor";
import { Portrait } from "../story/Portrait";
import { PortraitDialog } from "./PortraitDialog";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { promptChannelLabels } from "../../shared/definition";
import { SaveFooter } from "../SaveFooter";
import { useSaveNavigation } from "../SaveGuard";
import { imageHashes } from "../../shared/image-reference";
import { useImageDraft } from "../lib/use-image-draft";

export const definitionOf = ({ name, prompt, openings, portrait }: { name: string; prompt: PromptChannels; openings: readonly string[]; portrait?: PortraitImage | undefined }): ParticipantDefinition =>
	({ name, prompt, openings: [...openings], portrait });

export const sameDefinition = (a: ParticipantDefinition, b: ParticipantDefinition) => JSON.stringify(a) === JSON.stringify(b);

// ==[HUMAN APPROVED]== Blank Opening cards are editor scratch space; the server rejects blank Openings.
export const submittableDefinition = (draft: ParticipantDefinition): ParticipantDefinition =>
	({ name: draft.name, prompt: draft.prompt, openings: draft.openings.filter((opening) => opening.trim() !== ""), portrait: draft.portrait });

const primaryChannels = [
	["identity", "Appearance, personality, voice…"],
	["scenario", "Where and how the story begins…"],
] as const satisfies readonly (readonly [keyof PromptChannels, string])[];
const moreChannels = ["systemInstruction", "exampleDialogue", "postHistoryInstruction"] as const satisfies readonly (keyof PromptChannels)[];

export function DefinitionEditor({
	draft,
	onDraftChange,
	subtitle,
	actions,
	banner,
	children,
	dirty,
	saving,
	error = null,
	valid = true,
	autoSelectName = false,
	onSave,
	onBack,
}: {
	draft: ParticipantDefinition;
	onDraftChange: (draft: ParticipantDefinition) => void;
	subtitle: ReactNode;
	actions?: ReactNode;
	banner?: ReactNode;
	children?: ReactNode;
	dirty: boolean;
	saving: boolean;
	error?: string | null;
	valid?: boolean;
	autoSelectName?: boolean;
	onSave: () => void;
	onBack: () => void;
}) {
	const navigate = useSaveNavigation();
	const imageDraft = useImageDraft([...Object.values(draft.prompt).flatMap(imageHashes), ...draft.openings.flatMap(imageHashes), ...(draft.portrait === undefined ? [] : [draft.portrait.hash])]);
	const [editingPortrait, setEditingPortrait] = useState(false);
	const [showMore] = useState(() => moreChannels.some((key) => draft.prompt[key] !== ""));
	const identity = useRef<ProseEditorHandle>(null);
	const setChannel = (key: keyof PromptChannels, value: string) => onDraftChange({ ...draft, prompt: { ...draft.prompt, [key]: value } });
	const setPortrait = (portrait: PortraitImage | undefined) => onDraftChange({ ...draft, portrait });
	const setOpenings = (openings: string[]) => onDraftChange({ ...draft, openings });
	const channel = (key: keyof PromptChannels, placeholder?: string) => (
		<div key={key} className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
				<span>{promptChannelLabels[key]}</span>
				{key === "identity" && (
					<Button type="button" size="xs" variant="ghost" disabled={draft.portrait === undefined} onClick={() => draft.portrait !== undefined && identity.current?.insertReference(draft.name || "Portrait", draft.portrait.hash)}>
						<ImageUp aria-hidden="true" /> Insert Portrait
					</Button>
				)}
			</div>
			<ProseEditor ref={key === "identity" ? identity : undefined} className="prose-editor-field" ariaLabel={promptChannelLabels[key]} value={draft.prompt[key]} placeholder={placeholder} onChange={(value) => setChannel(key, value)} />
		</div>
	);

	return (
		<div className="editor-frame">
			<div className="panel-body flex flex-col gap-6">
				<div className="-mx-2 -mt-1 flex items-center gap-1">
					<Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => navigate(onBack)}><ArrowLeft aria-hidden="true" /> Characters</Button>
					<span className="flex-1" />
					{actions}
				</div>
				<div className="flex items-center gap-3">
					<button type="button" className="rounded-[28%] outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={draft.portrait === undefined ? "Add a Portrait" : "Edit the Portrait"} onClick={() => setEditingPortrait(true)}>
						<Portrait name={draft.name} portrait={draft.portrait} size="large" />
					</button>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
					<input
						className="-mx-2 rounded-md bg-transparent px-2 py-1 text-xl font-semibold tracking-[-0.02em] outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
						value={draft.name}
						aria-label="Name"
						placeholder="Name"
						autoFocus={autoSelectName}
						onFocus={autoSelectName ? (event) => event.currentTarget.select() : undefined}
						onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
					/>
					<p className="text-xs text-muted-foreground">{subtitle}</p>
					</div>
				</div>
				<PortraitDialog open={editingPortrait} portrait={draft.portrait} imageDraft={imageDraft} onOpenChange={setEditingPortrait} onChange={setPortrait} />
				{banner}
				<section className="flex flex-col gap-4" aria-label="Prompt">
					{primaryChannels.map(([key, placeholder]) => channel(key, placeholder))}
					<details className="group/more flex flex-col gap-4" open={showMore}>
						<summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">More Prompt channels</summary>
						<div className="mt-4 flex flex-col gap-4">{moreChannels.map((key) => channel(key))}</div>
					</details>
				</section>
				<section className="flex flex-col gap-2" aria-labelledby="definition-openings">
					<div className="flex items-center justify-between">
						<h3 id="definition-openings" className="text-xs font-medium text-muted-foreground">Openings</h3>
						<Button type="button" size="xs" variant="ghost" onClick={() => setOpenings([...draft.openings, ""])}><Plus aria-hidden="true" /> Add</Button>
					</div>
					{draft.openings.length === 0 && <p className="text-xs text-muted-foreground">No Openings.</p>}
					{draft.openings.map((opening, index) => (
						<div key={index} className="group/opening relative">
							<ProseEditor className="prose-editor-field min-h-20" ariaLabel={`Opening ${index + 1}`} value={opening} placeholder="The first Message…" onChange={(value) => setOpenings(draft.openings.map((item, at) => at === index ? value : item))} />
							<Button type="button" size="icon-xs" variant="ghost" className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/opening:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" aria-label={`Remove Opening ${index + 1}`} onClick={() => setOpenings(draft.openings.filter((_, at) => at !== index))}><X aria-hidden="true" /></Button>
						</div>
					))}
				</section>
				{children}
			</div>
			<SaveFooter dirty={dirty} saving={saving} valid={valid && draft.name.trim() !== ""} error={error} onSave={onSave} />
		</div>
	);
}
