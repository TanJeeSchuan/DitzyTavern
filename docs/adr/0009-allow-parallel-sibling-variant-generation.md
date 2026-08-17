# Allow parallel sibling Variant generation

A Conversation may run multiple Generations concurrently only when every Generation targets a sibling Variant of the same latest model-generated Message and uses the same frozen history position. This enables rapid alternative sampling without allowing separate Conversation turns to race.

Each sibling Generation compiles and captures its own Prompt Plan and effective Generation Settings when it starts. The user may edit Participant Prompts, model, sampling parameters, or extra request body fields while siblings run; subsequently started Variants observe those changes while already active Generations continue unchanged. Siblings therefore share a response position and prior Conversation history, not necessarily an identical prompt or model configuration.

The server retains each captured Prompt Plan only while its Generation is active so connected clients can inspect the actual in-flight input. A completed Variant persists its effective Generation Settings and compact outcome metadata, but not the full Prompt Plan. This avoids repeatedly copying selected Conversation history into every Variant and causing quadratic storage growth.

The active response position is the concurrency boundary. A new Message, Control swap, or other history mutation is blocked until every sibling Generation has completed or been stopped.

Each Swipe immediately creates and selects a provisional Variant while existing sibling Generations continue in the background. The Variant becomes durable after emitting visible Content or Reasoning Content; if it fails or is stopped with neither, the server removes it and restores the previously selected Variant.

Variant selection remains available while sibling Generations run. Switching selection does not cancel, pause, or reprioritize any Generation; it changes only the shared displayed Variant and, once the active response position closes, the content used by future prompt assembly.

Stop cancels only the selected Variant's Generation; Stop All cancels every active sibling. A stopped Variant that has emitted visible Content or Reasoning Content remains as an interrupted durable Variant under the normal interruption rules.

The server enforces a configurable per-Conversation limit on concurrent sibling Generations, defaulting to four. Additional Swipes are rejected rather than queued until a slot becomes available.
