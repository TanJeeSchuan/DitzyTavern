import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AppSelect } from "@/components/ui/select";
import { Value } from "@sinclair/typebox/value";
import { paintingAspectRatio, DEFAULT_PAINTING_ASPECT_RATIO } from "../shared/contract/painting";
import { Switch } from "@/components/ui/switch";
import { useWriteBrief } from "./brief";
import { ProseEditor } from "./editor/ProseEditor";
import { IllustrationRows } from "./story/IllustrationRows";
import { PanelHeader } from "./PanelHeader";
import { usePaintingCommand, useIllustrations, type PaintTarget } from "./painting";

export function PaintPanel({ conversationId, target, onClose }: { conversationId: number; target: PaintTarget; onClose: () => void }) {
	const { variantId } = target;
	const [brief, setBrief] = useState(target.brief);
	const [ask, setAsk] = useState("");
	const writing = useWriteBrief(conversationId, setBrief);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const read = useIllustrations(conversationId);
	const selection = read.data;
	const settingsDisabled = pending || writing.pending || read.isPending || read.isError;
	const aspectRatio = read.data?.aspectRatio ?? DEFAULT_PAINTING_ASPECT_RATIO;
	return <aside className="details-panel" data-open="true" aria-label="Paint">
		<PanelHeader title="Paint" onClose={onClose} />
		<div className="panel-body grid auto-rows-max content-start gap-5">
			<form className="grid gap-4" aria-label="Write Brief" onSubmit={async (event) => {
				event.preventDefault();
				const count = new FormData(event.currentTarget).get("messages");
				if (count !== null && Number(count) !== selection?.briefMessageCount && !await submit({ type: "set-brief-message-count", briefMessageCount: Number(count) })) return;
				await writing.write({ variantId, ask });
			}}>
				<Field label="Ask" helper="Leave empty to describe the scene at this Message.">
					<ProseEditor className="prose-editor-field" ariaLabel="Ask" value={ask} onChange={setAsk} disabled={writing.pending} />
				</Field>
				<Field label="Paint Preset" htmlFor="paint-preset">
					<AppSelect id="paint-preset" className="field-input" value={selection ? String(selection.paintPresetId) : ""} disabled={settingsDisabled}
						emptyLabel="Choose a Paint Preset" options={selection?.paintPresets.map((preset) => ({ value: String(preset.id), label: preset.name })) ?? []}
						onValueChange={(value) => void submit({ type: "select-paint-preset", paintPresetId: Number(value) })} />
				</Field>
				<Field label="Messages" htmlFor="brief-message-count">
					<div className="flex items-center gap-3">
						<input key={String(selection?.briefMessageCount)} id="brief-message-count" name="messages" type="number" min={1} step={1}
							className="field-input min-w-0 flex-1" defaultValue={selection?.briefMessageCount ?? ""} disabled={settingsDisabled || selection?.briefMessageCount === null}
							onBlur={(event) => {
								if (event.relatedTarget instanceof HTMLButtonElement && event.relatedTarget.type === "submit") return;
								const count = event.currentTarget.valueAsNumber;
								if (Number.isSafeInteger(count) && count > 0) void submit({ type: "set-brief-message-count", briefMessageCount: count });
								else event.currentTarget.value = String(selection?.briefMessageCount ?? 5);
							}} />
						<label className="flex items-center gap-2 text-sm"><Switch checked={selection?.briefMessageCount === null} disabled={settingsDisabled}
							onCheckedChange={(all) => void submit({ type: "set-brief-message-count", briefMessageCount: all ? null : 5 })} />All</label>
					</div>
				</Field>
				<div className="flex items-center gap-3">
					<Button type="submit" disabled={settingsDisabled || !selection?.paintPresets.some((preset) => preset.id === selection.paintPresetId)}>Write Brief</Button>
					{writing.pending && <><span role="status" className="text-sm text-muted-foreground">Writing Brief…</span><Button type="button" variant="ghost" onClick={writing.stop}>Stop</Button></>}
				</div>
				{writing.error && <p role="alert" className="text-sm text-destructive">{writing.error}</p>}
			</form>
			<Field label="Brief" helper="Describe the picture. Insert pictures to use as references.">
				<ProseEditor className="prose-editor-field" ariaLabel="Brief" value={brief} onChange={setBrief} disabled={writing.pending} />
			</Field>
			<Field label="Shape" htmlFor="painting-aspect-ratio">
				<AppSelect id="painting-aspect-ratio" className="field-input" value={aspectRatio} disabled={pending || read.isPending || read.isError}
					onValueChange={(value) => { if (Value.Check(paintingAspectRatio, value)) void submit({ type: "set-aspect-ratio", aspectRatio: value }); }}
					options={[{ value: "9:16", label: "Tall · 9:16" }, { value: "3:4", label: "Portrait · 3:4" }, { value: "1:1", label: "Square · 1:1" }, { value: "4:3", label: "Landscape · 4:3" }, { value: "16:9", label: "Wide · 16:9" }]} />
			</Field>
			<Button className="justify-self-start" disabled={pending || writing.pending || !brief.trim() || read.isPending || read.isError} onClick={() => void submit({ type: "paint", variantId, brief, aspectRatio })}>Paint</Button>
			<p className="panel-note">Painting continues after you close this panel.</p>
			{(error !== null || read.isError) && <p role="alert" className="text-sm text-destructive">{error ?? "Illustrations could not be loaded."}</p>}
			<div><IllustrationRows conversationId={conversationId} variantId={variantId} /></div>
		</div>
	</aside>;
}
