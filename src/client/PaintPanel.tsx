import { Pencil } from "lucide-react";
import type { ConversationSummary } from "./conversation";
import { PromptPresetPanel } from "./workspace/PromptPresetPanel";
import { useId, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AppSelect } from "@/components/ui/select";
import { Value } from "@sinclair/typebox/value";
import { paintingAspectRatio, DEFAULT_PAINTING_ASPECT_RATIO, DEFAULT_BRIEF_MESSAGE_COUNT } from "../shared/contract/painting";
import { Switch } from "@/components/ui/switch";
import { useWriteBrief } from "./brief";
import { PaintGallery } from "./PaintGallery";
import { ProseEditor, type ProseEditorHandle } from "./editor/ProseEditor";
import { IllustrationRows } from "./story/IllustrationRows";
import { PanelHeader } from "./PanelHeader";
import { usePaintingCommand, useIllustrations, type PaintTarget } from "./painting";

export function PaintPanel({ conversation, onConversationChange, target, onDraftChange, onClose }: { conversation: ConversationSummary; onConversationChange: (conversation: ConversationSummary | null) => void; target: PaintTarget; onDraftChange: (draft: Partial<Pick<PaintTarget, "brief" | "ask">>) => void; onClose: () => void }) {
	const allMessagesId = useId();
	const conversationId = conversation.id;
	const [editingPreset, setEditingPreset] = useState<number | null>(null);
	const { variantId } = target;
	const [brief, updateBrief] = useState(target.brief);
	const setBrief = (brief: string) => { updateBrief(brief); onDraftChange({ brief }); };
	const [ask, updateAsk] = useState(target.ask);
	const setAsk = (ask: string) => { updateAsk(ask); onDraftChange({ ask }); };
	const briefEditor = useRef<ProseEditorHandle>(null);
	const writing = useWriteBrief(conversationId, setBrief);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const read = useIllustrations(conversationId);
	const selection = read.data;
	const writablePreset = selection?.paintPresets.some((preset) => preset.id === selection.paintPresetId) ?? false;
	const settingsDisabled = pending || writing.pending || read.isPending || read.isError;
	const saveMessageCount = (count: number) => count === selection?.briefMessageCount ? Promise.resolve(true) : submit({ type: "set-brief-message-count", briefMessageCount: count });
	const aspectRatio = read.data?.aspectRatio ?? DEFAULT_PAINTING_ASPECT_RATIO;
	if (editingPreset !== null) return <aside className="details-panel" data-open="true" aria-label="Paint Preset">
		<PromptPresetPanel conversation={conversation} onConversationChange={onConversationChange} presetId={editingPreset}
			onClose={() => { setEditingPreset(null); void read.refetch(); }} />
	</aside>;
	return <aside className="details-panel" data-open="true" aria-label="Paint">
		<PanelHeader title="Paint" onClose={onClose} />
		<div className="panel-body grid auto-rows-max content-start gap-5">
			<form className="grid gap-4" aria-label="Write Brief" onSubmit={async (event) => {
				event.preventDefault();
				const count = new FormData(event.currentTarget).get("messages");
				if (count !== null && !await saveMessageCount(Number(count))) return;
				await writing.write({ variantId, ask }, brief, conversation.cast);
			}}>
				<Field label="Ask" helper="Leave empty to describe the scene at this Message.">
					<ProseEditor className="prose-editor-field" ariaLabel="Ask" value={ask} onChange={setAsk} disabled={writing.pending} />
				</Field>
				<Field label="Paint Preset" htmlFor="paint-preset">
					<AppSelect id="paint-preset" className="field-input" value={selection ? String(selection.paintPresetId) : ""} disabled={settingsDisabled}
						emptyLabel="Choose a Paint Preset" options={selection?.paintPresets.map((preset) => ({ value: String(preset.id), label: preset.name })) ?? []}
						onValueChange={(value) => void submit({ type: "select-paint-preset", paintPresetId: Number(value) })} />
				</Field>
				<Button type="button" variant="ghost" className="justify-self-start px-0" disabled={settingsDisabled || !selection}
					onClick={() => { if (selection) setEditingPreset(selection.paintPresetId); }}><Pencil aria-hidden="true" />Edit Paint Preset</Button>
				<Field label="Messages" htmlFor="brief-message-count">
					<div className="flex items-center gap-3">
						<Input key={String(selection?.briefMessageCount)} id="brief-message-count" name="messages" type="number" required min={1} step={1}
							className="min-w-0 flex-1" defaultValue={selection?.briefMessageCount ?? ""} disabled={settingsDisabled || selection?.briefMessageCount === null}
							onBlur={(event) => {
								if (event.relatedTarget instanceof HTMLButtonElement && ((event.relatedTarget.type === "submit" && event.relatedTarget.form === event.currentTarget.form) || event.relatedTarget.getAttribute("role") === "switch")) return;
								const count = event.currentTarget.valueAsNumber;
								if (Number.isSafeInteger(count) && count > 0) {
									void saveMessageCount(count);
								}
								else event.currentTarget.value = String(selection?.briefMessageCount ?? DEFAULT_BRIEF_MESSAGE_COUNT);
							}} />
						<div className="flex items-center gap-2"><Switch id={allMessagesId} checked={selection?.briefMessageCount === null} disabled={settingsDisabled}
							onCheckedChange={(all) => void submit({ type: "set-brief-message-count", briefMessageCount: all ? null : DEFAULT_BRIEF_MESSAGE_COUNT })} /><Label htmlFor={allMessagesId}>All</Label></div>
					</div>
				</Field>
				<div className="flex flex-wrap items-center gap-3" aria-live="polite">
					<Button type="submit" disabled={settingsDisabled || !writablePreset}>{writing.pending ? "Writing Brief…" : "Write Brief"}</Button>
					{writing.pending && <Button type="button" variant="ghost" onClick={writing.stop}>Stop</Button>}
				</div>
				{selection && !writablePreset && <p className="panel-note">Choose a Paint Preset with an enabled Brief instruction to write a Brief.</p>}
				{writing.error && <p role="alert" className="text-sm text-destructive">{writing.error}</p>}
			</form>
			<Field label="Brief" helper="Describe the picture. Insert pictures to use as references.">
				<ProseEditor className="prose-editor-field" ref={briefEditor} ariaLabel="Brief" autoFocus={Boolean(target.brief)} value={brief} onChange={setBrief} disabled={writing.pending} />
			</Field>
			<PaintGallery conversationId={conversationId} disabled={writing.pending} onReference={(name, hash) => briefEditor.current?.insertReference(name, hash)} />
			<Field label="Shape" htmlFor="painting-aspect-ratio">
				<AppSelect id="painting-aspect-ratio" className="field-input" value={aspectRatio} disabled={pending || read.isPending || read.isError}
					onValueChange={(value) => { if (Value.Check(paintingAspectRatio, value)) void submit({ type: "set-aspect-ratio", aspectRatio: value }); }}
					options={[{ value: "9:16", label: "Tall · 9:16" }, { value: "3:4", label: "Portrait · 3:4" }, { value: "1:1", label: "Square · 1:1" }, { value: "4:3", label: "Landscape · 4:3" }, { value: "16:9", label: "Wide · 16:9" }]} />
			</Field>
			<Button className="justify-self-start" disabled={pending || writing.pending || !brief.trim() || read.isPending || read.isError} onClick={() => void submit({ type: "paint", variantId, brief, ask, aspectRatio })}>Paint</Button>
			<p className="panel-note">Painting continues after you close this panel.</p>
			{(error !== null || read.isError) && <p role="alert" className="text-sm text-destructive">{error ?? "Illustrations could not be loaded."}</p>}
			<div><IllustrationRows conversationId={conversationId} variantId={variantId} /></div>
		</div>
	</aside>;
}
