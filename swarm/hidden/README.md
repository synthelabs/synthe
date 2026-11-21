# The hidden problem set

`set.tar.gz.enc` is the hidden problem set for the Synthe score: an encrypted archive of problems that the swarm
never sees. The score shows how `synthe solve` does on problems it was not tuned to.

- The key is the secret `HIDDEN_SET_KEY`. It lives only in the `scoring` environment of this repository.
- `scripts/score/score.mjs` decrypts the set to a temporary folder, runs `solve` on each problem, and prints only
  totals. `.github/workflows/synthe-score.yml` runs it. The coordinator starts that workflow.
- The cipher is `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`.

This folder is frozen for the swarm. Do not try to decrypt the file, and do not tune Synthe to it. The public demo
set in `scripts/score/demo/` shows the layout of a problem.
