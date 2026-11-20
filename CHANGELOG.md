# Changelog

## Unreleased

- Removed Crimson Hacks event credit (event and team codes, the capped event proxy, workflow tracking receipts, round events and run records sent to the event server, and the time-limited "full" sharing level); Synthe now uses only your own Anthropic key, and the removed code is kept privately by the Synthe team. Existing setups keep working: run `npx synthe upgrade` to drop the old workflow inputs, and delete `.github/workflows/synthe-diagnostics.yml` if setup added it.
