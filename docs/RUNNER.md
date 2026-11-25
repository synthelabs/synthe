# Run Synthe on a machine that is replaced

Use this guide when Synthe runs on a machine that can stop at any time, such as a VM that is replaced every hour.
A replacement stops every process, but the home folder stays. So Synthe keeps all its state in files. A queue
folder holds the jobs, and `tick` runs them. If a job is cut off, the next `tick` continues it with
`solve --resume`.

## 1. Install the tools under the home folder

Install everything under your home folder (`$HOME`). A program installed outside it is lost at each replacement.

1. Install Node.js 20 or later under `~/.local`. For example, use the tarball from nodejs.org:

   ```
   mkdir -p ~/.local && curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | tar -xJ -C ~/.local --strip-components=1
   ```

2. Put `~/.local/bin` first on your `PATH` in `~/.profile` or `~/.bashrc`:

   ```
   export PATH="$HOME/.local/bin:$PATH"
   ```

3. Tell npm to install global packages in the home folder too:

   ```
   npm config set prefix ~/.local
   ```

4. Install a coding agent for the proposer of your problem files. Install one of these:

   ```
   npm install -g @anthropic-ai/claude-code    # Claude Code
   npm install -g @openai/codex                # Codex
   ```

5. Clone the repositories of your jobs under the home folder too, for example in `~/work`.

## 2. Add jobs

Make one queue folder under the home folder. Add one job for each problem file:

```
npx synthe queue add ~/synthe-queue ~/work/app/synthe.problem.json --out ~/results/app
```

The words after the problem file are `solve` options, such as `--out` and `--seed`. Do not give `--resume`: `tick`
adds it when a job was cut off. `queue add` prints the job id.

To see each job and its state (`queued`, `running`, `done` or `failed`), run:

```
npx synthe queue status ~/synthe-queue
```

Each job also has a status file `<id>.status.json` in the queue folder. It gives the state, the time, the number
of tries, the path of `result.json` when the job is done, and the reason when the job failed.

## 3. Call `tick` from a trigger

`tick` is safe to call at any time, as often as you like:

```
npx synthe tick ~/synthe-queue
```

- If another live `tick` runs, the new call says so and exits at once.
- If the last `tick` stopped (its process ended, or the machine was replaced), the new call takes over its lock.
- If a job was cut off, `tick` continues it with `solve --resume`. Otherwise it starts the oldest queued job.
- If a job fails in setup 3 times, it is `failed` with the reason, and `tick` goes to the next job.
- If a job's `solve` still runs (a tick died, but its `solve` did not), `tick` leaves the job alone. This does not
  count as a setup try.
- Only one `solve` runs on a problem at a time. If you start `solve` by hand while another `solve` of the same
  problem runs, it says "already running", changes nothing and exits 3. Wait for the other one to end.
- When no job is left, `tick` says so and exits 0.

## 4. Keep the key in one private file

If a proposer or a judged measure needs a model key, keep the key in one file that only you can read (mode 600). The trigger
reads that file into the environment of `tick` alone.

1. Write the key to the file without a command line that shows it. Run this line in bash: `read -rs -p` does not work
   in `sh` or `dash`. If your shell is not bash, run `bash` first. Type the key at the prompt:

   ```
   mkdir -p ~/.config/synthe && (umask 077 && read -rs -p "Key: " key && printf 'SYNTHE_API_KEY=%s\n' "$key" > ~/.config/synthe/tick.env)
   ```

2. Make sure that only you can read it:

   ```
   chmod 600 ~/.config/synthe/tick.env
   ```

3. Write the trigger script `~/.local/bin/synthe-tick`. It sets `PATH`, because a scheduler does not read your
   shell files. It reads the key into the environment of `tick` only:

   ```
   #!/bin/sh
   PATH="$HOME/.local/bin:/usr/bin:/bin"; export PATH
   set -a; . "$HOME/.config/synthe/tick.env"; set +a
   exec npx synthe tick "$HOME/synthe-queue" >> "$HOME/synthe-tick.log" 2>&1
   ```

4. Make the script executable: `chmod 700 ~/.local/bin/synthe-tick`.

If a problem file uses a coding agent as its proposer, the `PATH` in the trigger script must find `claude` or
`codex`. The example above finds them in `~/.local/bin` (section 1, step 4). If the agent is in another folder, add
that folder to `PATH`, or give the full path of the program in `proposer.bin`.

Do not put the key in `~/.profile` or `~/.bashrc`: then every program you start gets it. Do not put it in a queue
file, a job option or a command line: other processes can read a command line, and the shell history keeps it.
If no job needs a key, leave out the `tick.env` line.

## 5. Call the trigger script from a trigger

Use any trigger that starts after a replacement. Use more than one trigger if you can. Each example calls the
trigger script, so each one sets `PATH`.

- **A start hook**: add `$HOME/.local/bin/synthe-tick &` to the start script of the machine.
- **A schedule**: a cron job has no `PATH` from your home folder, so set it on the first line. For example, run it
  every 10 minutes:

  ```
  PATH=/home/you/.local/bin:/usr/bin:/bin
  */10 * * * * $HOME/.local/bin/synthe-tick
  ```

- **A shell login**: add this line to `~/.profile`, with `&` so the login does not wait:

  ```
  (PATH="$HOME/.local/bin:$PATH" "$HOME/.local/bin/synthe-tick" &)
  ```

- **An agent**: tell the coding agent of the machine to run `$HOME/.local/bin/synthe-tick` at the start of its
  session.

## 6. Limits

- **One job at a time.** `tick` runs one job, then the next. A second `tick` does not start a second job.
- **A slow, shared CPU gives noisy scores.** On a machine with 1.5 shared CPUs, the measure of a problem varies
  more from run to run. Set more measure `runs` in the problem file, so that Synthe keeps only real gains. More
  runs make each round slower.
- **A job that is cut off repeats the round it was in.** Finished rounds are kept. The round that was cut off runs
  again from its start.
