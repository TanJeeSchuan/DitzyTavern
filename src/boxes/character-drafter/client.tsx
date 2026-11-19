import "./client.css";
import { UserRoundPen } from "lucide-react";
import type { BoxClientDefinition } from "@/box-sdk/client";
import { DraftFromStory } from "./client-participant";
import { DrafterWindow } from "./client-window";
import descriptor from "./shared-descriptor";

export default {
	descriptor,
	icon: UserRoundPen,
	Window: { size: { width: 26, height: 34 }, Panel: DrafterWindow },
	ParticipantSection: DraftFromStory,
} satisfies BoxClientDefinition;
