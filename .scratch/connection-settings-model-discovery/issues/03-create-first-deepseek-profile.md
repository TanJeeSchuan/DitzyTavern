# 03 — Create a first secure DeepSeek Connection Profile

**What to build:** Let a user open Connection Settings and create the first durable Profile from the DeepSeek Preset, including an encrypted initial credential, offline Apply, visible configured status, and later credential maintenance.

**Blocked by:** 02 — Establish Connection Secret encryption and startup bootstrap.

**Status:** complete

- [x] A new installation with zero Profiles remains usable but reports model generation as unconfigured.
- [x] Connection Settings expose a DeepSeek Preset that copies Chat Completions, `https://api.deepseek.com/`, `https://api.deepseek.com/models`, Automatic Backend, DeepSeek Adapter, and the approved V4 model defaults into an editable Profile.
- [x] Creating the first Profile persists its ordinary configuration and optional initial credential atomically and makes it active.
- [x] Profile display name is required and normalized, and the saved client representation exposes only credential configured/unconfigured state.
- [x] Profile Apply performs structural validation and persistence without making any provider request.
- [x] Later dedicated credential Set or Update replaces the encrypted value without returning old plaintext.
- [x] Dedicated credential Reset requires a distinct confirmed action, while ordinary Apply always leaves it untouched.
- [x] Stored Profile and Connection Secret state live outside Conversation data and use the global Connection Settings domain vocabulary.
- [x] The Settings UI follows the project design system and preserves unsaved draft values until Apply.
- [x] Contract and database tests verify the first-Profile transaction, active state, secret redaction, offline Apply, and zero-Profile outcome.
