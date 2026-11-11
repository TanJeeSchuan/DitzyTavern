import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AppSelect } from "@/components/ui/select";
import { Value } from "@sinclair/typebox/value";
import { paintingAspectRatio, DEFAULT_PAINTING_ASPECT_RATIO } from "../shared/contract/painting";
import { ProseEditor } from "./editor/ProseEditor";
import { IllustrationRows } from "./story/IllustrationRows";
import { PanelHeader } from "./PanelHeader";
import { usePaintingCommand, useIllustrations, type PaintTarget } from "./painting";

export function PaintPanel({ conversationId, target, onClose }: { conversationId: number; target: PaintTarget; onClose: () => void }) {
	const { variantId } = target;
	const [brief, setBrief] = useState(target.brief);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const read = useIllustrations(conversationId);
	const aspectRatio = read.data?.aspectRatio ?? DEFAULT_PAINTING_ASPECT_RATIO;
	return <aside className="details-panel" data-open="true" aria-label="Paint">
		<PanelHeader title="Paint" onClose={onClose} />
		<div className="panel-body grid auto-rows-max content-start gap-5">
			<Field label="Brief" helper="Describe the picture. Insert pictures to use as references.">
				<ProseEditor className="prose-editor-field" ariaLabel="Brief" value={brief} onChange={setBrief} autoFocus />
			</Field>
			<Field label="Shape" htmlFor="painting-aspect-ratio">
				<AppSelect id="painting-aspect-ratio" className="field-input" value={aspectRatio} disabled={pending || read.isPending || read.isError}
					onValueChange={(value) => { if (Value.Check(paintingAspectRatio, value)) void submit({ type: "set-aspect-ratio", aspectRatio: value }); }}
					options={[{ value: "9:16", label: "Tall · 9:16" }, { value: "3:4", label: "Portrait · 3:4" }, { value: "1:1", label: "Square · 1:1" }, { value: "4:3", label: "Landscape · 4:3" }, { value: "16:9", label: "Wide · 16:9" }]} />
			</Field>
			<Button className="justify-self-start" disabled={pending || !brief.trim() || read.isPending || read.isError} onClick={() => void submit({ type: "paint", variantId, brief, aspectRatio })}>Paint</Button>
			<p className="panel-note">Painting continues after you close this panel.</p>
			{(error !== null || read.isError) && <p role="alert" className="text-sm text-destructive">{error ?? "Illustrations could not be loaded."}</p>}
			<div><IllustrationRows conversationId={conversationId} variantId={variantId} /></div>
		</div>
	</aside>;
}
