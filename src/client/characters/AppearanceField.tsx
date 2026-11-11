import { ImageUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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

type DescribeState = { kind: "idle" } | { kind: "describing" } | { kind: "error"; message: string };

const DescribeFeedback = ({ state }: { state: DescribeState }) => state.kind === "describing"
	? <p role="status" className="text-xs text-muted-foreground">Describing…</p>
	: state.kind === "error" ? <p role="alert" className="text-xs text-destructive">{state.message}</p> : null;

function AskForm({ ask, onAsk, pending, onDescribe }: { ask: string; onAsk: (ask: string) => void; pending: boolean; onDescribe: () => void }) {
	const id = useId();
	return <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); onDescribe(); }}>
		<label htmlFor={id} className="text-xs font-medium text-muted-foreground">Ask (optional)</label>
		<textarea id={id} name="ask" className="field-input min-h-16" value={ask} onChange={(event) => onAsk(event.target.value)} />
		<p className="text-xs text-muted-foreground">Uses the describing model in Connection Settings.</p>
		<Button type="submit" size="sm" disabled={pending}>Describe</Button>
	</form>;
}

function PictureDescribe({ image, state, onDescribe }: { image: OpenedImage; state: DescribeState; onDescribe: (hashes: string[], ask: string, insert: (text: string) => boolean) => void }) {
	const [ask, setAsk] = useState("");
	return <div className="grid gap-2">
		<AskForm ask={ask} onAsk={setAsk} pending={state.kind === "describing"} onDescribe={() => onDescribe([image.hash], ask, (text) => image.insertAfter?.(text) === true)} />
		<DescribeFeedback state={state} />
	</div>;
}

export function AppearanceField({ draft, onDraftChange }: { draft: ParticipantDefinition; onDraftChange: (draft: ParticipantDefinition) => void }) {
	const editor = useRef<ProseEditorHandle>(null);
	const controller = useRef<AbortController | null>(null);
	const [state, setState] = useState<DescribeState>({ kind: "idle" });
	const [open, setOpen] = useState(false);
	const [ask, setAsk] = useState("");
	useEffect(() => () => controller.current?.abort(), []);
	const describe = async (hashes: string[], ask: string, insert: (text: string) => boolean) => {
		if (controller.current !== null) return;
		setOpen(false);
		if (hashes.length === 0) return setState({ kind: "error", message: "Add a picture to Appearance or a Portrait before describing." });
		const request = new AbortController();
		controller.current = request;
		setState({ kind: "describing" });
		try {
			const result = await requestOutcome(api.api.describe.post({ hashes, ask }, { fetch: { signal: request.signal } }), description, invalidOutcome);
			if (request.signal.aborted) return;
			if (result.outcome !== "available") return setState({ kind: "error", message: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : SERVER_UNREACHABLE_NOTICE });
			setState(insert(result.value.text) ? { kind: "idle" } : { kind: "error", message: "The picture's Reference was removed. Describe it again after restoring it." });
		} finally {
			controller.current = null;
		}
	};
	return <div className="flex flex-col gap-1.5">
		<div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
			<span>Appearance</span>
			<div className="flex items-center gap-2">
				<Button type="button" size="xs" variant="ghost" disabled={draft.portrait === undefined} onClick={() => {
					if (draft.portrait !== undefined) editor.current?.insertReference(draft.name || "Portrait", draft.portrait.hash);
				}}><ImageUp aria-hidden="true" /> Insert Portrait</Button>
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild><Button type="button" size="xs" variant="ghost">Describe</Button></PopoverTrigger>
					<PopoverContent align="end" className="w-72">
						<AskForm ask={ask} onAsk={setAsk} pending={state.kind === "describing"} onDescribe={() => void describe(appearanceImageHashes(draft), ask, (text) => {
							editor.current?.appendText(text);
							return editor.current !== null;
						})} />
					</PopoverContent>
				</Popover>
			</div>
		</div>
		<ProseEditor ref={editor} className="prose-editor-field" ariaLabel="Appearance" value={draft.prompt.appearance} placeholder="Face, hair, eyes, build, clothing…"
			onChange={(appearance) => onDraftChange({ ...draft, prompt: { ...draft.prompt, appearance } })}
			imageActions={(image) => <PictureDescribe key={image.hash} image={image} state={state} onDescribe={(hashes, ask, insert) => void describe(hashes, ask, insert)} />} />
		<label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
			Send Appearance Images
			<Switch checked={draft.sendAppearanceImages} onCheckedChange={(sendAppearanceImages) => onDraftChange({ ...draft, sendAppearanceImages })} />
		</label>
		<DescribeFeedback state={state} />
	</div>;
}
