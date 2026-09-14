import { Ellipsis, Plus, Trash2 } from "lucide-react";
import type { ConnectionProfile, ConnectionPreset, ConnectionSettings } from "../../connection-settings";

type Props = {
	settings: ConnectionSettings;
	presets: ConnectionPreset[];
	selectedProfileId: number | null;
	presetChoicesOpen: boolean;
	openProfileMenuId: number | null;
	onChooseProfile: (profile: ConnectionProfile) => void;
	onRequestDeletion: (profile: ConnectionProfile) => void;
	onTogglePresets: () => void;
	onToggleProfileMenu: (profileId: number | null) => void;
	onChoosePreset: (preset: ConnectionPreset) => void;
};

export function ConnectionProfileList({
	settings,
	presets,
	selectedProfileId,
	presetChoicesOpen,
	openProfileMenuId,
	onChooseProfile,
	onRequestDeletion,
	onTogglePresets,
	onToggleProfileMenu,
	onChoosePreset,
}: Props) {
	return (
		<section className="connection-profile-section">
			<h3>Connections</h3>
			<p>Choose the connection to edit or add a new one.</p>
			{settings.profiles.length === 0 && (
				<div className="connection-empty-state">
					<strong>Model generation is unconfigured.</strong>
					<span>Add a connection to start generating. Chats and imports remain available.</span>
				</div>
			)}
			{settings.profiles.length > 0 && (
				<div className="connection-profile-list" aria-label="Connections">
					{settings.profiles.map((profile) => (
						<div className="connection-profile-card" key={profile.id} data-selected={profile.id === selectedProfileId}>
							<button className="connection-profile-choice" type="button" onClick={() => onChooseProfile(profile)}>
								<span>{profile.displayName}</span>
								<small>
									Available to every Chat{profile.credentialConfigured ? ", credential saved" : ", no credential saved"}
								</small>
							</button>
							<details
								className="connection-profile-menu"
								open={profile.id === openProfileMenuId}
							>
								<summary
									aria-label={`More actions for ${profile.displayName}`}
									onClick={(event) => {
										event.preventDefault();
										onToggleProfileMenu(openProfileMenuId === profile.id ? null : profile.id);
									}}
								><Ellipsis aria-hidden="true" /></summary>
								<div>
									<button type="button" onClick={() => onRequestDeletion(profile)}><Trash2 aria-hidden="true" /> Delete profile</button>
								</div>
							</details>
						</div>
					))}
				</div>
			)}
			<div className="connection-add-area">
				<button className="secondary-button" type="button" aria-expanded={presetChoicesOpen} onClick={onTogglePresets}>
					<Plus aria-hidden="true" /> Add connection
				</button>
				{presetChoicesOpen && (
					<div className="connection-preset-list" aria-label="Connection presets">
						{presets.map((preset) => (
							<button type="button" className="secondary-button" key={preset.id} onClick={() => onChoosePreset(preset)}>
								{preset.label === "Generic OpenAI Compatible" ? "OpenAI Compatible" : preset.label}
							</button>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
