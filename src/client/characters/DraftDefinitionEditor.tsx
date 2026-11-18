import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyCommand, LIBRARY_UNREACHABLE_NOTICE } from "../character-library";
import { ConflictBanner } from "../ConflictBanner";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import { DefinitionEditor, definitionOf, submittableDefinition } from "./DefinitionEditor";
import type { DefinitionDraftRequest } from "./definition-draft";

const NOTICES = {
	conflict: "The Conversation changed elsewhere; the Cast was reloaded. Your draft is still here.",
	notFound: CONVERSATION_UNREACHABLE_NOTICE,
	unreachable: CONVERSATION_UNREACHABLE_NOTICE,
};

/** @approved Where the panel goes once the writer keeps the draft: the Participant it became or replaced, or the Library Character it was saved as. */
export type DraftKept = { readonly kind: "participant" | "character"; readonly id: number };

// @approved
//  A Box's draft in the core Definition editor. Nothing is written until the
// writer picks an action: Add to Cast, Save as Character, or, for a draft of
// a Cast member, Replace, which keeps that Participant's Portrait and
// Openings, shown here from the start, and asks first. Replace is sent at the
// revision those were copied from, so a change made elsewhere since conflicts
// instead of being reverted, and the writer keeps theirs or loads the saved
// ones. Leaving the editor discards the draft.
export function DraftDefinitionEditor({ conversation, request, onConversationChange, onKept, onBack }: {
	conversation: ConversationSummary;
	request: DefinitionDraftRequest;
	onConversationChange: (conversation: ConversationSummary) => void;
	onKept: (kept: DraftKept) => void;
	onBack: () => void;
}) {
	const replaced = conversation.cast.find(({ id }) => id === request.replaces);
	const kept = (current: typeof replaced) =>
		({ sendAppearanceImages: current?.sendAppearanceImages ?? true, openings: current?.openings ?? [], portrait: current?.portrait });
	const [draft, setDraft] = useState<ParticipantDefinition>(() => definitionOf({ name: request.draft.name, prompt: request.draft.prompt, ...kept(replaced) }));
	const [keptRevision, setKeptRevision] = useState(conversation.revision);
	const [conflict, setConflict] = useState(false);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const surface = { conversationId: conversation.id, revision: () => conversation.revision, onConversationChange, setNotice };
	const pend = async (work: () => Promise<void>) => {
		setPending(true);
		try { await work(); } finally { setPending(false); }
	};
	const addToCast = () => pend(async () => {
		await runConversationCommand(surface, { type: "add-participant", definition: submittableDefinition(draft) }, {
			notices: NOTICES,
			onApplied: (applied) => {
				const added = applied.cast.at(-1);
				if (added !== undefined) onKept({ kind: "participant", id: added.id });
			},
		});
	});
	const saveAsCharacter = () => pend(async () => {
		const outcome = await applyCommand({ type: "create", definition: submittableDefinition(draft) });
		if (outcome.outcome === "available" && "character" in outcome.value) onKept({ kind: "character", id: outcome.value.character.id });
		else setNotice(outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason : LIBRARY_UNREACHABLE_NOTICE);
	});
	const replace = (participantId: number) => pend(async () => {
		await runConversationCommand({ ...surface, revision: () => keptRevision, exact: true }, {
			type: "update-participant-definition", participantId, definition: submittableDefinition(draft),
		}, {
			notices: { ...NOTICES, notFound: "That Participant is no longer in this Cast." },
			onApplied: () => onKept({ kind: "participant", id: participantId }),
			onConflict: () => setConflict(true),
		});
	});
	const resolve = (load: boolean) => {
		if (load) setDraft((current) => ({ ...current, ...kept(replaced) }));
		setKeptRevision(conversation.revision);
		setConflict(false);
		setNotice(null);
	};

	return <>
		<DefinitionEditor
			draft={draft}
			onDraftChange={setDraft}
			subtitle={replaced === undefined ? "Draft · Not kept until you choose" : `Draft of ${replaced.duplicateLabel} · Not kept until you choose`}
			onBack={onBack}
			banner={conflict && replaced !== undefined && <ConflictBanner
				message={`${replaced.duplicateLabel} changed elsewhere after this draft opened, so nothing was replaced. Keep the Portrait and Openings shown here, or load the saved ones.`}
				onKeepMine={() => resolve(false)}
				onLoadSaved={() => resolve(true)}
			/>}
			footer={(named) => <div className="save-footer">
				<span role={notice === null || conflict ? "status" : "alert"}>{conflict ? "" : notice ?? (pending ? "Saving…" : "")}</span>
				<div className="flex flex-wrap justify-end gap-2">
					<Button type="button" size="sm" variant="outline" disabled={!named || pending} onClick={() => void saveAsCharacter()}>Save as Character</Button>
					{replaced === undefined
						? <Button type="button" size="sm" disabled={!named || pending} onClick={() => void addToCast()}>Add to Cast</Button>
						: <>
							<Button type="button" size="sm" variant="outline" disabled={!named || pending} onClick={() => void addToCast()}>Add to Cast</Button>
							<Button type="button" size="sm" disabled={!named || pending || conflict} onClick={() => setConfirming(true)}>Replace {replaced.duplicateLabel}'s Definition</Button>
						</>}
				</div>
			</div>}
		/>
		{replaced !== undefined && <Dialog open={confirming} onOpenChange={setConfirming}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Replace {replaced.duplicateLabel}'s Definition?</DialogTitle>
					<DialogDescription>Their name and Prompt become this draft's for the rest of this Chat. Their Portrait and Openings stay as shown here.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Keep current</Button>
					<Button type="button" disabled={pending} onClick={() => { setConfirming(false); void replace(replaced.id); }}>Replace</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>}
	</>;
}
