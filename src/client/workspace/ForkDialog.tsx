import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function ForkDialog({ name, running, onClose, onFork }: {
	name: string;
	running: boolean;
	onClose: () => void;
	onFork: (name: string, trimVariants: boolean) => Promise<string | null>;
}) {
	const [forkName, setForkName] = useState(`${name} (fork)`);
	const [trim, setTrim] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trimId = useId();
	return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
		<DialogContent showCloseButton={false} className="sm:max-w-md">
			<DialogHeader><DialogTitle>Fork Chat</DialogTitle><DialogDescription>Create an independent Chat from this point.</DialogDescription></DialogHeader>
			<form onSubmit={async (event) => {
				event.preventDefault();
				setPending(true);
				setError(await onFork(forkName, trim));
				setPending(false);
			}} className="flex flex-col gap-4">
				<label className="flex flex-col gap-2 text-sm">Name<Input value={forkName} onChange={(event) => setForkName(event.target.value)} autoFocus /></label>
				<span className="flex items-start justify-between gap-3"><Label htmlFor={trimId} className="text-sm font-normal">Trim Variants? (Destructive, will remove all other unselected variant data for the fork)</Label><Switch id={trimId} checked={trim} onCheckedChange={setTrim} /></span>
				{(running || error !== null) && <p role="alert" className="text-sm text-destructive">{running ? "Cannot fork while a Generation is running." : error}</p>}
				<DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending || running || !forkName.trim()}>Fork</Button></DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
