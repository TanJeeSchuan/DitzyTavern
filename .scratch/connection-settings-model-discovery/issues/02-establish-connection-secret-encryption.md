# 02 — Establish Connection Secret encryption and startup bootstrap

**What to build:** Establish the backend security boundary that can durably encrypt one Connection Profile secret payload and obtain its application-managed master key safely at startup, before any Profile UI depends on it.

**Blocked by:** None — can start immediately.

**Status:** complete — committed as `6d9af93`

- [x] `CONNECTION_SECRET_KEY` accepts exactly 32 cryptographically random bytes represented as Base64.
- [x] An explicitly injected valid key takes precedence and is never written back to local configuration.
- [x] An explicitly present but malformed key fails startup descriptively without printing key material.
- [x] When the key is absent, first startup generates it, preserves existing `.env` content, durably adds exactly one key entry, and uses that key in the current process.
- [x] A missing or unwritable `.env` destination causes fail-fast startup rather than an ephemeral in-memory or SQLite fallback.
- [x] One Profile secret payload round-trips through AES-256-GCM using a unique random 12-byte nonce, a 16-byte tag, format version, key identifier, and authenticated data bound to the stable Profile identity.
- [x] Database ciphertext contains no dedicated credential or custom-header plaintext.
- [x] Wrong-key, modified ciphertext, modified tag, and row-swapped authenticated data all fail closed without clearing or replacing stored ciphertext.
- [x] No master-key export/import, passphrase derivation, key rotation, or multiple-active-key behavior is introduced.
- [x] Focused tests cover bootstrap precedence/failure and cryptographic behavior through public module outcomes rather than crypto call order.
