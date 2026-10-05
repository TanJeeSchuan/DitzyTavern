import { useRef, useState, type ReactNode } from "react";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import { emptyPromptChannels } from "../../shared/definition";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { useSaveGuard } from "../SaveGuard";
import { DefinitionEditor, definitionOf, sameDefinition, submittableDefinition } from "./DefinitionEditor";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";
import { waitForImageLoads } from "../lib/image";

// ==[HUMAN APPROVED]== The wording this surface shows for each standard command failure; the
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
	const [draft, setDraft] = useState<ParticipantDefinition>(() => definitionOf(participant ?? { name: "", prompt: emptyPromptChannels(), openings: [] }));
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;

	const dirty = participant !== undefined && !sameDefinition(draft, definitionOf(participant));
	const apply = async () => {
		if (participant === undefined || !dirty || pending || draft.name.trim() === "") return false;
		const submitted = draft;
		let appliedSuccessfully = false;
		setPending(true);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: async (expectedRevision) => {
					await waitForImageLoads(JSON.stringify([participant.prompt, participant.openings]));
					return applyConversationCommand(conversation.id, expectedRevision, { type: "update-participant-definition", participantId: participant.id, definition: submittableDefinition(submitted) });
				},
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: EDITOR_NOTICES,
				callbacks: {
					onApplied: (applied) => {
						appliedSuccessfully = true;
						const saved = applied.cast.find((candidate) => candidate.id === participant.id);
						if (saved) setDraft((current) => current === submitted ? definitionOf(saved) : current);
						setNotice(null);
					},
					// ==[HUMAN APPROVED]== This command family cannot produce these outcomes; the
					// server's precise reason is kept instead of a flattened class.
					onNotPlayable: setNotice,
					onNotRemovable: setNotice,
				},
			});
		} finally {
			setPending(false);
		}
		return appliedSuccessfully && draftRef.current === submitted;
	};
	useSaveGuard({ dirty, saving: pending, save: apply, discard: () => undefined });
	if (participant === undefined) return <p className="panel-body text-sm text-muted-foreground">This Participant is no longer in the Cast.</p>;

	return (
		<DefinitionEditor
			draft={draft}
			onDraftChange={setDraft}
			subtitle={subtitle}
			actions={actions}
			dirty={dirty}
			saving={pending}
			error={notice}
			autoSelectName={autoSelectName}
			onSave={() => void apply()}
			onBack={onBack}
		>
			<LoreAttachmentEditor owner="participant" ownerId={participant.id} disabled={pending} />
		</DefinitionEditor>
	);
}
