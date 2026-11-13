import type { ComponentProps } from "react";
import { Tooltip } from "radix-ui";

export function MessageAction({ label, children, disabled, onClick, title, className = "edit-action", ...props }: ComponentProps<"button"> & { label: string }) {
	return <Tooltip.Root>
		<Tooltip.Trigger asChild><button {...props} type="button" className={className} aria-disabled={disabled || undefined} title={title}
			onClick={(event) => { if (disabled) { event.preventDefault(); return; } onClick?.(event); }}>
			{children}<span className="advanced-action-label">{label}</span>
		</button></Tooltip.Trigger>
		<Tooltip.Portal><Tooltip.Content sideOffset={6} className="message-action-tooltip z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
			{title ?? label}
		</Tooltip.Content></Tooltip.Portal>
	</Tooltip.Root>;
}
