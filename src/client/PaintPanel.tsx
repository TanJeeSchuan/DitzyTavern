import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AppSelect } from "@/components/ui/select";
import { Value } from "@sinclair/typebox/value";
import { paintingAspectRatio, DEFAULT_PAINTING_ASPECT_RATIO } from "../shared/contract/painting";
import { ProseEditor } from "./editor/ProseEditor";
import { PanelHeader } from "./PanelHeader";
import { commandPainting, illustrationsKey, useIllustrations } from "./painting";

export function PaintPanel({ conversationId, variantId, onClose }: { conversationId: number; variantId: number; onClose: () => void }) {
	const [brief, setBrief] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const read = useIllustrations(conversationId);
	const client = useQueryClient();
	const aspectRatio = read.data?.aspectRatio ?? DEFAULT_PAINTING_ASPECT_RATIO;
	const submit = async (command: Parameters<typeof commandPainting>[1]) => {
		setPending(true);
		setError(null);
		try {
			const result = await commandPainting(conversationId, command);
			if (result.outcome === "available") await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "Painting could not start. Try again.");
		} finally { setPending(false); }
	};
	return <aside className="details-panel" data-open="true" aria-label="Paint">
		<PanelHeader title="Paint" onClose={onClose} />
		<div className="panel-body grid content-start gap-5">
			<Field label="Brief" helper="Describe the picture. Insert pictures to use as references.">
				<ProseEditor ariaLabel="Brief" value={brief} onChange={setBrief} autoFocus />
			</Field>
			<Field label="Shape" htmlFor="painting-aspect-ratio">
				<AppSelect id="painting-aspect-ratio" className="field-input" value={aspectRatio} disabled={pending || read.isPending || read.isError}
					onValueChange={(value) => { if (Value.Check(paintingAspectRatio, value)) void submit({ type: "set-aspect-ratio", aspectRatio: value }); }}
					options={[{ value: "9:16", label: "Tall · 9:16" }, { value: "3:4", label: "Portrait · 3:4" }, { value: "1:1", label: "Square · 1:1" }, { value: "4:3", label: "Landscape · 4:3" }, { value: "16:9", label: "Wide · 16:9" }]} />
			</Field>
			<Button className="justify-self-start" disabled={pending || !brief.trim() || read.isPending || read.isError} onClick={() => void submit({ type: "paint", variantId, brief, aspectRatio })}>Paint</Button>
			<p className="panel-note">Painting continues after you close this panel.</p>
			{(error !== null || read.isError) && <p role="alert" className="text-sm text-destructive">{error ?? "Illustrations could not be loaded."}</p>}
		</div>
	</aside>;
}
