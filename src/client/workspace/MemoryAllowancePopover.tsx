import { Gauge } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { saveMemoryAllowance, type ConversationMemoryAllowance } from "../memories";

export function MemoryAllowancePopover({
	conversationId,
	settings,
	onSaved,
}: {
	conversationId: number;
	settings: ConversationMemoryAllowance;
	onSaved: (settings: ConversationMemoryAllowance) => void;
}) {
	const [value, setValue] = useState(String(settings.allowance));
	const [revision, setRevision] = useState(settings.revision);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setPending(true); setMessage(null);
		const result = await saveMemoryAllowance(conversationId, revision, Number(value));
		if (result.outcome === "applied") { onSaved(result.settings); setRevision(result.settings.revision); setValue(String(result.settings.allowance)); setMessage({ tone: "note", text: "Saved." }); }
		else if (result.outcome === "conflict") {
			onSaved(result.currentSettings);
			setRevision(result.currentSettings.revision);
			setValue(String(result.currentSettings.allowance));
			setMessage({ tone: "problem", text: "The allowance changed elsewhere. Review the current value before saving again." });
		}
		else setMessage({ tone: "problem", text: result.reason });
		setPending(false);
	};
	return <Popover onOpenChange={(open) => { if (open) { setRevision(settings.revision); setValue(String(settings.allowance)); setMessage(null); } }}>
		<PopoverTrigger asChild><button type="button" className="icon-button" aria-label="Memory Allowance" title="Memory Allowance"><Gauge aria-hidden="true" /></button></PopoverTrigger>
		<PopoverContent align="end" className="memory-allowance">
			<PopoverHeader>
				<PopoverTitle>Memory Allowance</PopoverTitle>
				<PopoverDescription>A ceiling for recalled Memory text in one Generation. Zero keeps remembering on and retains saved Memories.</PopoverDescription>
			</PopoverHeader>
			<form onSubmit={(event) => void save(event)}>
				<label className="field">
					<span className="field-label">Estimated tokens</span>
					<input
						className="field-input"
						type="number"
						min="0"
						step="1"
						value={value}
						onChange={(event) => setValue(event.target.value)}
					/>
				</label>
				<Button type="submit" size="sm" disabled={pending || value === String(settings.allowance)}>Save</Button>
			</form>
			{message && <p className={message.tone === "problem" ? "import-problem" : "memory-empty"} role={message.tone === "problem" ? "alert" : "status"}>{message.text}</p>}
		</PopoverContent>
	</Popover>;
}
