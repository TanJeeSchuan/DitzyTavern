import { useContext, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOpenImageAt } from "./ImageDialog";
import { IllustrationActionsContext, useGallery, usePaintingCommand } from "./painting";
import { baseName, imageAccept, imageSrc, uploadImage } from "./lib/image";

export function Gallery({ conversationId, paint }: {
	conversationId: number;
	paint?: { disabled: boolean; onReference: (name: string, hash: string) => void; onUseBrief: (brief: string, ask: string) => void };
}) {
	const read = useGallery(conversationId);
	const actions = useContext(IllustrationActionsContext)!;
	const openImageAt = useOpenImageAt();
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const picker = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const upload = async (files: File[]) => {
		setUploading(true);
		setUploadError(null);
		try {
			for (const file of files) if (!await submit({ type: "add-to-gallery", name: baseName(file.name), hash: (await uploadImage(file)).hash })) return;
		} catch (cause) {
			setUploadError(cause instanceof Error ? cause.message : "That file could not be read as an image.");
		} finally { setUploading(false); }
	};
	return <section className="grid min-w-0 gap-2" aria-label="Gallery">
		<div className="flex items-center justify-between gap-2">
			{paint && <h3 className="text-sm font-medium">Gallery</h3>}
			<Button size="sm" variant="ghost" disabled={uploading} onClick={() => picker.current?.click()}><ImagePlus aria-hidden="true" />{uploading ? "Uploading…" : "Upload"}</Button>
			<input ref={picker} type="file" accept={imageAccept} multiple className="sr-only" aria-label="Upload to Gallery" tabIndex={-1}
				onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = ""; }} />
		</div>
		{read.isError ? <p role="alert" className="text-sm text-destructive">Gallery could not be loaded. <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry</Button></p>
			: read.isPending ? <div className="flex gap-3 overflow-hidden" aria-hidden="true">{[0, 1, 2].map((key) => <div key={key} className="grid w-36 shrink-0 gap-2">
				<div className="skeleton h-24 rounded-lg" /><div className="skeleton h-3 w-24 rounded" /><div className="skeleton h-8 rounded" /><div className="skeleton h-8 rounded" />
			</div>)}</div>
				: read.data.length === 0 ? <p className="panel-note">Pictures from this Chat and its Cast, and pictures you upload, appear here.</p>
					: <ul className={cn("gap-3 p-1", paint ? "flex overflow-x-auto" : "grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]")} role="list">
						{read.data.map(({ hash, name, keptId, painted }) => <li key={hash} className={cn("grid content-start gap-1", paint && "w-36 shrink-0")}>
							<button type="button" className="prose-image gallery-thumbnail"
								aria-label={`Open ${name} full size`} data-image-hash={hash} data-image-name={name} onClick={(event) => openImageAt(event.currentTarget)}>
								<img src={imageSrc(hash)} alt={name} loading="lazy" />
							</button>
							<p className="truncate text-xs text-muted-foreground" title={name}>{name}</p>
							{paint && <Button size="sm" variant="ghost" className="justify-start px-1" aria-label={`Use as reference: ${name}`} disabled={paint.disabled} onClick={() => paint.onReference(name, hash)}>Use as reference</Button>}
							<Button size="sm" variant="ghost" className="justify-start px-1" aria-label={`Add to composer: ${name}`} disabled={actions.addToComposer === null} onClick={() => actions.addToComposer?.(name, hash)}>Add to composer</Button>
							{paint && painted !== undefined && <Button size="sm" variant="ghost" className="justify-start px-1" aria-label={`Use Brief: ${name}`}
								disabled={paint.disabled} onClick={() => paint.onUseBrief(painted.brief, painted.ask)}>Use Brief</Button>}
							{keptId !== undefined && <Button size="sm" variant="ghost" className="justify-start px-1 text-destructive" aria-label={`Remove from Gallery: ${name}`}
								disabled={pending} onClick={() => void submit({ type: "remove-from-gallery", id: keptId })}>Remove from Gallery</Button>}
						</li>)}
					</ul>}
		{(uploadError ?? error) !== null && <p role="alert" className="text-sm text-destructive">{uploadError ?? error}</p>}
	</section>;
}
