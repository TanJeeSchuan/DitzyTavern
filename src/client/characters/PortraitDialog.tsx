import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { imageAccept, imageSrc, prepareImage, type ImageDraft } from "../lib/image";
import { focalPosition } from "../story/Portrait";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const frames = [
	{ label: "Round", className: "size-16 rounded-[28%]" },
	{ label: "Square", className: "size-16 rounded-md" },
	{ label: "Wide", className: "h-16 w-32 rounded-md" },
] as const;

export function PortraitDialog({
	open,
	portrait,
	imageDraft,
	onOpenChange,
	onChange,
}: {
	open: boolean;
	portrait: PortraitImage | undefined;
	imageDraft: ImageDraft;
	onOpenChange: (open: boolean) => void;
	onChange: (portrait: PortraitImage | undefined) => void;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);

	const pick = async (file: File | undefined) => {
		if (file === undefined) return;
		try {
			const { hash } = await prepareImage(file, imageDraft);
			setError(null);
			onChange({ hash, focalX: 0.5, focalY: 0.5 });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "That file could not be read as an image.");
		}
	};

	const aim = (event: PointerEvent<HTMLDivElement>) => {
		if (portrait === undefined || (event.type === "pointermove" && event.buttons === 0)) return;
		const box = event.currentTarget.getBoundingClientRect();
		onChange({ ...portrait, focalX: clamp((event.clientX - box.left) / box.width), focalY: clamp((event.clientY - box.top) / box.height) });
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Portrait</DialogTitle>
					<DialogDescription>PNG, JPEG, WebP, or GIF up to 20 MB. The Portrait is shown wherever this identity appears and is never sent to the model.</DialogDescription>
				</DialogHeader>
				{portrait === undefined
					? <button type="button" className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:bg-muted/40" onClick={() => picker.current?.click()}><ImagePlus aria-hidden="true" /> Choose an image</button>
					: <>
						<div className="relative mx-auto w-fit cursor-crosshair touch-none select-none" onPointerDown={aim} onPointerMove={aim} aria-label="Set the focal point">
							<img src={imageSrc(portrait.hash)} alt="" draggable={false} className="max-h-64 max-w-full rounded-lg" />
							<span aria-hidden="true" className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style={{ left: `${portrait.focalX * 100}%`, top: `${portrait.focalY * 100}%` }} />
						</div>
						<p className="text-center text-xs text-muted-foreground">Click or drag to keep the important part in frame.</p>
						<div className="flex items-end justify-center gap-4">
							{frames.map((frame) => (
								<figure key={frame.label} className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
									<img src={imageSrc(portrait.hash)} alt="" className={`${frame.className} object-cover`} style={{ objectPosition: focalPosition(portrait) }} />
									<figcaption>{frame.label}</figcaption>
								</figure>
							))}
						</div>
					</>}
				{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
				<input ref={picker} type="file" accept={imageAccept} className="sr-only" aria-label="Portrait file" onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = ""; }} />
				<DialogFooter>
					{portrait !== undefined && <Button type="button" variant="ghost" className="mr-auto" onClick={() => onChange(undefined)}><Trash2 aria-hidden="true" /> Remove</Button>}
					{portrait !== undefined && <Button type="button" variant="outline" onClick={() => picker.current?.click()}><ImagePlus aria-hidden="true" /> Replace</Button>}
					<Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
