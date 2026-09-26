import { ArrowLeft, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { promptChannelLabels } from "../../shared/definition";
import { SaveFooter } from "../SaveFooter";
import { useSaveNavigation } from "../SaveGuard";

export type Definition = ParticipantDefinition;

export const definitionOf = ({ name, prompt, openings }: { name: string; prompt: PromptChannels; openings: readonly string[] }): Definition =>
	({ name, prompt, openings: [...openings] });

export const sameDefinition = (a: Definition, b: Definition) => JSON.stringify(a) === JSON.stringify(b);

// ==[HUMAN APPROVED]== Blank Opening cards are editor scratch space; the server rejects blank Openings.
export const submittableDefinition = (draft: Definition): Definition =>
	({ ...draft, openings: draft.openings.filter((opening) => opening.trim() !== "") });

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
	draft: Definition;
	onDraftChange: (draft: Definition) => void;
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
	const [showMore] = useState(() => moreChannels.some((key) => draft.prompt[key] !== ""));
	const setChannel = (key: keyof PromptChannels, value: string) => onDraftChange({ ...draft, prompt: { ...draft.prompt, [key]: value } });
	const setOpenings = (openings: string[]) => onDraftChange({ ...draft, openings });
	const channel = (key: keyof PromptChannels, placeholder?: string) => (
		<label key={key} className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
			{promptChannelLabels[key]}
			<Textarea className="min-h-16 bg-(--surface-muted) text-sm text-foreground" value={draft.prompt[key]} placeholder={placeholder} onChange={(event) => setChannel(key, event.target.value)} />
		</label>
	);

	return (
		<div className="editor-frame">
			<div className="panel-body flex flex-col gap-6">
				<div className="-mx-2 -mt-1 flex items-center gap-1">
					<Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => navigate(onBack)}><ArrowLeft aria-hidden="true" /> Characters</Button>
					<span className="flex-1" />
					{actions}
				</div>
				<div className="flex flex-col gap-1">
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
							<Textarea className="min-h-20 bg-(--surface-muted) pr-8 text-sm" value={opening} aria-label={`Opening ${index + 1}`} placeholder="The first Message…" onChange={(event) => setOpenings(draft.openings.map((item, at) => at === index ? event.target.value : item))} />
							<Button type="button" size="icon-xs" variant="ghost" className="absolute top-1.5 right-1.5 opacity-0 group-hover/opening:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" aria-label={`Remove Opening ${index + 1}`} onClick={() => setOpenings(draft.openings.filter((_, at) => at !== index))}><X aria-hidden="true" /></Button>
						</div>
					))}
				</section>
				{children}
			</div>
			<SaveFooter dirty={dirty} saving={saving} valid={valid && draft.name.trim() !== ""} error={error} onSave={onSave} />
		</div>
	);
}
