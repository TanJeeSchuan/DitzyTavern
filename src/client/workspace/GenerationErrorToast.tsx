import { CircleAlert, X } from "lucide-react";
import { Toast } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { publishConnectionSettings } from "../connection-settings-query";
import { setTextOnlyModel } from "../connection-settings";
import type { GenerationImageModel } from "../../shared/contract/generation-events";

// @approved
// Horizontally marks the image model after a Generation fails: it owns the
// toast lifecycle and the mark-text-only flow, fed by the failure read from
// the generation controller.
export function GenerationErrorToast({ error, imageModel, retry, acknowledge }: {
	error: string | null;
	imageModel: GenerationImageModel | null;
	retry: (() => void) | null;
	acknowledge: () => void;
}) {
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const [marking, setMarking] = useState(false);
	const [markError, setMarkError] = useState<string | null>(null);
	useEffect(() => {
		if (error !== null) setOpen(true);
		setMarkError(null);
	}, [error]);

	const markFailedModelTextOnly = async (afterMark: boolean) => {
		const model = imageModel;
		if (model === null || marking) return;
		setMarking(true);
		setMarkError(null);
		const settings = await setTextOnlyModel(model.connectionProfileId, model.modelId, true);
		if (settings === null) setMarkError("The text-only mark could not be saved.");
		else {
			publishConnectionSettings(client, settings);
			acknowledge();
			if (afterMark) retry?.();
		}
		setMarking(false);
	};

	if (error === null) return null;
	return (
		<Toast.Root
			className="workspace-toast generation-error-toast"
			type="foreground"
			open={open}
			duration={imageModel === null ? undefined : Infinity}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) acknowledge();
			}}
		>
			<div className="workspace-toast-body">
				<div className="workspace-toast-heading"><CircleAlert aria-hidden="true" /><Toast.Title>Generation failed</Toast.Title></div>
				<Toast.Description className="workspace-toast-description">{error}</Toast.Description>
				{imageModel !== null && <>
					<p className="workspace-toast-description">
						This Generation sent Images to <span className="font-mono">{imageModel.modelId}</span>
						. If it cannot read Images, mark it text-only to send their names instead.
					</p>
					{markError !== null && <p className="workspace-toast-description text-destructive" role="alert">{markError}</p>}
					<div className="workspace-toast-actions">
						<Button type="button" size="xs" variant="outline" disabled={marking} onClick={() => void markFailedModelTextOnly(false)}>Mark text-only</Button>
						{retry !== null && <Button type="button" size="xs" disabled={marking} onClick={() => void markFailedModelTextOnly(true)}>Mark text-only and retry</Button>}
					</div>
				</>}
			</div>
			<Toast.Close className="icon-button" aria-label="Dismiss generation error">
				<X aria-hidden="true" />
			</Toast.Close>
		</Toast.Root>
	);
}
