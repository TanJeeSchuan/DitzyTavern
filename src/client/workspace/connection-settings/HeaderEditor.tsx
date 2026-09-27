import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { HeaderEditorData, HeaderEditorValue } from "../../connection-settings-state";

export function HeaderEditor({ data, onChange }: { data: HeaderEditorData; onChange: (data: HeaderEditorData) => void }) {
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const update = (key: string, patch: Partial<HeaderEditorValue>) => onChange({ ...data, [key]: { ...data[key]!, ...patch } });
	const drop = (key: string) => onChange(Object.fromEntries(Object.entries(data).filter(([candidate]) => candidate !== key)));
	const newName = name.trim();
	const add = () => { onChange({ ...data, [newName]: { configured: false, operation: "replace", replacement: value } }); setName(""); setValue(""); };
	return (
		<div className="grid gap-2">
			{Object.entries(data).map(([key, header]) => (
				<div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
					<span className={`truncate font-mono text-xs ${header.operation === "remove" ? "text-muted-foreground line-through" : ""}`} title={key}>{key}</span>
					{header.operation === "replace"
						? <input className="field-input" type="password" aria-label={`${key} value`} value={header.replacement} onChange={(event) => update(key, { replacement: event.target.value })} placeholder={header.configured ? "New value" : "Value"} autoComplete="off" />
						: <span className="text-xs text-muted-foreground">{header.operation === "remove" ? "Removed on save" : "Saved value"}</span>}
					<span className="flex justify-end">
						{!header.configured
							? <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${key}`} onClick={() => drop(key)}><X aria-hidden="true" /></Button>
							: header.operation === "keep"
								? <>
									<Button type="button" size="sm" variant="ghost" onClick={() => update(key, { operation: "replace" })}>Replace</Button>
									<Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${key}`} onClick={() => update(key, { operation: "remove" })}><X aria-hidden="true" /></Button>
								</>
								: <Button type="button" size="sm" variant="ghost" onClick={() => update(key, { operation: "keep", replacement: "" })}>{header.operation === "remove" ? "Undo" : "Cancel"}</Button>}
					</span>
				</div>
			))}
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
				<input className="field-input font-mono text-xs!" aria-label="New header name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Header name" autoComplete="off" />
				<input className="field-input" type="password" aria-label="New header value" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Value" autoComplete="off" />
				<Button type="button" size="icon-sm" variant="outline" aria-label="Add header" disabled={newName.length === 0 || newName in data} onClick={add}><Plus aria-hidden="true" /></Button>
			</div>
		</div>
	);
}
