import { Elysia, t } from "elysia";

export const contract = new Elysia().get(
  "/api/health",
  () => ({ ok: true }),
  {
    response: t.Object({
      ok: t.Boolean(),
    }),
  },
);

export type Contract = typeof contract;
