import "./client.css";
import { Brain } from "lucide-react";
import type { BoxClientDefinition } from "@/box-sdk/client";
import { MemoriesPanel } from "./client-inspector";
import { MemorySettingsEditor } from "./client-settings";
import { ParticipantMemory } from "./client-participant";
import { MemoryActivationDetails } from "./client-trace";
import descriptor from "./shared-descriptor";

export default {
	descriptor,
	icon: Brain,
	Inspector: { label: "Memories", Component: MemoriesPanel },
	Settings: MemorySettingsEditor,
	ParticipantSection: ParticipantMemory,
	TraceView: MemoryActivationDetails,
} satisfies BoxClientDefinition;
