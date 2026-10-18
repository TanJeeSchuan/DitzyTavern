import { Drama } from "lucide-react";
import { digestWindow, type BoxClientDefinition } from "@/box-sdk/client";
import descriptor from "./shared-descriptor";

const moodWindow = digestWindow(descriptor, { icon: Drama, size: { width: 22, height: 26 } });
export default { descriptor, ...moodWindow } satisfies BoxClientDefinition;
