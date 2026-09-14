import { Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../../connection-settings";

export function ConnectionProfileDeletion({ profile, onCancel, onDelete }: {
	profile: ConnectionProfile;
	onCancel: () => void;
	onDelete: () => void;
}) {
	return (
		<div className="connection-delete-confirmation" role="group" aria-label={`Delete ${profile.displayName}`}>
			<div><strong>Delete {profile.displayName}?</strong><span>Chats using it will need another model connection.</span></div>
			<div className="connection-delete-actions">
				<button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
				<button className="danger-button" type="button" onClick={onDelete}><Trash2 aria-hidden="true" /> Delete profile</button>
			</div>
		</div>
	);
}
