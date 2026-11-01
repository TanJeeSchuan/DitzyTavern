import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import type { ConnectionProfile } from "../../connection-settings";

const unreadableHelper = "The saved value cannot be decrypted with this server's master key. Enter it again or remove it.";

export function CredentialField({ id, label, value, onChange, saved, pending = false, onRemove, placeholder }: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	saved: ConnectionProfile["credentialState"];
	pending?: boolean;
	onRemove: () => void;
	placeholder: string;
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<Field htmlFor={id} label={label} helper={saved === "unreadable" ? unreadableHelper : "Stored apart from Chat data and never shown again after saving."}>
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<input
					id={id}
					className="field-input pl-8!"
					type="password"
					autoComplete="new-password"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					placeholder={saved === "none" ? placeholder : saved === "saved" ? "Saved · type to replace" : "Unreadable · type to replace"}
				/>
				</div>
				{saved !== "none" && <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={pending} onClick={() => setConfirming(true)}>Remove</Button>}
			</div>
			<Dialog open={confirming} onOpenChange={(open) => { if (!pending) setConfirming(open); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Remove saved {label}?</DialogTitle>
						<DialogDescription>The saved value is deleted now. You can enter a new one later.</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
						<Button type="button" variant="destructive" onClick={() => { setConfirming(false); onRemove(); }}>Remove</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Field>
	);
}
