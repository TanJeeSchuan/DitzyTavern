import { projectImageAnchors, sanitizeImageName } from "./image-reference";

export const briefWithReferences = (brief: string, references: string): string => references.trim() ? `${brief}\n\n---\n\n${references}` : brief;

export const illustrationName = (ask: string): string => ask.trim() ? sanitizeImageName(projectImageAnchors(ask).trim().split(/\s+/).slice(0, 6).join(" ")) : "Illustration";
