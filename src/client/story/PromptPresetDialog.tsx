import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	loadConversationPromptPreset,
	type ConversationPromptPreset,
	type ResolvedPromptPresetSlot,
} from "../conversation";
import { useAsyncEffect } from "../lib/use-async";

// ==[HUMAN APPROVED]== The preset editor is a popup rather than a primary panel: the agreed
// exception in the design direction, because a recipe is edited against the
// Chat it assembles for. This first surface is read-only; ordering, toggles
// and authored blocks arrive with the editor tickets.

const slotLabels = {
	"model-system-instruction": "System Instruction",
	"human-identity": "Identity (you)",
	"model-identity": "Identity (character)",
	"model-scenario": "Scenario",
	"model-example-dialogue": "Example Dialogue",
	history: "Chat history",
	"model-post-history-instruction": "Post-History Instruction",
} as const satisfies Record<ResolvedPromptPresetSlot["reference"], string>;

type PresetView =
	| { status: "loading" }
	| { status: "ready"; preset: ConversationPromptPreset }
	| { status: "unavailable" };

const SlotBody = ({ slot }: { slot: ResolvedPromptPresetSlot }) => {
	if (slot.reference === "history") {
		return (
			<p className="text-muted-foreground">
				{slot.entryCount === 1
					? "1 Message from the selected narrative path."
					: `${slot.entryCount} Messages from the selected narrative path.`}
			</p>
		);
	}
	if (slot.sourceName === null) {
		return (
			<p className="text-muted-foreground">
				No Participant holds this Control seat yet.
			</p>
		);
	}
	return (
		<>
			<p className="text-muted-foreground">From {slot.sourceName}</p>
			{slot.content === "" ? (
				<p className="text-muted-foreground italic">Empty. Contributes nothing.</p>
			) : (
				<pre className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2 font-sans whitespace-pre-wrap">
					{slot.content}
				</pre>
			)}
		</>
	);
};

export function PromptPresetDialog({
	conversationId,
	open,
	onOpenChange,
}: {
	conversationId: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [view, setView] = useState<PresetView>({ status: "loading" });

	useAsyncEffect(
		async (isCancelled) => {
			if (!open) return;
			setView({ status: "loading" });
			try {
				const preset = await loadConversationPromptPreset(conversationId);
				if (isCancelled()) return;
				setView(
					preset === null
						? { status: "unavailable" }
						: { status: "ready", preset },
				);
			} catch {
				if (!isCancelled()) setView({ status: "unavailable" });
			}
		},
		[conversationId, open],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{view.status === "ready"
							? `Prompt Preset: ${view.preset.name}`
							: "Prompt Preset"}
					</DialogTitle>
					<DialogDescription>
						The order this Chat assembles its writing context in. Referenced
						content is read-only here; edit it on the Participant it comes from.
					</DialogDescription>
				</DialogHeader>
				{view.status === "loading" && (
					<div role="status">
						<span className="sr-only">Loading the selected preset…</span>
						<ol aria-hidden="true" className="flex flex-col gap-3">
							{Array.from({ length: 4 }, (_, index) => (
								<li
									key={index}
									className="h-20 animate-pulse rounded-lg bg-muted/50 ring-1 ring-foreground/10"
								/>
							))}
						</ol>
					</div>
				)}
				{view.status === "unavailable" && (
					<p className="text-muted-foreground">
						The selected preset could not be loaded.
					</p>
				)}
				{view.status === "ready" && (
					<ol className="flex flex-col gap-3">
						{view.preset.slots.map((slot, index) => (
							<li
								key={`${slot.reference}-${index}`}
								className="rounded-lg ring-1 ring-foreground/10 p-3"
								data-enabled={slot.enabled}
							>
								<div className="flex items-baseline justify-between gap-2">
									<h3 className="font-medium">
										{index + 1}. {slotLabels[slot.reference]}
									</h3>
									<span className="text-xs text-muted-foreground">
										{slot.enabled ? "Enabled" : "Disabled"}
									</span>
								</div>
								<SlotBody slot={slot} />
							</li>
						))}
					</ol>
				)}
			</DialogContent>
		</Dialog>
	);
}
