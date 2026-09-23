import { useRef, useState } from "react";
import {
	applyConversationCommand,
	type ConversationAction,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import { openingsFromText, openingsToText } from "./definition";
import { emptyPromptChannels, promptChannelFields } from "../../shared/definition";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard } from "../SaveGuard";

// ==[HUMAN APPROVED]== The wording this surface shows for each standard command failure; the
// runner owns when each notice is shown, the editor owns what it says.
const EDITOR_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation could not be reached.",
	unreachable: "The Conversation could not be reached.",
};

export function ParticipantEditor({
	conversationId,
	conversation,
	participantId,
	onConversationChange,
	onNotice,
}: {
	conversationId: number;
	conversation: ConversationSummary;
	participantId: number;
	onConversationChange: (conversation: ConversationSummary) => void;
	onNotice: (notice: string | null) => void;
}) {
	const participant = conversation.cast.find(
		(candidate) => candidate.id === participantId,
	);
	const [drafts, setDrafts] = useState(() => ({
		name: participant?.name ?? "",
		prompt: participant?.prompt ?? emptyPromptChannels(),
		openingsText: participant ? openingsToText(participant.openings) : "",
	}));
	const [pending, setPending] = useState(false);
	const draftsRef = useRef(drafts);
	draftsRef.current = drafts;

	const dirty = participant !== undefined && (drafts.name !== participant.name || JSON.stringify(drafts.prompt) !== JSON.stringify(participant.prompt) || drafts.openingsText !== openingsToText(participant.openings));
	const apply = async () => {
		if (participant === undefined || !dirty || pending || drafts.name.trim() === "") return false;
		const submitted = drafts;
		let appliedSuccessfully = false;
		const action: ConversationAction = { type: "update-participant-definition", participantId: participant.id, definition: { name: drafts.name, prompt: drafts.prompt, openings: drafts.openingsText === openingsToText(participant.openings) ? participant.openings : openingsFromText(drafts.openingsText) } };
		setPending(true);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversationId, expectedRevision, action),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: onNotice,
				},
				notices: EDITOR_NOTICES,
				callbacks: {
					onApplied: (applied) => {
						appliedSuccessfully = true;
						const saved = applied.cast.find((p) => p.id === participant.id);
						if (saved) setDrafts((current) => JSON.stringify(current) === JSON.stringify(submitted)
							? { name: saved.name, prompt: saved.prompt, openingsText: openingsToText(saved.openings) }
							: current);
						onNotice(null);
					},
					// ==[HUMAN APPROVED]== This command family cannot produce these outcomes; the
					// server's precise reason is kept instead of a flattened class.
					onNotPlayable: (reason) => onNotice(reason),
					onNotRemovable: (reason) => onNotice(reason),
				},
			});
		} finally {
			setPending(false);
		}
		return appliedSuccessfully && draftsRef.current === submitted;
	};
	useSaveGuard({ dirty, saving: pending, save: apply, discard: () => undefined });
	if (participant === undefined) return <p className="panel-note">This Participant is no longer in the Cast.</p>;

	return (
		<div className="editor-frame"><div className="panel-body participant-editor">
			<section className="editor-section">
				<h3>Name</h3>
				<div className="apply-row">
					<input
						className="field-input"
						value={drafts.name}
						onChange={(event) =>
							setDrafts((current) => ({ ...current, name: event.target.value }))
						}
						aria-label="Participant name"
					/>
				</div>
			</section>

			<section className="editor-section">
				<h3>Prompt</h3>
				<div className="definition-form">
					{promptChannelFields.map((field) => (
						<div className="field" key={field.key}>
							<label htmlFor={`participant-prompt-${participant.id}-${field.key}`}>
								{field.label}
							</label>
							<textarea
								id={`participant-prompt-${participant.id}-${field.key}`}
								rows={2}
								value={drafts.prompt[field.key]}
								onChange={(event) =>
									setDrafts((current) => ({
										...current,
										prompt: {
											...current.prompt,
											[field.key]: event.target.value,
										},
									}))
								}
							/>
						</div>
					))}
				</div>
			</section>

			<section className="editor-section">
				<h3>Openings</h3>
				<div className="definition-form">
					<div className="field">
						<label htmlFor={`participant-openings-${participant.id}`}>Openings</label>
						<textarea
							id={`participant-openings-${participant.id}`}
							rows={3}
							value={drafts.openingsText}
							onChange={(event) =>
								setDrafts((current) => ({
									...current,
									openingsText: event.target.value,
								}))
							}
						/>
						<small>One Opening per line. Editing never rewrites history.</small>
					</div>
				</div>
			</section>

			<LoreAttachmentEditor owner="participant" ownerId={participant.id} disabled={pending} />
		</div><SaveFooter dirty={dirty} saving={pending} valid={drafts.name.trim().length > 0} onSave={() => void apply()} /></div>
	);
}
