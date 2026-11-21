import { Pencil } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationAction, ConversationSummary } from "./conversation";
import { conversationKey } from "./conversation-query";
import { runConversationCommand } from "./conversation-command-runner";
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
import { Gallery } from "./Gallery";
import { ProseEditor, type ProseEditorHandle } from "./editor/ProseEditor";
import { IllustrationRows } from "./story/IllustrationRows";
import { PanelHeader } from "./PanelHeader";
import { illustrationsKey, usePaintingCommand, useIllustrations, useAdoptReferences, useReferenceDraft, type PaintTarget } from "./painting";
import { useImageModel } from "./model-selection-client";
import { ReferenceSetField } from "./ReferenceSetField";
import { ProfileModelPicker } from "./ProfileModelPicker";

export function PaintPanel({ conversation, onConversationChange, target, onDraftChange, onClose }: { conversation: ConversationSummary; onConversationChange: (conversation: ConversationSummary | null) => void; target: PaintTarget; onDraftChange: (draft: Partial<Pick<PaintTarget, "brief" | "ask">>) => void; onClose: () => void }) {
	const allMessagesId = useId();
	const conversationId = conversation.id;
	const [editingPreset, setEditingPreset] = useState<number | null>(null);
	const { variantId } = target;
	const [brief, setBrief] = useState(target.brief);
	const updateBrief = (brief: string) => { setBrief(brief); onDraftChange({ brief }); };
	const [ask, setAsk] = useState(target.ask);
	const updateAsk = (ask: string) => { setAsk(ask); onDraftChange({ ask }); };
	const referencesEditor = useRef<ProseEditorHandle>(null);
	const writing = useWriteBrief(conversationId, updateBrief);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const client = useQueryClient();
	const settings = useMutation({
		networkMode: "always",
		mutationFn: async (action: Extract<ConversationAction, { type: "select-paint-preset" | "set-brief-message-count" }>) => {
			let reason = "The Paint settings could not be saved.";
			const applied = await runConversationCommand({
				conversationId, onConversationChange, setNotice: (notice) => { reason = notice; },
				revision: () => client.getQueryData<ConversationSummary>(conversationKey(conversationId))?.revision ?? null,
			}, action, { notices: { conflict: "This Chat changed elsewhere. Your Paint settings were not saved." } });
			await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			if (!applied) throw new Error(reason);
		},
	});
	const read = useIllustrations(conversationId);
	const selection = read.data;
	const referenceSet = selection?.referenceSets.find(({ id }) => id === selection.referenceSetId);
	const references = useReferenceDraft(conversationId, referenceSet);
	const adoptingOrWriting = references.locked || writing.pending;
	const writablePreset = selection?.paintPresets.some((preset) => preset.id === selection.paintPresetId) ?? false;
	const settingsDisabled = pending || settings.isPending || adoptingOrWriting || selection === undefined;
	const saveMessageCount = (count: number) => count === selection?.briefMessageCount ? Promise.resolve(true)
		: settings.mutateAsync({ type: "set-brief-message-count", briefMessageCount: count }).then(() => true, () => false);
	const aspectRatio = read.data?.aspectRatio ?? DEFAULT_PAINTING_ASPECT_RATIO;
	const adoptReferences = useAdoptReferences(conversationId);
	const imageModel = useImageModel();
	const modelUnavailable = imageModel.pending || imageModel.selected === undefined;
	const presetName = selection?.paintPresets.find(({ id }) => id === selection.paintPresetId)?.name;
	const panelError = error ?? settings.error?.message ?? imageModel.error ?? adoptReferences.error ?? (read.isError ? "Illustrations could not be loaded." : null);
	if (editingPreset !== null) return <aside className="details-panel" data-open="true" aria-label="Paint Preset">
		<PromptPresetPanel conversation={conversation} onConversationChange={onConversationChange} presetId={editingPreset}
			onClose={() => { setEditingPreset(null); void read.refetch(); }} />
	</aside>;
	return <aside className="details-panel" data-open="true" aria-label="Paint">
		<PanelHeader title="Paint" onClose={onClose} />
		<div className="panel-body grid auto-rows-max content-start gap-5">
			<form className="grid gap-4" aria-label="Write Brief" onSubmit={async (event) => {
				event.preventDefault();
				if (settingsDisabled || !writablePreset) return;
				const count = new FormData(event.currentTarget).get("messages");
				if (count !== null && !await saveMessageCount(Number(count))) return;
				await writing.write({ variantId, ask }, brief);
			}}>
				<Field label="Ask" helper="Leave empty to describe the scene at this Message.">
					<ProseEditor className="prose-editor-field" ariaLabel="Ask" value={ask} onChange={updateAsk} disabled={adoptingOrWriting} />
				</Field>
				<details className="grid gap-4">
					<summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
						Brief settings{selection && <span className="font-normal"> · {presetName} · {selection.briefMessageCount === null ? "All Messages" : `${selection.briefMessageCount} Messages`}</span>}
					</summary>
					<div className="mt-4 grid gap-4">
				<Field label="Paint Preset" htmlFor="paint-preset">
					<AppSelect id="paint-preset" className="field-input" value={selection ? String(selection.paintPresetId) : ""} disabled={settingsDisabled}
						emptyLabel="Choose a Paint Preset" options={selection?.paintPresets.map((preset) => ({ value: String(preset.id), label: preset.name })) ?? []}
						onValueChange={(value) => settings.mutate({ type: "select-paint-preset", paintPresetId: Number(value) })} />
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
							onCheckedChange={(all) => settings.mutate({ type: "set-brief-message-count", briefMessageCount: all ? null : DEFAULT_BRIEF_MESSAGE_COUNT })} /><Label htmlFor={allMessagesId}>All</Label></div>
					</div>
				</Field>
					</div>
				</details>
				<div className="flex flex-wrap items-center gap-3" aria-live="polite">
					<Button type="submit" disabled={settingsDisabled || !writablePreset}>{writing.pending ? "Writing Brief…" : "Write Brief"}</Button>
					{writing.pending && <Button type="button" variant="ghost" onClick={writing.stop}>Stop</Button>}
				</div>
				{selection && !writablePreset && <p className="panel-note">Choose a Paint Preset with an enabled Brief instruction to write a Brief.</p>}
				{writing.error && <p role="alert" className="text-sm text-destructive">{writing.error}</p>}
			</form>
			<Field label="Brief" helper="Describe the picture. Writing a Brief replaces this text.">
				<ProseEditor className="prose-editor-field" ariaLabel="Brief" autoFocus={Boolean(target.brief)} value={brief} onChange={updateBrief} disabled={adoptingOrWriting} />
			</Field>
			<ReferenceSetField conversationId={conversationId} sets={selection?.referenceSets ?? []} selected={referenceSet} draft={references} editorRef={referencesEditor} disabled={selection === undefined} />
			<Gallery conversationId={conversationId} paint={{ insertDisabled: references.locked || referenceSet === undefined,
				adoptDisabled: settingsDisabled, onReference: (name, hash) => referencesEditor.current?.insertReference(name, hash),
				onUseBrief: async (name, painted) => {
					if (!await adoptReferences.adopt(name, painted.references)) return;
					updateBrief(painted.brief);
					updateAsk(painted.ask);
				} }} />
			<div><IllustrationRows conversationId={conversationId} variantId={variantId} /></div>
		</div>
		<footer className="panel-action-footer grid gap-2">
			<ProfileModelPicker apiFormat="images" side="top" label="Image Model" emptyLabel="Add an Images connection in Connections."
				disabled={modelUnavailable}
				selected={imageModel.selected?.profileId == null ? null : { connectionProfileId: imageModel.selected.profileId, modelId: imageModel.selected.model }}
				onSelect={(profile, model) => imageModel.select(profile.id, model)} />
			<div className="flex min-w-0 items-center gap-2">
				<div className="w-40 shrink-0"><AppSelect aria-label="Shape" className="field-input" value={aspectRatio} disabled={pending || selection === undefined}
					onValueChange={(value) => { if (Value.Check(paintingAspectRatio, value)) void submit({ type: "set-aspect-ratio", aspectRatio: value }); }}
					options={[{ value: "9:16", label: "Tall · 9:16" }, { value: "3:4", label: "Portrait · 3:4" }, { value: "1:1", label: "Square · 1:1" }, { value: "4:3", label: "Landscape · 4:3" }, { value: "16:9", label: "Wide · 16:9" }]} /></div>
				<Button className="ml-auto" disabled={settingsDisabled || modelUnavailable || !brief.trim()}
					onClick={() => void submit({ type: "paint", variantId, brief, references: references.references, ask, aspectRatio })}>Paint</Button>
			</div>
			<p className="panel-note m-0">Painting continues after you close this panel.</p>
			{read.isError && <Button type="button" variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry Illustrations</Button>}
			{!imageModel.pending && imageModel.selected === undefined && <Button type="button" variant="ghost" size="sm" onClick={imageModel.reload}>Retry Image Model</Button>}
			{panelError !== null && <p role="alert" className="text-sm text-destructive">{panelError}</p>}
		</footer>
	</aside>;
}
