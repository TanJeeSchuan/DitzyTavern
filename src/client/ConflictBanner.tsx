import { Button } from "@/components/ui/button";

/** @approved A draft that lost its save to a change elsewhere: keep the edits against that change, or load it. */
export function ConflictBanner({ message, onKeepMine, onLoadSaved }: { message: string; onKeepMine: () => void; onLoadSaved: () => void }) {
	return (
		<div className="conflict-banner" role="alert">
			<p>{message}</p>
			<div>
				<Button type="button" size="sm" onClick={onKeepMine}>Keep my edits</Button>
				<Button type="button" size="sm" variant="outline" onClick={onLoadSaved}>Load saved version</Button>
			</div>
		</div>
	);
}
