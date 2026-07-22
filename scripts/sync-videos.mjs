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
import { connect, isRetryableError } from "framer-api";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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

const FFMPEG_ARGS = [
  "-vf", "scale=960:-2",
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "20",
  "-maxrate", "3000k",
  "-bufsize", "6000k",
  "-c:a", "aac",
  "-b:a", "128k",
  "-movflags", "+faststart",
];

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

async function withRetries(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      console.warn(`[${label}] attempt ${attempt}/${attempts} failed${retryable ? " (retryable)" : ""}: ${error.message}`);
      if (!retryable || attempt === attempts) break;
      await sleep(2000 * attempt);
    }
  }
  throw lastError;
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

      execFileSync("ffmpeg", ["-y", "-i", rawPath, ...FFMPEG_ARGS, optimizedPath], { stdio: "inherit" });

      const optimizedBytes = readFileSync(optimizedPath);

      const uploaded = await withRetries(`upload:${slug}`, () =>
        framer.uploadFile({
          name: `optimized-${slug}.mp4`,
          file: { bytes: optimizedBytes, mimeType: "video/mp4" },
        })
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
      state[item.id] = { slug, lastSyncedSourceAssetId: asset.id };
      saveState(state);

      console.log(`Synced "${slug}" -> ${uploaded.url}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
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
  const toProcess = await withFreshCollection(async (_framer, collection, fields) => {
    const items = await collection.getItems();
    console.log(`Checking ${items.length} item(s) in "${COLLECTION_NAME}"...`);

    const pending = [];
    for (const item of items) {
      const asset = item.fieldData[fields.upload.id]?.value;
      if (!asset?.url) continue;
      const lastSynced = state[item.id]?.lastSyncedSourceAssetId;
      if (lastSynced === asset.id) continue;
      pending.push(item.slug);
    }
    return pending;
  });

  console.log(`${toProcess.length} item(s) need processing: ${toProcess.join(", ") || "(none)"}`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const slug = toProcess[i];
    console.log(`Processing "${slug}"...`);
    try {
      await processItem(slug, state);
      processed++;
    } catch (error) {
      console.error(`Failed to process "${slug}": ${error.message}`);
      failed++;
    }
    // Deliberate pause between items' connect/disconnect cycles — testing
    // showed back-to-back cycles with no gap caused writes to intermittently
    // fail to persist.
    if (i < toProcess.length - 1) {
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
