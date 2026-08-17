# Isolate the Actor Profile library

Reusable Actor Profiles will live in a deep Profile Library module exposing a small interface for listing and reading Profiles and executing Profile commands. The module owns Profile lifecycle, Master Prompts, Tavern Card import, permanent deletion, and copying a Participant into a new Profile.

The Conversation module receives copied Participant data and does not depend on Profile lifecycle or preserve live Master Prompt links. An Add-from-Profile command always creates a new Participant fork; switching to a previously used identity is instead a Roster operation owned by the Conversation module.
