# Deploy Verification Checklist

Every non-trivial code change must complete this checklist before claiming "deployed" or "done". The goal is to catch the class of bug where code is written but never actually wired into production paths.

## When to use this checklist

Use for:
- Adding new functions or modules
- Adding new admin commands or slash commands
- Adding new env vars or secrets
- Adding new database columns, tables, or migrations
- Adding new API routes
- Adding new validators, guards, or middleware
- Refactoring existing code paths
- Rotating shared secrets between Fly and external services (Surface Pro proxy, etc.)
- Bug fixes that touch more than one file

Skip for:
- Documentation-only changes
- Comment cleanup
- Markdown file edits
- One-line typo fixes

## The Checklist

### 1. Code exists in the repo

```bash
git log --oneline -5
git diff HEAD~1 <files-changed> | head -80
```

Paste output. The diff must show actual line additions, not just file metadata.

### 2. New functions are wired into production paths

For each new function added, run a grep showing it is called from somewhere:

```bash
grep -rn "newFunctionName(" services/ handlers/ commands/ routes/
```

Each new function must show at least 2 results:
- The definition (in the file where it lives)
- At least one call site in another file

If a function is defined but never called, it is not wired in.

### 2a. Variables referenced from new code are in the same function scope

If your new code references an existing variable (not a parameter, not a module-level const), verify that variable is declared in the same function as the new code. `npm run check` performs syntactic parsing only — it does NOT catch cross-function scope errors. The bug surfaces only at runtime, on the first input that exercises the new path.

Same-file is not the same as same-function. A grep that shows variable definition at line X and your new reference at line Y proves only co-existence in the file. The lines may be in different functions, in which case the variable is out of scope and the reference will throw `ReferenceError` at runtime.

Verification recipe:

```bash
grep -n "^async function\|^function " handlers/messageHandler.js | head -40
```

Cross-reference your variable's definition line and your new code's line against this function-boundary list. If they fall in different function blocks, do one of:

- Pass the variable as a parameter to the inner function
- Recompute the variable inline at the new call site
- Promote the variable to a module-level const

This rule was added 2026-05-14 after v432 (commit 01fe811) shipped with `isHumanSubmitChannel` referenced from `processAggregatedMessage` while defined in `handleMessage`. Bot crashed on first ignore-verdict slip with `ReferenceError: isHumanSubmitChannel is not defined`. Reverted as v433, reshipped as v434 (commit 8d1668a) with inline computation.

### 3. Migrations actually applied

If the change includes a migration, verify the schema after deploy:

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "console.log(require(\"better-sqlite3\")(\"/data/bettracker.db\").prepare(\"PRAGMA table_info(<table>)\").all().map(c=>c.name).join(\",\"));"'
```

The output must include the new columns. If it does not, the migration did not run.

### 4. Push succeeded

```bash
git push origin <branch>
```

The output must show "main -> main" or similar success line. If it shows "403", "permission denied", or "rejected", the push failed and nothing landed. Stop and report the error rather than retrying silently.

### 5. Fly deploy ran and succeeded

Deploys are **manual**. There is no GitHub Action or git-push hook on this repo. After committing and pushing, run:

```bash
flydeploy
```

(alias for `fly deploy --local-only --yes --no-cache -a bettracker-discord-bot`)

The `--no-cache` flag is mandatory. Without it, Docker reuses a stale `COPY . .` layer and ships the previous build despite a successful "deploy" message. This pattern has shipped phantom deploys at v281 and v289.

The output must end with:
```
--> v<NN> deployed successfully
```

Then confirm the release landed:

```bash
fly releases -a bettracker-discord-bot | head -3
```

The latest version must be newer than before the deploy and have a timestamp within the last few minutes. If `fly deploy` errored, exited non-zero, or was killed mid-build, the release will not advance — Step 6 will then fail and you stop and report rather than retry.

### 6. Bot picked up the new code

Run a runtime check that proves the new code is loaded:

```bash
fly logs -a bettracker-discord-bot --no-tail | grep -iE "<distinctive log line from new code>" | tail -5
```

Or for new admin commands, run the command in Discord and confirm it responds.

Or for new endpoints, curl the endpoint and confirm it returns expected output.

### 7. Old behavior did not regress

Run any pre-existing test commands the change might have impacted. Examples:
- `/health quick`
- `/admin list-channels`
- `/grade test query:"Lakers -5" sport:NBA`

Confirm they still work.

### 8. Memory and uptime check

`/health quick`

Confirm bot is still running, memory has not spiked, no new errors in the alerts section.

### 9. External auth round-trip (if applicable)

Required when the change touches: Fly secrets, Surface Pro env vars, the ollama-proxy, Tailscale Funnel, or anything where Fly and an external service share a rotated credential.

After deploying, prove that Fly can authenticate to the external service end-to-end with a real request through the live network path. The output must show a successful service response (e.g. a JSON model list for Ollama), not `unauthorized`, `403`, or a timeout.

Example for the ollama-proxy:

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "
const url = process.env.OLLAMA_URL;
const secret = process.env.OLLAMA_PROXY_SECRET;
fetch(url + \"/api/tags\", { headers: { \"x-ollama-secret\": secret }, signal: AbortSignal.timeout(10000) })
  .then(r => r.text()).then(t => console.log(t.slice(0, 200)))
  .catch(e => console.log(\"FAIL:\", e.message));
"'
```

Adapt the command for whatever credential rotated.

**If this step fails:** the credential is mismatched between Fly and the external service. Symptoms have been silent in the past — fallback paths return empty without raising errors, and the bug only surfaces when downstream features need that credential. The 2026-04-30 → 2026-05-14 silent Gemma outage is the canonical example: every `vision_failures` row had an empty `gemma_response` for 14 days, but no log line said "auth failed" because the adapter swallowed 401s as generic failures.

**For PM2-backed services (Surface Pro ollama-proxy)**, remember secrets live in THREE places: `ecosystem.config.js`, `~/.pm2/dump.pm2`, and the PM2 runtime env. All three must match. `pm2 restart` reads from dump, NOT the file. Rotation order: edit file → `pm2 delete && pm2 start ecosystem.config.js` → `pm2 save` to overwrite dump. Verify with `curl localhost:11435/api/tags` BEFORE updating Fly.

## What "deployed ✅" means

A code change is "deployed ✅" when ALL of the following are true:

- [ ] Steps 1, 2, 4, 5 outputs pasted
- [ ] Steps 3 and 6 outputs pasted (if applicable)
- [ ] Step 9 output pasted (if shared secret rotated)
- [ ] Step 7 confirms no regression
- [ ] Step 8 confirms bot is healthy

If any step fails or is skipped, the change is NOT deployed. Report the failure instead of retrying or reframing.

## What "deployed ✅" does NOT mean

- "I wrote the code" — unverified
- "I committed the code" — unverified
- "I ran git push" — push could have 403'd
- "Fly should auto-deploy" — unverified
- "The function is in the right file" — does not mean it is called from production paths

## Reporting deploys

Use this format when reporting a successful deploy:

```
## Deploy: <one-line summary>

Commit: <hash> — <commit message>
Files changed: <list>
Functions added: <list>

### Verification

Step 1 (code in repo):
[paste git log + diff snippet]

Step 2 (wired in):
[paste grep results showing call sites]

Step 3 (migration, if applicable):
[paste schema check]

Step 4 (push):
[paste push output]

Step 5 (Fly release):
[paste fly releases output]

Step 6 (bot picked up):
[paste log grep or runtime check]

Step 7 (no regression):
[paste test outputs]

Step 8 (health):
[paste /health quick output]

Step 9 (external auth round-trip, if applicable):
[paste round-trip output]
```

## --no-cache discipline for Docker rebuilds

Pass `--no-cache` to `fly deploy --local-only` when the change includes:

- New files added to the repo (the Dockerfile `COPY . .` layer may be cached stale)
- Migration files (`migrations/NNN_*.sql`)
- New env var references in code
- Anything where a previous deploy of the same code path mysteriously did not pick up the new behavior

Standard command:

```bash
fly deploy --local-only --no-cache --yes -a bettracker-discord-bot
```

This has been the silent killer twice (v281, v289) — code is in the repo, push succeeded, Fly release recorded, but the running container has the previous version because the COPY layer was reused from cache. Step 2 (grep for the new function in production paths) and Step 6 (server-side grep proves the bot picked up new code) of this checklist catch it; `--no-cache` prevents it. The deploy is ~30s slower; the rework from a bad deploy is hours.

## Examples of past failures this prevents

- **Yesterday's "parser fix deployed"** — Code tab said deployed, but the new functions did not exist in any file. Step 2 (grep for function definition) would have caught it.
- **Earlier yesterday's "reclassifier wired in"** — Functions existed but only ran from manual `/grade test`, not from cron `runAutoGrade`. Step 2 (grep for call sites in production paths) would have caught it.
- **Earlier yesterday's "migration 013 applied"** — Migration file existed but was never run, so columns did not exist. Step 3 (schema check) would have caught it.
- **The day before's "Bug 3 deployed"** — Three message-handler gates needed to be updated; only one was. Step 2 (grep across all gate files) would have caught it.
