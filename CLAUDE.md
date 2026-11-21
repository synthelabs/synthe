@AGENTS.md

## Claude Code only

A Stop hook (`.claude/settings.json` → `.claude/hooks/tests-must-pass.sh`) blocks you from finishing while typecheck or tests are red, whenever code differs from `origin/main`.

## How to write: Simplified Technical English, about 80%

Write everything a person reads in Simplified Technical English (ASD-STE100), applied at about 80%. This covers chat replies, reports, commit messages, pull request and issue text, and code comments. Follow the writing rules below. Use the STE dictionary as a guide, not a strict limit: a code name, file path, product name or exact technical term is correct even when STE does not list it.

- Keep sentences short: 20 words or fewer for an instruction, 25 or fewer for a description.
- Write one instruction in each sentence.
- Use the active voice. Use the imperative for instructions ("Run the tests", not "The tests should be run").
- Put a condition before its instruction: "If the test fails, read the log."
- Use one word for one thing. Do not change between synonyms.
- Use simple verb tenses. Do not use phrasal verbs ("set up", "carry out") when a single verb does the work ("configure", "do").
- Keep "the" and "a" in sentences.
- Use 3 words or fewer in a noun cluster.
- Write 6 sentences or fewer in a paragraph, with one topic in each paragraph.
- Use a numbered list for steps that occur in sequence.
- Do not use idioms, slang or figures of speech.

The other 20% is judgment: when a strict rule makes a sentence less clear, choose the clearer sentence. Text that Synthe shows to its users also follows the style line in `AGENTS.md` section 3. The two rules agree.
