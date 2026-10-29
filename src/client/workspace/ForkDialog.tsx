import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
				<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={trim} onChange={(event) => setTrim(event.target.checked)} />Trim Variants? (Destructive, will remove all other unselected variant data for the fork)</label>
				{(running || error !== null) && <p role="alert" className="text-sm text-destructive">{running ? "Cannot fork while a Generation is running." : error}</p>}
				<DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending || running || !forkName.trim()}>Fork</Button></DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
