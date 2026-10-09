import { Button } from "@/components/ui/button";
import type { DecisionSelection } from "../shared/contract/decision-model";
import { ProfileModelPicker } from "./ProfileModelPicker";

export function DecisionModelPicker({ selection, onChange, label }: {
	selection: Pick<DecisionSelection, "decisionProfileId" | "decisionModel">;
	onChange: (selection: Pick<DecisionSelection, "decisionProfileId" | "decisionModel">) => void;
	label: string;
}) {
	return <>
		<ProfileModelPicker
			apiFormat="system-one"
			selected={{ connectionProfileId: selection.decisionProfileId, modelId: selection.decisionModel }}
			onSelect={(profile, decisionModel) => onChange({ decisionProfileId: profile.id, decisionModel })}
			emptyLabel="Add a System One connection in Connections."
			label={label}
		/>
		{selection.decisionProfileId !== null && <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ decisionProfileId: null, decisionModel: "" })}>Clear selection</Button>}
	</>;
}
