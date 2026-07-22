// Emergency tool: reverts one Commission's render field back to whatever it
// was immediately before the last sync, using .sync-state.json's record —
// nothing to figure out, no guessing at a "right" URL.
//
// Usage: node scripts/rollback.mjs <item-slug>
//
// This does NOT stop the automation from running again — pair it with
// `gh workflow disable sync-videos.yml` if you need it to stay stopped. See
// the README's "If something's broken" section for the full runbook.
import { connect, isRetryableError } from "framer-api";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FRAMER_API_KEY = process.env.FRAMER_API_KEY;
const FRAMER_PROJECT_URL = process.env.FRAMER_PROJECT_URL;

const COLLECTION_NAME = "Commissions";
const RENDER_FIELD_NAME = "Video URL (if applicable)";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "..", ".sync-state.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(label, fn, attempts = 5) {
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

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: node scripts/rollback.mjs <item-slug>");
    process.exit(1);
  }
  if (!FRAMER_API_KEY || !FRAMER_PROJECT_URL) {
    throw new Error("Missing FRAMER_API_KEY or FRAMER_PROJECT_URL environment variable.");
  }
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No ${STATE_PATH} found — nothing to roll back to.`);
  }

  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const entryId = Object.keys(state).find((id) => state[id].slug === slug);
  if (!entryId) {
    throw new Error(`No record for "${slug}" in .sync-state.json. Known slugs: ${Object.values(state).map((e) => e.slug).join(", ")}`);
  }

  const entry = state[entryId];
  if (!entry.previousRenderUrl) {
    throw new Error(
      `No previous value recorded for "${slug}" (current: ${entry.renderUrl}). ` +
      `This item has only ever been synced once, so there's nothing to roll back to via this script — ` +
      `edit the "Video URL (if applicable)" field directly in the Framer CMS editor instead.`
    );
  }

  console.log(`Rolling back "${slug}": ${entry.renderUrl} -> ${entry.previousRenderUrl}`);

  const framer = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);
  try {
    const collections = await framer.getCollections();
    const collection = collections.find((c) => c.name === COLLECTION_NAME);
    const fields = await collection.getFields();
    const renderField = fields.find((f) => f.name === RENDER_FIELD_NAME);

    const items = await collection.getItems();
    const item = items.find((i) => i.slug === slug);
    if (!item) throw new Error(`Item "${slug}" not found in the collection anymore.`);

    await withRetries("rollback-write-and-verify", async () => {
      await item.setAttributes({
        fieldData: { [renderField.id]: { type: "string", value: entry.previousRenderUrl } },
      });
      await sleep(2000);
      const freshItems = await collection.getItems();
      const freshItem = freshItems.find((i) => i.slug === slug);
      const current = freshItem?.fieldData[renderField.id]?.value;
      if (current !== entry.previousRenderUrl) {
        throw new Error(`Rollback write did not persist (got "${current}")`);
      }
    });

    // Swap current/previous so this is re-doable in either direction.
    state[entryId] = {
      ...entry,
      renderUrl: entry.previousRenderUrl,
      previousRenderUrl: entry.renderUrl,
    };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

    console.log(`Done. "${slug}" now points to ${entry.previousRenderUrl}.`);
    console.log(`Remember to commit and push .sync-state.json so this sticks for the next scheduled run.`);
  } finally {
    await framer.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
