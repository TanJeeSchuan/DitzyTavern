import { BookmarkPlus, MoreHorizontal, Sparkles, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type Seat = "human" | "model" | null;

export function ParticipantMenu({
	name,
	seat,
	pending,
	className,
	onAssignSeat,
	onSaveAsCharacter,
	onRemove,
}: {
	name: string;
	seat: Seat;
	pending: boolean;
	className?: string;
	onAssignSeat: (seat: "human" | "model") => void;
	onSaveAsCharacter: () => void;
	onRemove: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" size="icon-xs" variant="ghost" className={className} disabled={pending} aria-label={`Actions for ${name}`}><MoreHorizontal aria-hidden="true" /></Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuItem disabled={seat === "human"} onSelect={() => onAssignSeat("human")}>
					<UserRound aria-hidden="true" /> {seat === "model" ? "Swap to Writing as" : "Write as"} {name}
				</DropdownMenuItem>
				<DropdownMenuItem disabled={seat === "model"} onSelect={() => onAssignSeat("model")}>
					<Sparkles aria-hidden="true" /> {seat === "human" ? "Swap to Replying as" : "Reply as"} {name}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onSaveAsCharacter}><BookmarkPlus aria-hidden="true" /> Save as new Character</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" disabled={seat !== null} onSelect={onRemove}><Trash2 aria-hidden="true" /> {seat === null ? "Remove from Chat" : "Remove (holds a seat)"}</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
