// Watches the Commissions collection's upload field for new/changed videos,
// downloads and re-encodes them to a web-friendly size, uploads the result via
// the Framer Server API, and writes it into the field that actually drives
// rendering on the site — without ever touching the fragile Card Link / Video
// component internals.
//
// Designed to fail loudly rather than silently: if the CMS schema changes
// (a field gets renamed/removed), this throws and the GitHub Actions run is
// marked failed, which GitHub emails to the repo owner automatically. That's
// intentional — better a loud failure than quietly doing nothing forever.
//
// IMPORTANT — things confirmed necessary via real testing against the live
// project, not assumptions:
//
// 1. Each item gets its own fresh connect()/disconnect() cycle for its
//    actual write, rather than reusing one connection for the whole run. A
//    single long-lived connection was observed to silently die partway
//    through a multi-item, multi-minute run.
//
// 2. Writing a field and immediately reading it back on the SAME connection
//    reliably confirms it persisted. But a DIFFERENT, later connection can
//    still see stale data for several minutes afterward — confirmed
//    directly and repeatedly during development. This is a real
//    cross-session consistency lag in this beta API, not a bug in this
//    script. Because of that, "have I already synced this item's current
//    upload" is tracked in `.sync-state.json` in THIS repo (git-committed
//    after each run), not by reading anything back from Framer. Reading the
//    *current* "Video File" upload field (i.e. what Catherine actually
//    uploaded) has never shown this lag — only reads of this script's own
//    recent writes have. If you ever consider moving this bookkeeping back
//    into Framer (a CMS field or plugin data), re-test cross-session
//    consistency rigorously first — it silently failed in exactly this way
//    multiple times during development, including after read-after-write
//    verification within the writing connection itself.
//
// 3. A successful-looking ffmpeg run is not proof of a correct output — a
//    corrupt/truncated source can produce a tiny or zero-duration file
//    without ffmpeg itself erroring. checkOutputSanity() below verifies the
//    output file size and duration before it's ever uploaded, so a bad
//    input becomes a loud failure (and a GitHub notification) instead of a
//    broken video silently going live.
import { connect, isRetryableError } from "framer-api";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FRAMER_API_KEY = process.env.FRAMER_API_KEY;
const FRAMER_PROJECT_URL = process.env.FRAMER_PROJECT_URL;

const COLLECTION_NAME = "Commissions";
const UPLOAD_FIELD_NAME = "Video File (if applicable)";
const RENDER_FIELD_NAME = "Video URL (if applicable)";
// Still written on every successful sync as a human-visible, best-effort
// record in the CMS itself — but NOT read from or trusted for the
// skip-decision, per the consistency-lag finding above.
const MARKER_FIELD_NAME = "Last Synced Source Asset";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "..", ".sync-state.json");

const AUDIO_BITRATE_KBPS = 128;
// Deliberately low — this is a last-resort floor for pathologically long
// uploads, not a quality target. Confirmed via calculation that a higher
// floor (e.g. 400kbps) would override and defeat the size-safety target for
// anything longer than ~6.5 minutes, including the first real long video
// this ran on (13 minutes, needed ~184kbps to hit budget). Below ~14.7
// minutes this floor never actually engages — the duration-based target
// wins. Only videos longer than that trade further quality for guaranteed
// upload success, which is the right tradeoff vs. failing to upload at all.
const MIN_VIDEO_BITRATE_KBPS = 150;
const MAX_VIDEO_BITRATE_KBPS = 3000;
// Raw-bytes uploads to the Server API have a hard size ceiling — confirmed
// directly via testing: 38MB succeeded, 82MB failed with a WebSocket
// "message too big" close (code 1009). Most commission clips are short
// enough that the fixed 3000k cap below was never close to this, but one
// unusually long video (13 minutes) produced a 160MB "optimized" file at
// that fixed rate — which would have failed to upload. The bitrate is now
// calculated per-item from its duration so the output always stays safely
// under the confirmed ceiling, regardless of how long a future upload is.
const MAX_UPLOAD_SAFETY_MB = 30;

function buildFfmpegArgs(maxrateKbps) {
  const bufsizeKbps = maxrateKbps * 2;
  return [
    "-vf", "scale=960:-2",
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "20",
    "-maxrate", `${maxrateKbps}k`,
    "-bufsize", `${bufsizeKbps}k`,
    "-c:a", "aac",
    "-b:a", `${AUDIO_BITRATE_KBPS}k`,
    "-movflags", "+faststart",
  ];
}

// Picks a video bitrate that keeps the encoded file comfortably under the
// confirmed upload ceiling for however long the source actually is, rather
// than assuming every upload is a short clip.
function computeMaxrateKbps(durationSeconds) {
  const targetTotalKbits = MAX_UPLOAD_SAFETY_MB * 8 * 1024;
  const videoKbps = Math.round(targetTotalKbits / durationSeconds - AUDIO_BITRATE_KBPS);
  return Math.min(MAX_VIDEO_BITRATE_KBPS, Math.max(MIN_VIDEO_BITRATE_KBPS, videoKbps));
}

const MIN_OUTPUT_BYTES = 20_000; // catches empty/near-empty output
const DURATION_TOLERANCE_SECONDS = 3; // vs. the source's own duration
const MAX_OUTPUT_BYTES = MAX_UPLOAD_SAFETY_MB * 1.15 * 1024 * 1024; // small margin over the target for encoder overshoot

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    console.warn(`Could not parse ${STATE_PATH} — treating as empty state.`);
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// alwaysRetryOn: extra patterns to treat as retryable regardless of what the
// SDK's own isRetryableError() says. Added after confirming directly that
// "Connection closed" (WebSocket code 1006, an abnormal closure — distinct
// from 1009 "message too big", which is a real size problem not worth
// retrying) sometimes gets classified as non-retryable on the SECOND
// attempt even though retrying again does eventually succeed. Larger
// uploads (tens of MB, vs. the few MB most commission clips need) seem
// more prone to this — reproduced twice in a row on the same 31MB upload.
async function withRetries(label, fn, attempts = 3, { alwaysRetryOn = [] } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const forceRetry = alwaysRetryOn.some((pattern) => pattern.test(error.message ?? ""));
      const retryable = forceRetry || isRetryableError(error);
      console.warn(`[${label}] attempt ${attempt}/${attempts} failed${retryable ? " (retryable)" : ""}: ${error.message}`);
      if (!retryable || attempt === attempts) break;
      await sleep(3000 * attempt);
    }
  }
  throw lastError;
}

function getDurationSeconds(path) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]).toString().trim();
  const seconds = parseFloat(out);
  if (Number.isNaN(seconds)) throw new Error(`ffprobe returned a non-numeric duration: "${out}"`);
  return seconds;
}

// Verifies the optimized file is a real, complete video roughly matching the
// source's length — not just "ffmpeg exited 0". Throws (a real failure) if
// anything looks wrong, rather than letting a broken file get uploaded.
function checkOutputSanity(rawPath, optimizedPath) {
  const size = statSync(optimizedPath).size;
  if (size < MIN_OUTPUT_BYTES) {
    throw new Error(`Optimized output is suspiciously small (${size} bytes) — likely a broken/corrupt source file.`);
  }
  if (size > MAX_OUTPUT_BYTES) {
    // Catches encoder overshoot on unusual content (e.g. very high motion)
    // before it fails obscurely at the upload step instead.
    throw new Error(
      `Optimized output (${(size / 1024 / 1024).toFixed(1)}MB) still exceeds the safe upload ` +
      `size (~${MAX_UPLOAD_SAFETY_MB}MB) despite the duration-based bitrate calculation — ` +
      `likely unusually complex content. Needs manual review, not an automatic retry.`
    );
  }

  const sourceDuration = getDurationSeconds(rawPath);
  const outputDuration = getDurationSeconds(optimizedPath);
  const diff = Math.abs(sourceDuration - outputDuration);

  if (diff > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `Optimized output duration (${outputDuration.toFixed(1)}s) doesn't match source ` +
      `(${sourceDuration.toFixed(1)}s) — off by ${diff.toFixed(1)}s. Source may be corrupt ` +
      `or the encode may have failed partway through.`
    );
  }

  console.log(`Sanity check passed: ${size} bytes, ${outputDuration.toFixed(1)}s (source: ${sourceDuration.toFixed(1)}s).`);
}

// Runs `work(framer, collection, fields)` against a brand-new connection,
// guaranteed to disconnect cleanly afterward either way.
async function withFreshCollection(work) {
  const framer = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);
  try {
    const collections = await framer.getCollections();
    const collection = collections.find((c) => c.name === COLLECTION_NAME);
    if (!collection) {
      throw new Error(
        `Collection "${COLLECTION_NAME}" not found. The CMS schema may have changed — ` +
        `this script needs to be updated to match the new collection name.`
      );
    }

    const fieldList = await collection.getFields();
    const fields = {
      upload: fieldList.find((f) => f.name === UPLOAD_FIELD_NAME),
      render: fieldList.find((f) => f.name === RENDER_FIELD_NAME),
      marker: fieldList.find((f) => f.name === MARKER_FIELD_NAME),
    };

    for (const [key, name] of [
      ["upload", UPLOAD_FIELD_NAME],
      ["render", RENDER_FIELD_NAME],
    ]) {
      if (!fields[key]) {
        throw new Error(
          `Field "${name}" not found in "${COLLECTION_NAME}". ` +
          `The CMS schema may have changed — this script needs to be updated.`
        );
      }
    }
    // marker field is best-effort only; don't hard-fail the whole run if
    // it's ever missing, just skip writing to it.

    return await work(framer, collection, fields);
  } finally {
    await framer.disconnect();
  }
}

async function processItem(slug, state) {
  return withFreshCollection(async (framer, collection, fields) => {
    const items = await collection.getItems();
    const item = items.find((i) => i.slug === slug);
    if (!item) {
      throw new Error(`Item "${slug}" disappeared between the scan pass and processing.`);
    }

    const asset = item.fieldData[fields.upload.id]?.value;
    if (!asset?.url) {
      throw new Error(`Item "${slug}" no longer has an upload — skipping.`);
    }

    const workDir = mkdtempSync(join(tmpdir(), "video-sync-"));
    const rawPath = join(workDir, "raw.mp4");
    const optimizedPath = join(workDir, "optimized.mp4");

    try {
      await withRetries(`download:${slug}`, async () => {
        const res = await fetch(asset.url);
        if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(rawPath, buffer);
      });

      const sourceDuration = getDurationSeconds(rawPath);
      const maxrateKbps = computeMaxrateKbps(sourceDuration);
      console.log(
        `Source duration: ${sourceDuration.toFixed(1)}s -> encoding at ${maxrateKbps}kbps video ` +
        `(target: under ~${MAX_UPLOAD_SAFETY_MB}MB)`
      );

      execFileSync("ffmpeg", ["-y", "-i", rawPath, ...buildFfmpegArgs(maxrateKbps), optimizedPath], { stdio: "inherit" });

      checkOutputSanity(rawPath, optimizedPath);

      const optimizedBytes = readFileSync(optimizedPath);

      const uploaded = await withRetries(
        `upload:${slug}`,
        () =>
          framer.uploadFile({
            name: `optimized-${slug}.mp4`,
            file: { bytes: optimizedBytes, mimeType: "video/mp4" },
          }),
        6,
        { alwaysRetryOn: [/connection closed/i] }
      );

      const fieldData = {
        [fields.render.id]: { type: "string", value: uploaded.url },
      };
      if (fields.marker) {
        fieldData[fields.marker.id] = { type: "string", value: asset.id };
      }

      // Write, then verify by reading back on this same connection — a
      // write resolving without error is not proof it committed
      // server-side on this API (confirmed directly during testing).
      await withRetries(`write-and-verify:${slug}`, async () => {
        await item.setAttributes({ fieldData });

        await sleep(2000);

        const freshItems = await collection.getItems();
        const freshItem = freshItems.find((i) => i.slug === slug);
        const renderValue = freshItem?.fieldData[fields.render.id]?.value;

        if (renderValue !== uploaded.url) {
          throw new Error(`Render field write did not persist (got "${renderValue}")`);
        }
      }, 5);

      // The authoritative "already synced" record — this repo, not Framer.
      // Keeps the previous render URL too, so a bad sync can be rolled back
      // with `node scripts/rollback.mjs <slug>` (see README).
      const previousRenderUrl = state[item.id]?.renderUrl ?? state[`removed:${slug}`]?.previousRenderUrl;
      delete state[`removed:${slug}`]; // clean up if this item was cleared and is now re-uploaded
      state[item.id] = {
        slug,
        lastSyncedSourceAssetId: asset.id,
        renderUrl: uploaded.url,
        previousRenderUrl,
      };
      saveState(state);

      console.log(`Synced "${slug}" -> ${uploaded.url}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}

// Handles an item that WAS previously synced by this script but no longer
// has anything in the upload field — i.e. someone removed the video. Clears
// the render field too, rather than leaving a stale optimized video live
// forever with no upload behind it.
async function clearItem(slug, state) {
  return withFreshCollection(async (_framer, collection, fields) => {
    const items = await collection.getItems();
    const item = items.find((i) => i.slug === slug);
    if (!item) {
      throw new Error(`Item "${slug}" disappeared between the scan pass and processing.`);
    }

    const entryId = Object.keys(state).find((id) => state[id].slug === slug);
    const previousRenderUrl = entryId ? state[entryId].renderUrl : undefined;

    const fieldData = {
      [fields.render.id]: { type: "string", value: "" },
    };
    if (fields.marker) {
      fieldData[fields.marker.id] = { type: "string", value: "" };
    }

    await withRetries(`clear-and-verify:${slug}`, async () => {
      await item.setAttributes({ fieldData });
      await sleep(2000);
      const freshItems = await collection.getItems();
      const freshItem = freshItems.find((i) => i.slug === slug);
      const renderValue = freshItem?.fieldData[fields.render.id]?.value;
      if (renderValue !== "") {
        throw new Error(`Clearing render field did not persist (got "${renderValue}")`);
      }
    }, 5);

    if (entryId) delete state[entryId];
    // Keep the last known URL around under the slug so a rollback is still
    // possible even after the state entry itself is gone.
    if (previousRenderUrl) {
      state[`removed:${slug}`] = { slug, renderUrl: "", previousRenderUrl };
    }
    saveState(state);

    console.log(`Cleared "${slug}" — upload was removed.`);
  });
}

async function main() {
  if (!FRAMER_API_KEY || !FRAMER_PROJECT_URL) {
    throw new Error("Missing FRAMER_API_KEY or FRAMER_PROJECT_URL environment variable/secret.");
  }

  const state = loadState();

  // Scan pass: one short-lived connection just to see what needs work,
  // comparing Framer's current upload field (always read reliably) against
  // this repo's own record of what was last synced (also always reliable —
  // it's a local file, not a cross-session Framer read).
  const { toProcess, toClear } = await withFreshCollection(async (_framer, collection, fields) => {
    const items = await collection.getItems();
    console.log(`Checking ${items.length} item(s) in "${COLLECTION_NAME}"...`);

    const pending = [];
    const clearing = [];
    for (const item of items) {
      const asset = item.fieldData[fields.upload.id]?.value;
      const previouslySynced = Object.values(state).some(
        (entry) => entry.slug === item.slug && entry.lastSyncedSourceAssetId
      );

      if (!asset?.url) {
        if (previouslySynced) clearing.push(item.slug);
        continue;
      }

      const stateEntry = Object.values(state).find((entry) => entry.slug === item.slug);
      if (stateEntry?.lastSyncedSourceAssetId === asset.id) continue;
      pending.push(item.slug);
    }
    return { toProcess: pending, toClear: clearing };
  });

  console.log(`${toProcess.length} item(s) need processing: ${toProcess.join(", ") || "(none)"}`);
  if (toClear.length > 0) {
    console.log(`${toClear.length} item(s) had their upload removed and need clearing: ${toClear.join(", ")}`);
  }

  let processed = 0;
  let failed = 0;
  const allWork = [...toProcess.map((slug) => ({ slug, kind: "process" })), ...toClear.map((slug) => ({ slug, kind: "clear" }))];

  for (let i = 0; i < allWork.length; i++) {
    const { slug, kind } = allWork[i];
    console.log(`${kind === "process" ? "Processing" : "Clearing"} "${slug}"...`);
    try {
      if (kind === "process") {
        await processItem(slug, state);
      } else {
        await clearItem(slug, state);
      }
      processed++;
    } catch (error) {
      console.error(`Failed to ${kind} "${slug}": ${error.message}`);
      failed++;
    }
    // Deliberate pause between items' connect/disconnect cycles — testing
    // showed back-to-back cycles with no gap caused writes to intermittently
    // fail to persist.
    if (i < allWork.length - 1) {
      await sleep(5000);
    }
  }

  console.log(`Done. Processed: ${processed}, failed: ${failed}.`);

  if (failed > 0) {
    throw new Error(`${failed} item(s) failed to process — see log above.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
