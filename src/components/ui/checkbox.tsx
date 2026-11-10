import type { ComponentProps } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
	return <CheckboxPrimitive.Root data-slot="checkbox" className={cn("peer size-4 shrink-0 rounded border border-input shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground", className)} {...props}>
		<CheckboxPrimitive.Indicator className="flex items-center justify-center"><Check className="size-3.5" /></CheckboxPrimitive.Indicator>
	</CheckboxPrimitive.Root>;
}
