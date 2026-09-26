import { Pin, Plus, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LibraryPickerEntry } from "../cast";
import { Portrait } from "../story/Portrait";

export function AddParticipantMenu({
	entries,
	pending,
	onAddCharacter,
	onAddBlank,
}: {
	entries: readonly LibraryPickerEntry[];
	pending: boolean;
	onAddCharacter: (characterId: number, revision: number) => void;
	onAddBlank: (name: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const close = () => { setOpen(false); setQuery(""); };

	return (
		<Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="ghost" disabled={pending}><UserPlus aria-hidden="true" /> Add</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-0">
				<Command>
					<CommandInput value={query} onValueChange={setQuery} placeholder="Search the Library or type a name" />
					<CommandList>
						{entries.length > 0 && (
							<CommandGroup heading="From the Library">
								{entries.map((entry) => (
									<CommandItem key={entry.character.id} value={`${entry.label} ${entry.character.id}`} keywords={[entry.preview]} onSelect={() => { close(); onAddCharacter(entry.character.id, entry.character.revision); }}>
										<Portrait name={entry.label} size="small" />
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1 truncate font-medium">{entry.label}{entry.character.pinned && <Pin aria-label="Pinned" className="size-3 text-muted-foreground" />}</span>
											<span className="block truncate text-xs text-muted-foreground">{entry.usedCount > 0 ? `In this Chat${entry.usedCount > 1 ? ` ×${entry.usedCount}` : ""} · ` : ""}{entry.preview}</span>
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						<CommandSeparator />
						<CommandGroup forceMount>
							<CommandItem forceMount value="__new-chat-only" onSelect={() => { close(); onAddBlank(query.trim() || "New Participant"); }}>
								<Plus aria-hidden="true" />
								<span className="truncate">New chat-only Participant{query.trim() !== "" && <> “{query.trim()}”</>}</span>
							</CommandItem>
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
