import { ImageUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ProseEditor, type ProseEditorHandle } from "../editor/ProseEditor";
import { appearanceImageHashes } from "../../shared/definition";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import type { OpenedImage } from "../ImageDialog";
import { api } from "../lib/eden";
import { requestOutcome, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";
import { description } from "../../shared/contract/describe";
import { invalidOutcome } from "../../shared/contract/outcomes";

type DescribeState = { kind: "idle" } | { kind: "added" } | { kind: "describing" } | { kind: "error"; message: string };

const DescribeFeedback = ({ state }: { state: DescribeState }) => <div className="min-h-4 text-xs">
	{state.kind === "describing" ? <p role="status" className="text-muted-foreground">Describing…</p>
		: state.kind === "added" ? <p role="status" className="text-muted-foreground">Added to Appearance.</p>
		: state.kind === "error" ? <p role="alert" className="text-destructive">{state.message}</p> : null}
</div>;

function AskForm({ ask, onAsk, pending, onDescribe }: { ask: string; onAsk: (ask: string) => void; pending: boolean; onDescribe: () => void }) {
	const id = useId();
	return <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); onDescribe(); }}>
		<Field label="Ask (optional)" htmlFor={id} helper="Uses the describing model in Connection Settings.">
			<Textarea id={id} name="ask" value={ask} onChange={(event) => onAsk(event.target.value)} />
		</Field>
		<Button type="submit" size="sm" disabled={pending}>Describe</Button>
	</form>;
}

function PictureDescribe({ image, pending, onDescribe }: { image: OpenedImage; pending: boolean; onDescribe: (hashes: string[], ask: string, insert: (text: string) => boolean, feedback: (state: DescribeState) => void) => void }) {
	const [state, setState] = useState<DescribeState>({ kind: "idle" });
	const [ask, setAsk] = useState("");
	return <div className="grid gap-2">
		<AskForm ask={ask} onAsk={setAsk} pending={pending} onDescribe={() => onDescribe([image.hash], ask, (text) => image.insertAfter?.(text) === true, setState)} />
		<DescribeFeedback state={state} />
	</div>;
}

export function AppearanceField({ draft, placeholder, onDraftChange }: { draft: ParticipantDefinition; placeholder?: string; onDraftChange: (draft: ParticipantDefinition) => void }) {
	const editor = useRef<ProseEditorHandle>(null);
	const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
	const controller = useRef<AbortController | null>(null);
	const [state, setState] = useState<DescribeState>({ kind: "idle" });
	const [open, setOpen] = useState(false);
	const [ask, setAsk] = useState("");
	useEffect(() => () => controller.current?.abort(), []);
	const describe = async (hashes: string[], ask: string, insert: (text: string) => boolean, feedback?: (state: DescribeState) => void) => {
		const report = (state: DescribeState) => { setState(state); feedback?.(state); };
		if (controller.current !== null) return;
		setOpen(false);
		if (hashes.length === 0) return report({ kind: "error", message: "Add a picture to Appearance or a Portrait before describing." });
		const request = new AbortController();
		controller.current = request;
		report({ kind: "describing" });
		try {
			const result = await requestOutcome(api.api.describe.post({ hashes, ask }, { fetch: { signal: request.signal } }), description, invalidOutcome);
			if (request.signal.aborted) return;
			if (result.outcome !== "available") return report({ kind: "error", message: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : SERVER_UNREACHABLE_NOTICE });
			report(insert(result.value.text) ? { kind: "added" } : { kind: "error", message: "The picture's Reference was removed. Describe it again after restoring it." });
		} finally {
			controller.current = null;
		}
	};
	return <div ref={setBoundary} className="flex flex-col gap-1.5">
		<div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
			<span>Appearance</span>
			<div className="flex items-center gap-2">
				<Button type="button" size="xs" variant="ghost" disabled={draft.portrait === undefined} onClick={() => {
					if (draft.portrait !== undefined) editor.current?.insertReference(draft.name || "Portrait", draft.portrait.hash);
				}}><ImageUp aria-hidden="true" /> Insert Portrait</Button>
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild><Button type="button" size="xs" variant="ghost">Describe</Button></PopoverTrigger>
					<PopoverContent align="end" collisionBoundary={boundary} collisionPadding={8} className="w-72 max-w-[var(--radix-popover-content-available-width)]">
						<AskForm ask={ask} onAsk={setAsk} pending={state.kind === "describing"} onDescribe={() => void describe(appearanceImageHashes(draft), ask, (text) => {
							editor.current?.appendText(text);
							return editor.current !== null;
						})} />
					</PopoverContent>
				</Popover>
			</div>
		</div>
		<ProseEditor ref={editor} className="prose-editor-field" ariaLabel="Appearance" value={draft.prompt.appearance} placeholder={placeholder}
			onChange={(appearance) => {
				if (state.kind !== "describing") setState({ kind: "idle" });
				onDraftChange({ ...draft, prompt: { ...draft.prompt, appearance } });
			}}
			imageActions={(image) => <PictureDescribe key={image.hash} image={image} pending={state.kind === "describing"} onDescribe={(hashes, ask, insert, feedback) => void describe(hashes, ask, insert, feedback)} />} />
		<label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
			Send Appearance Images
			<Switch checked={draft.sendAppearanceImages} onCheckedChange={(sendAppearanceImages) => onDraftChange({ ...draft, sendAppearanceImages })} />
		</label>
		<DescribeFeedback state={state} />
	</div>;
}
