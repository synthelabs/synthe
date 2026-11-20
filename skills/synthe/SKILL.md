---
name: synthe
description: >-
  Set up Synthe in a GitHub repo by following its setup guide. Synthe is an open-source
  GitHub Action that makes an AI agent's system prompt better on its own: it tests small changes
  against checks the team confirms and keeps a change only when it is clearly better. Its improve
  mode raises a number the team chooses, such as tests passing. Use when the user asks to set up,
  install or configure Synthe, mentions npx synthe, wants their AI agent's prompt improved with
  checks or tests, or asks what Synthe did in their repo.
---

# Synthe

The setup steps live in one place: the guide that the Synthe CLI prints. Do not set Synthe up from memory or from this file. The guide changes with each release.

## Steps

1. From the root of the user's repo, run:

   ```
   npx --yes synthe@latest guide
   ```

2. Read all of the output before you act. It is long. If your tool shows only part of it, print it again in parts (for example, pipe it through `sed -n '1,120p'`, then `sed -n '121,240p'`, and so on) until you have read the end.
3. Follow the guide in order. It is written for coding agents. It says which questions to ask the person and which commands to run.
4. Do not run any other Synthe command before you have read the guide. Some commands spend the person's own Anthropic credit.

If `npx` is not available, ask the person to install Node.js 20 or newer, then run step 1 again.
