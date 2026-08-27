# 08 — Add Assistant-prefill continuation

**What to build:** Let power users explicitly shape Continue as Assistant prefill when their endpoint handles it better. The selected strategy and suffix should affect only the provider request and must never mutate either stored Message.

**Blocked by:** 07 — Add instruction-based Continuation Generation.

**Status:** complete

- [x] Conversation Generation Settings expose Assistant prefill as an explicit alternative to instruction continuation.
- [x] Prefill suffix offers none, space, newline, and double newline values.
- [x] Assistant prefill submits the preceding model text in the adapter's supported assistant-prefix position.
- [x] The selected Prefill suffix is appended only to the request-time prefix.
- [x] The stored preceding Message and the new continuation Message contain no request-only suffix mutation.
- [x] Assistant prefill ignores the editable Continuation instruction.
- [x] An endpoint or adapter that cannot honor explicit Assistant prefill fails clearly instead of silently using instruction strategy.
- [x] Assistant prefill is unavailable for reasoning-only preceding Variants because Reasoning Content is excluded from later prompts.
- [x] Prompt inspection distinguishes Assistant prefill intent and suffix without presenting a synthetic Conversation Message.
- [x] Adapter contract tests capture the exact request role and prefix for all suffix options.
- [x] Instruction continuation remains unchanged after Assistant prefill is added.
