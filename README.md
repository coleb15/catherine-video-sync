# Catherine Orchard — Commission Video Sync

## 🚨 If something's broken right now

**Step 1 — stop it immediately (always safe, takes 5 seconds):**

```
gh workflow disable sync-videos.yml --repo coleb15/catherine-video-sync
```

This cannot break the live site further. The automation is a background job — it doesn't
run at the moment someone visits the site, it only runs on its own schedule. Disabling it
just means nothing more happens automatically until you re-enable it. Whatever was last
correctly synced keeps working exactly as before.

**Step 2 — if one specific video looks wrong on the live site**, revert just that item to
whatever it was before the last sync touched it:

```
npm run rollback -- <item-slug>
```

(the slug is the last part of its Commissions URL, e.g. `nylon` for `/commissions/nylon`)

This reads `.sync-state.json` and writes the previous known-good value straight back —
no guessing. Commit and push the updated `.sync-state.json` afterward so the reversion
sticks. If the script itself won't run for some reason, the fallback is: open the item in
the Framer CMS editor and paste a working URL directly into "Video URL (if applicable)" —
that field is a plain string, editable by hand like any other.

**Step 3 — once it's stable, do the real fix without time pressure.** Re-enable when ready:

```
gh workflow enable sync-videos.yml --repo coleb15/catherine-video-sync
```

Both the disable and rollback commands were tested for real against this repo and
project, not just written and assumed to work.

---

Automates what used to be a manual step: when Catherine uploads a new video into the
"Video File (if applicable)" field on a Commissions CMS item in Framer, this re-encodes
it to a smaller web-friendly size and writes the result into "Video URL (if applicable)"
— the field that actually drives what renders on the live site. She never has to think
about optimization; it just happens.

## How it works

- `scripts/sync-videos.mjs` runs on a daily schedule (`.github/workflows/sync-videos.yml`).
  It checks every item in the "Commissions" collection for a video in the upload field
  that hasn't been synced yet, downloads it, runs it through ffmpeg, and uploads the
  result via Framer's Server API into the render field.
- `scripts/check-pricing.mjs` runs weekly (`.github/workflows/pricing-watch.yml`). Framer's
  Server API is in beta and currently free; Framer has said they'll likely charge per-use
  once it leaves beta, with no announced timeline. This watches their FAQ page for
  wording changes and opens a GitHub Issue here if it looks like that's happened — GitHub
  emails the repo owner automatically when an issue is created, so no separate
  notification setup is needed.

## Why "already synced" is tracked in `.sync-state.json`, not in Framer

This was not the first design, and changing it was not a style preference — it fixed a
real bug found through direct testing.

The first version tried tracking "have I already processed this item's current upload"
using Framer itself (first via the SDK's per-item plugin-data API, then via a plain CMS
field). Both were unreliable in the same specific way: writing a value and immediately
reading it back **on the same connection** worked every time. But a **different**
connection — like the one this script opens fresh on its next scheduled run — could
still see stale data for several minutes afterward, unpredictably. This was confirmed
repeatedly, including a case where a schema-level field-creation call resolved
successfully but the field didn't exist on a fresh read moments later.

This is a real limitation of Framer's Server API in its current beta state, not a bug in
this code. It's not dangerous — reprocessing an already-correct video just produces an
equivalent re-encode, wasteful but harmless — but it made the "skip if unchanged" check
unreliable enough to not trust.

The fix: "already synced" bookkeeping lives in `.sync-state.json`, committed to this repo
after every run, not read back from Framer. Reading Framer's *current* upload field (i.e.
what Catherine actually uploaded) has never shown this staleness — only reads of this
script's own recent writes did. So the split is: Framer stays authoritative for what
Catherine uploaded and for what visitors see; this repo stays authoritative for "have I
already handled this."

There is also a "Last Synced Source Asset" field in the Commissions collection in Framer
itself — written on every successful sync as a human-visible record, but it is
**best-effort only** and not read from or trusted by the script. Don't repurpose it as the
source of truth without re-testing cross-session read consistency rigorously first.

## Other things confirmed necessary via testing (not assumptions)

- **Each item gets its own fresh `connect()`/`disconnect()` cycle.** A single long-lived
  connection was observed to silently die partway through a multi-item run (each item's
  download + ffmpeg + transcode + upload can take a minute or more).
- **A 5-second pause between items.** Back-to-back connect/disconnect cycles with no gap
  caused writes to intermittently fail to persist.
- **Every write is verified by reading it back before moving on**, with retries if it
  didn't stick. A write call resolving without throwing is not proof it committed
  server-side on this API.

## Why it's built this way (for future reference / debugging)

- **Dependency pinned exactly** (`framer-api` at `0.1.24` in `package.json`, installed via
  `npm ci` from the committed lockfile) so a future package release can never silently
  change behavior. If you ever want to upgrade it, do so deliberately and re-test —
  especially the write-reliability behavior described above.
- **Fields looked up by name, not hardcoded ID**, and the script throws (failing the
  workflow run, which triggers GitHub's built-in failure email) if the "Commissions"
  collection or either required field can't be found — instead of silently doing nothing
  forever if someone renames something in the CMS later.
- **Public repo**, specifically so GitHub Actions minutes are unlimited and free
  regardless of usage.
- **No external hosting, database, or paid service of any kind.** The only external
  dependency is the Framer Server API itself (see the beta/pricing caveat above — this is
  the one thing that isn't fully within this repo's control).

## Secrets required (Settings → Secrets and variables → Actions)

- `FRAMER_API_KEY` — a project-scoped Server API key, generated in the Framer project's
  Site Settings → General → API Keys.
- `FRAMER_PROJECT_URL` — the Framer project URL.

## Debugging (once things are stable — see the emergency section at the top for right now)

Check the Actions tab for the failed run's logs first — the script is written to fail
loudly with a specific reason (missing field, missing collection, download/upload
error) rather than fail silently. Manual re-run: Actions → Sync Commission Videos →
Run workflow.

If a run partially fails, already-processed items still get their state committed (the
commit step runs regardless of the sync job's outcome), so a re-run won't redo work
that already succeeded.
