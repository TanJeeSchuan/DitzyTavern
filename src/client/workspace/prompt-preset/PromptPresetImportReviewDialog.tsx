import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SillyTavernImportPreview } from "../../prompt-preset-library";
import { outgoingRoleLabels, promptPresetSelectClass, slotTitle } from "../../prompt-preset-presentation";
import type { SillyTavernReview } from "../../prompt-preset-editor-state";

const importedSlotRole = (slot: SillyTavernImportPreview["native"]["slots"][number]): string =>
	slot.reference === "history" ? "History message roles" : outgoingRoleLabels[slot.role];

export function PromptPresetImportReviewDialog({
	review,
	busy,
	onOrderSelect,
	onCancel,
	onCommit,
}: {
	review: SillyTavernReview | null;
	busy: boolean;
	onOrderSelect: (orderListId: string) => void;
	onCancel: () => void;
	onCommit: () => void;
}) {
	return (
		<Dialog open={review !== null} onOpenChange={(next) => { if (!next) onCancel(); }}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Review SillyTavern import</DialogTitle>
					<DialogDescription>
						Review the converted blocks and diagnostics before creating an independent native preset.
					</DialogDescription>
				</DialogHeader>
				{review !== null && (
					<>
						{review.preview.requiresOrderSelection && (
							<label className="flex flex-col gap-1 text-sm">
								<span>Choose an order list</span>
								<select
									className={promptPresetSelectClass}
									value={review.orderListId ?? ""}
									disabled={busy}
									onChange={(event) => onOrderSelect(event.target.value)}
								>
									<option value="">Choose an order…</option>
									{review.preview.orderLists.map((order) => (
										<option key={order.id} value={order.id}>{order.label} ({order.entryCount} entries)</option>
									))}
								</select>
							</label>
						)}
						<section aria-label="Converted blocks" className="flex flex-col gap-2">
							<h2 className="text-sm font-medium">Converted blocks</h2>
							<ol className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
								{review.preview.native.slots.map((slot, index) => (
									<li key={`${slot.reference}-${index}`} className={slot.enabled ? "" : "opacity-60"}>
										<div className="flex flex-wrap items-baseline gap-x-2">
											<span>{index + 1}. {slotTitle(slot)}{slot.enabled ? "" : " (disabled)"}</span>
											<span className="text-xs text-muted-foreground">{importedSlotRole(slot)}</span>
										</div>
										{slot.reference === "instruction" && (
											<pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">{slot.content || "(empty authored content)"}</pre>
										)}
									</li>
								))}
							</ol>
						</section>
						<section aria-label="Import diagnostics" className="flex flex-col gap-1">
							<h2 className="text-sm font-medium">Diagnostics</h2>
							{review.preview.diagnostics.length === 0 ? (
								<p className="text-sm text-muted-foreground">No unsupported behavior was detected.</p>
							) : (
								<ul className="text-sm text-muted-foreground">
									{review.preview.diagnostics.map((item, index) => (
										<li key={`${item.code}-${item.identifier ?? index}`}>{item.message}</li>
									))}
								</ul>
							)}
						</section>
						<div className="flex flex-wrap justify-end gap-2">
							<Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
							<Button disabled={busy || review.preview.requiresOrderSelection} onClick={onCommit}>Import as native preset</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
