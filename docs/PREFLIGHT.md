# PREFLIGHT — Claude session-start checklist

**Audience:** Claude (the assistant). Smokke doesn't need to read this — it's a self-checklist Claude runs at the top of every session before doing anything that touches state.

## Rule 0: What Claude can and cannot see

**Source-file access in Claude sessions.** Claude in claude.ai chat does NOT have filesystem access to the Mac or the repo. It can only see:

1. Files Smokke uploads as project files or attachments (shown in `<documents>` blocks or under `/mnt/project/`).
2. Code/docs Smokke pastes inline in messages.
3. Tool outputs from terminal commands Smokke runs and pastes back.

There is no "read the file at path X". If Claude needs a file content, ask Smokke to paste it (`cat`/`grep`/`head` output). Never claim to have read a file not provided this session. **Before writing any perl/sed substitution against a doc or code file Claude has not seen this session, ask Smokke to `cat` or `grep` the relevant section first.** Blind regex against unseen file content has produced 3 broken-file commits in a single session (a710a89 duplicate Rule 0 headers, ad6954c orphan Rule 1, ad6954c fix incomplete). Always view first, then write the substitution. Code tab prompts should specify behavior by rule ("locate the STAGES enum and add a new value"), not by line number, unless the line was verified this session.

A Code tab agent CAN read the local filesystem — that is a separate runtime. Code tab prompts should describe intent, not paste content Claude has not seen.

## Rule 0b: CODEMAP wins over memory

`userMemories` is a 30-slot LRU working set, not a knowledge graveyard. When memory and `docs/CODEMAP.md` disagree, CODEMAP wins. Memory entries that reference files, line numbers, or schemas should be cross-checked against CODEMAP's per-file call-site tables (the "Ingestion pipeline" / per-service sections that carry line numbers) and the "Schemas" section before being trusted.

## Rule 1: Before any DB work

Always run `PRAGMA table_info(<table>)` before assuming columns exist. CODEMAP's "Schemas" section lists the verified schemas, but it can drift between verification passes. Verify, then act.

The `bets` table primary key is `id`, NOT `bet_id`. This trips at least one query per session if memory leads.

`pipeline_events.created_at` is INTEGER epoch seconds. Use `Math.floor(Date.now()/1000) - N*86400` for cutoffs, never `datetime('now', ...)` — type mismatch returns 0 rows silently.

Scripts that `require('better-sqlite3')` cannot run from `/tmp` — that path has no node_modules. Always `cd /app` first, or copy the script under `/app/scripts/`:

```bash
fly ssh console -a bettracker-discord-bot -C "sh -c 'cd /app && node /tmp/SCRIPT.js'"
```

For dry-run / commit toggle on mutation scripts use a `COMMIT=1` env-var pattern (see Rule 5).

## Rule 2: Before assuming an env var is live

```bash
fly ssh console -a bettracker-discord-bot -C 'node -e "console.log(process.env.X || \"MISSING\")"'
```

`fly secrets set` without subsequent `fly deploy` leaves the secret **staged but not in the running container**. This caused the 5-day silent no-op of ADMIN_LOG_CHANNEL_ID before v447. The `node -e` command above proves the secret is live in the container; DEPLOY_CHECKLIST.md **Step 9** (External auth round-trip — Fly secrets / Surface Pro env vars) codifies the post-deploy secret/env-var verification. (Step 5a is the separate "merged ≠ deployed" check — it greps for a new *code* marker, not a secret.)

## Rule 3: Before assuming a commit is shipped

```bash
git log --oneline -20
fly releases -a bettracker-discord-bot | head -5
```

A commit on `main` is not a deploy. Fly does **not** auto-deploy (memory #18). Every deploy is manual: `fly deploy --local-only --yes --no-cache -a bettracker-discord-bot`.

`--no-cache` is mandatory — phantom deploys v281+v289 shipped stale COPY without it.

## Rule 4: Running a script on Fly

`/tmp/` does not have node_modules. Scripts that `require('better-sqlite3')` must run with `cwd=/app`:

```bash
fly ssh console -a bettracker-discord-bot -C "sh -c 'cd /app && node /tmp/SCRIPT.js'"
```

`fly ssh -C` tokenizes argv without a shell, so pipes, redirects, env-prefixes, and complex shell features must be wrapped in `sh -c '...'`.

## Rule 5: Destructive scripts default to dry-run

Any script that mutates `/data/bettracker.db` follows the pattern:

```js
const COMMIT = process.env.COMMIT === '1';
// ... print planned changes ...
if (COMMIT) { /* mutate */ } else { /* print "DRY RUN" */ }
```

Run dry first, paste output, get explicit "commit it" from Smokke, then re-run with `COMMIT=1`. Every mutation gets a `[retro-fix YYYY-MM-DD]` breadcrumb in `grade_reason` so the audit trail survives.

## Rule 6: Channel routing is env-driven

There are **no** hardcoded channel-ID constants in source. All channel routing reads from env vars (`HUMAN_SUBMISSION_CHANNEL_IDS`, `CAPPER_CHANNEL_MAP`, `WAR_ROOM_CHANNEL_ID`, etc — see CODEMAP's "Channels — ingestion routing" and "Env vars that gate behavior" sections). Don't grep source for channel IDs; query env or `bets.source_channel_id` instead.

## Rule 7: File paths to know

- `handlers/messageHandler.js` (NOT `services/messageHandler.js` — common memory error)
- `bot.js` — channel routing, hold action dispatch
- `services/holdReview.js` — Release/Dismiss button handlers
- `services/pipeline-events.js` — stage enum
- `services/ai.js` — parseBetText, LLM waterfall
- `services/grading.js` — grader waterfall, isTrustedLossLeg
- `services/sportsdata/` — structured grading adapters (mlb/nhl/nba)

See CODEMAP's per-file "Ingestion pipeline" / per-service sections for line numbers of key call sites.

## Rule 8: Before claiming "deployed ✅"

Run `docs/DEPLOY_CHECKLIST.md` all 9 steps, including Step 5a (grep the new marker inside the running container — merged ≠ deployed). No exceptions for "small" changes that touch production paths.

## Rule 9: Reporting back to Smokke

- Concise. No preamble.
- Numbered action sequences.
- Paste-verified evidence ("here's the command, paste output").
- Push back when an idea is misguided. Don't agree to wrong things.
- Code tab prompts include both: (1) the terminal command to move the prompt file into `~/Documents/discord/prompts/`, and (2) the Code tab command to run it.
- **When delivering files via the artifact panel**: explicitly tell Smokke "Click the download icon on each file in the Claude panel above. Files save to `~/Downloads/`." Then give terminal commands assuming files are in `~/Downloads/`. Never assume Smokke will know to download — say it.
- **At session end or when Smokke signals wrap-up** (phrases like "let's pick this up later", "starting in a new chat", "wrap up", "done for the day"): unprompted, generate an opening message for the next chat. Include current branch + commit hashes, what shipped this session, what is open, and the first action to propose. Format as a copy-pasteable block.
- **On request** ("write the opening message", "session handoff", or similar): generate the same handoff block on demand.
- Never store secrets in chat. Never ask Smokke to paste auth tokens, cookies, or API keys.

## Rule 10: Memory hygiene

`userMemories` is capped at 30 slots. When near the cap:

1. Migrate stale operational facts into CODEMAP (schemas, channels, env vars, queries, file paths).
2. Migrate stale incident/debug notes into `docs/RETROSPECTIVES/`.
3. Migrate stale backlog items into `docs/BACKLOG.md`.
4. Only then delete from memory.

Do not delete operational knowledge to make room for new memory. Move it first.
