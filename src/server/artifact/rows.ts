import { artifactTable } from "../database/schema";

// @approved
//  The persisted artifact row shape, derived from the Drizzle table so the
// module and tests can never drift from the schema.
export type ArtifactRow = typeof artifactTable.$inferSelect;