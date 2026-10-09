import { ArrowLeftRight, X } from "lucide-react";
import { Toast } from "radix-ui";
import { useImperativeHandle, useRef, useState, type Ref } from "react";

export type ControlChangeToasterHandle = { show: (text: string) => void };

// Shows the control-change confirmation; controls trigger it through the
// `show` handle so the toast owns its own lifecycle instead of the workspace.
export function ControlChangeToaster({ ref }: { ref?: Ref<ControlChangeToasterHandle> }) {
	const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
	const messageId = useRef(0);
	useImperativeHandle(ref, () => ({
		show: (text) => setToast({ text, id: ++messageId.current }),
	}), []);

	if (toast === null) return null;
	return (
		<Toast.Root
			key={toast.id}
			className="workspace-toast control-change-toast"
			defaultOpen
			duration={3_000}
			onOpenChange={(open) => {
				if (!open) window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 180);
			}}
		>
			<div className="workspace-toast-body">
				<div className="workspace-toast-heading"><ArrowLeftRight aria-hidden="true" /><Toast.Title>Control changed</Toast.Title></div>
				<Toast.Description className="workspace-toast-description">{toast.text}</Toast.Description>
			</div>
			<Toast.Close className="icon-button" aria-label="Dismiss control change"><X aria-hidden="true" /></Toast.Close>
		</Toast.Root>
	);
}
