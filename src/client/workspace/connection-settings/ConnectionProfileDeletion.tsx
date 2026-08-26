import { Trash2 } from "lucide-react";
import type { ConnectionProfile, ConnectionSettings } from "../../connection-settings";

type Props = {
	profile: ConnectionProfile;
	settings: ConnectionSettings;
	replacementProfileId: number | null;
	onReplacementChange: (value: number | null) => void;
	onCancel: () => void;
	onDelete: () => void;
};

export function ConnectionProfileDeletion({ profile, settings, replacementProfileId, onReplacementChange, onCancel, onDelete }: Props) {
	const needsReplacement = profile.id === settings.activeProfileId && settings.profiles.length > 1;
	return (
		<div className="connection-delete-confirmation" role="group" aria-label={`Delete ${profile.displayName}`}>
			<div><strong>Delete {profile.displayName}?</strong><span>This cannot be undone.</span></div>
			{needsReplacement && (
				<label className="field">
					<span>Set another connection as active</span>
					<select className="field-input" value={replacementProfileId ?? ""} onChange={(event) => onReplacementChange(event.target.value.length > 0 ? Number(event.target.value) : null)}>
						<option value="">Choose a connection</option>
						{settings.profiles.filter((entry) => entry.id !== profile.id).map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
					</select>
				</label>
			)}
			<div className="connection-delete-actions">
				<button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
				<button className="danger-button" type="button" onClick={onDelete}><Trash2 aria-hidden="true" /> Delete profile</button>
			</div>
		</div>
	);
}
