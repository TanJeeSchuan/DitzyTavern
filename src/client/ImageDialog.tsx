import { createContext, useContext, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { imageSrc } from "./lib/image";

export interface OpenedImage {
	hash: string;
	name: string;
	insertAfter?: (text: string) => boolean;
}

const ImageDialogContext = createContext<((target: EventTarget, insertion?: Pick<OpenedImage, "insertAfter">) => void) | null>(null);

export function ImageDialogProvider({ children, actions }: { children: ReactNode; actions?: (image: OpenedImage) => ReactNode }) {
	const [opened, setOpened] = useState<OpenedImage | null>(null);
	const [openImageAt] = useState(() => (target: EventTarget, insertion?: Pick<OpenedImage, "insertAfter">) => {
		const element = target instanceof Element ? target.closest<HTMLElement>("[data-image-hash]") : null;
		if (element?.dataset.imageHash !== undefined && element.dataset.missing === undefined) {
			setOpened({ hash: element.dataset.imageHash, name: element.dataset.imageName ?? "", ...insertion });
		}
	});
	return (
		<ImageDialogContext value={openImageAt}>
			{children}
			<Dialog open={opened !== null} onOpenChange={(open) => { if (!open) { setOpened(null); } }}>
				<DialogContent className="flex max-h-[calc(100dvh-2rem)] w-fit max-w-[calc(100%-2rem)] flex-col gap-2 sm:max-w-[min(56rem,calc(100%-2rem))]">
					<DialogTitle className="truncate pr-8">{opened?.name}</DialogTitle>
					<DialogDescription className="sr-only">Full size image</DialogDescription>
					{opened !== null && <img src={imageSrc(opened.hash)} alt={opened.name} className="min-h-0 max-h-[78dvh] max-w-full flex-1 rounded-lg object-contain" />}
					{opened !== null && actions?.(opened)}
				</DialogContent>
			</Dialog>
		</ImageDialogContext>
	);
}

export const useOpenImageAt = () => useContext(ImageDialogContext)!;
