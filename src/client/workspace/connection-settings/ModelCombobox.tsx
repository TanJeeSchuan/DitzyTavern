import { ChevronsUpDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ModelCombobox({ id, value, options, onChange, refreshDisabledReason, refreshing, onRefresh }: {
	id: string;
	value: string;
	options: string[];
	onChange: (modelId: string) => void;
	refreshDisabledReason?: string | undefined;
	refreshing?: boolean;
	onRefresh?: (() => void) | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const typed = search.trim();
	const choose = (modelId: string) => { onChange(modelId); setOpen(false); setSearch(""); };
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button id={id} type="button" role="combobox" aria-expanded={open} className="field-input flex items-center justify-between gap-2 text-left">
					<span className={value ? "truncate font-mono text-[0.78rem]" : "text-muted-foreground"}>{value || "Choose a model"}</span>
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
				<Command>
					<CommandInput placeholder="Search or type a model ID" value={search} onValueChange={setSearch} />
					<CommandList>
					<CommandEmpty>No suggestions. {onRefresh === undefined ? "Type a model ID." : "Refresh the catalog or type an ID."}</CommandEmpty>
						{typed.length > 0 && !options.includes(typed) && (
							<CommandGroup>
								<CommandItem value={typed} onSelect={() => choose(typed)}>Use “<span className="font-mono">{typed}</span>”</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup>
							{options.map((modelId) => (
								<CommandItem key={modelId} value={modelId} data-checked={modelId === value} className="font-mono text-xs" onSelect={() => choose(modelId)}>{modelId}</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
					{onRefresh !== undefined && (
						<div className="flex items-center justify-between gap-2 border-t border-border px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">
							<span className="pl-1">{options.length === 1 ? "1 model" : `${options.length} models`}</span>
							<span title={refreshDisabledReason}>
								<Button type="button" size="xs" variant="ghost" disabled={refreshDisabledReason !== undefined} aria-busy={refreshing} onClick={onRefresh}>
									<RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden="true" /> {refreshing ? "Refreshing" : "Refresh"}
								</Button>
							</span>
						</div>
					)}
				</Command>
			</PopoverContent>
		</Popover>
	);
}
