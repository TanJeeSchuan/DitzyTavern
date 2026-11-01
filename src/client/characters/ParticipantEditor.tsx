import { useState, type ReactNode } from "react";
import {
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { useSaveGuard } from "../SaveGuard";
import { useRevisionedDraft, type DraftSaveResult } from "../lib/revisioned-draft";
import { ConflictBanner } from "../ConflictBanner";
import { DefinitionEditor, definitionOf, sameDefinition, submittableDefinition } from "./DefinitionEditor";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import { BoxBoundary } from "../box-windows/BoxBoundary";
import { boxClients } from "../box-windows/registry";

// @approved
//  The wording this surface shows for each standard command failure; the
// runner owns when each notice is shown, the editor owns what it says.
const EDITOR_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation could not be reached.",
	unreachable: "The Conversation could not be reached.",
};

export function ParticipantEditor({
	conversation,
	participantId,
	subtitle,
	actions,
	autoSelectName,
	onConversationChange,
	onBack,
}: {
	conversation: ConversationSummary;
	participantId: number;
	subtitle: ReactNode;
	actions: ReactNode;
	autoSelectName: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	onBack: () => void;
}) {
	const participant = conversation.cast.find((candidate) => candidate.id === participantId);
	const [notice, setNotice] = useState<string | null>(null);
	const revisioned = (current: ConversationSummary) => {
		const found = current.cast.find((candidate) => candidate.id === participantId);
		return found === undefined ? null : { value: definitionOf(found), revision: current.revision };
	};
	const editor = useRevisionedDraft(revisioned(conversation), {
		equals: sameDefinition,
		save: async (submitted, revision) => {
			let result: DraftSaveResult<ParticipantDefinition> = { outcome: "failed" };
			await runConversationCommand({ conversationId: conversation.id, revision: () => revision, onConversationChange, setNotice }, {
				type: "update-participant-definition", participantId, definition: submittableDefinition(submitted),
			}, {
				notices: EDITOR_NOTICES,
				onApplied: (applied) => {
					const saved = revisioned(applied);
					if (saved !== null) result = { outcome: "saved", saved };
					setNotice(null);
				},
				onConflict: (current) => {
					const theirs = revisioned(current);
					if (theirs !== null) result = { outcome: "conflict", theirs };
				},
			});
			return result;
		},
	});
	const draft = editor.value;
	const save = () => draft === null || draft.name.trim() === "" ? Promise.resolve(false) : editor.save();
	useSaveGuard({ dirty: editor.dirty, saving: editor.saving, save, discard: editor.discard });
	if (participant === undefined || draft === null) return <p className="panel-body text-sm text-muted-foreground">This Participant is no longer in the Cast.</p>;

	return (
		<DefinitionEditor
			draft={draft}
			onDraftChange={editor.edit}
			subtitle={subtitle}
			actions={actions}
			dirty={editor.dirty}
			saving={editor.saving}
			error={editor.conflict ? null : notice}
			valid={!editor.conflict}
			autoSelectName={autoSelectName}
			onSave={() => void save()}
			onBack={onBack}
			banner={editor.conflict && <ConflictBanner
				message="This Participant changed elsewhere after you opened it. Your edits were not saved and are still here."
				onKeepMine={editor.keepMine}
				onLoadSaved={editor.discard}
			/>}
		>
			{boxClients().map(([id, { ParticipantSection }]) => ParticipantSection && <BoxBoundary key={id} box={id}>
				<ParticipantSection conversation={conversation} participant={participant} />
			</BoxBoundary>)}
			<LoreAttachmentEditor owner="participant" ownerId={participant.id} disabled={editor.saving} />
		</DefinitionEditor>
	);
}
