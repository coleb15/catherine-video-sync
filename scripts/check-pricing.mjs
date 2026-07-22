// Watches Framer's Server API FAQ page for pricing-related language changes.
// The Server API is beta and currently free, with Framer stating they'll
// "likely charge for this API on a per-use basis" once it's out of beta —
// no timeline given. This can't be solved in code, only monitored for.
//
// On a detected change, opens a GitHub Issue in this repo (GitHub emails the
// repo owner by default when an issue is opened — no separate notification
// service needed).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const FAQ_URL = "https://www.framer.com/developers/server-api-faq";
const SNAPSHOT_PATH = new URL("../.pricing-snapshot.txt", import.meta.url);

// Write directly to the GitHub Actions output file, rather than relying on
// the workflow step redirecting all of stdout there — that would also
// capture the diagnostic console.log lines below, which aren't valid
// key=value output lines and made the whole step fail (confirmed by
// actually running this in GitHub Actions, not assumed).
function setActionOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return; // running locally, not in Actions
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const PRICING_KEYWORDS = [
  /\$\s?\d/, // a dollar sign followed by a digit, e.g. "$0.01"
  /per[\s-]?use/i,
  /per[\s-]?request/i,
  /per[\s-]?call/i,
  /monthly (fee|charge|allowance is now)/i,
  /no longer free/i,
  /pricing (starts|begins|is now)/i,
];

async function main() {
  const res = await fetch(FAQ_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${FAQ_URL}: status ${res.status}`);
  }
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const previous = existsSync(SNAPSHOT_PATH) ? readFileSync(SNAPSHOT_PATH, "utf8") : "";
  writeFileSync(SNAPSHOT_PATH, text);

  const matchedKeywords = PRICING_KEYWORDS.filter((re) => re.test(text));
  const stillSaysTBD = /TBD/i.test(text) && /free of charge/i.test(text);
  const contentChanged = previous !== "" && previous !== text;

  // Current wording already contains phrases like "per-use basis" while
  // describing FUTURE intent ("we will likely charge... on a per-use
  // basis"), so a keyword match alone is not meaningful — it's expected to
  // always be true. The precise signal is the "still free during beta, TBD"
  // language actually disappearing. Confirmed via testing that combining
  // this with a generic "content changed at all" check would false-positive
  // on any unrelated page edit (nav links, copy tweaks, etc.), so that's
  // deliberately not used as a trigger.
  const likelyPricingAnnounced = matchedKeywords.length > 0 && !stillSaysTBD;

  console.log(`Content changed since last check: ${contentChanged}`);
  console.log(`Still says "free during beta, TBD": ${stillSaysTBD}`);
  console.log(`Pricing-looking keywords matched: ${matchedKeywords.map((r) => r.source).join(", ") || "none"}`);

  if (likelyPricingAnnounced) {
    console.log("::notice::Possible Framer Server API pricing change detected — flagging for review.");
    setActionOutput("PRICING_ALERT", "true");
  } else {
    setActionOutput("PRICING_ALERT", "false");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
