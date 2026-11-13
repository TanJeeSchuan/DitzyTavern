import type { ComponentProps } from "react";
import { Tooltip } from "radix-ui";

export function MessageAction({ label, children, className = "edit-action", ...props }: ComponentProps<"button"> & { label: string }) {
	return <Tooltip.Root>
		<Tooltip.Trigger asChild><button {...props} type="button" className={className}>
			{children}<span className="advanced-action-label">{label}</span>
		</button></Tooltip.Trigger>
		<Tooltip.Portal><Tooltip.Content sideOffset={6} className="message-action-tooltip z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
			{label}
		</Tooltip.Content></Tooltip.Portal>
	</Tooltip.Root>;
}
