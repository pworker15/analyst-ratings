import "dotenv/config";
import axios from "axios";
import * as fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

const URL = "https://www.benzinga.com/analyst-stock-ratings";

// סינון וברירות מחדל
const MAX_DAYS = Number(process.env.MAX_DAYS ?? 3);
const MIN_PRICE = Number(process.env.MIN_PRICE ?? 5);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOG_FILE = process.env.LOG_FILE || path.resolve("./sent.log");

// עומסים/באטצ'ינג
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? 750);
const MAX_PER_RUN   = Number(process.env.MAX_PER_RUN ?? 200);
const EMBED_MODE    = (process.env.EMBED_MODE ?? "1") === "1";
const EMBEDS_PER_REQ = Number(process.env.EMBEDS_PER_REQ ?? 10);

const BIG_RATE_THRESHOLD = Number(process.env.BIG_RATE_THRESHOLD ?? 20);
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID || "";            // Role ID של @alert

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}

function parseMoney(str = "") {
  const m = String(str).replace(/[^0-9.\-]/g, "");
  return m ? Number(m) : NaN;
}

function daysAgo(isoLike) {
  const d = isoLike?.includes("-")
    ? new Date(isoLike + "T00:00:00Z")
    : new Date(isoLike);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

async function loadSent() {
  try {
    const txt = await fs.readFile(LOG_FILE, "utf8");
    return new Set(txt.split("\n").map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function appendSent(key) {
  await fs.appendFile(LOG_FILE, key + "\n", "utf8");
}

function makeRowKey(r) {
  return [
    r.dateISO,
    r.ticker,
    r.analyst_firm,
    r.analyst_name,
    r.previos_current_rating,
    r.rating_change,
    r.price_target_change,
  ].join("|");
}

function extractRows(html) {
  const $ = load(html);

  const rows = $("tbody.benzinga-core-table-tbody tr.benzinga-core-table-row");
  const out = [];

  rows.each((_, tr) => {
    const row = $(tr);

	// date
    const dateCell = row.find("td.table-cell-date");
    const dateISO = dateCell.attr("title")?.trim() || dateCell.text().trim();

	// ticker
    const ticker = row.find("td.table-cell-ticker").text().trim();

	// company
    const company = row.find("td.table-cell-name").text().trim();

	// current price
    let current_price = row.find("td.table-cell-current_price").text().trim();
    if (!current_price) {
      const txts = row.find("td").toArray().map(td => $(td).text().trim());
      const candidate = txts.find(t => /^\$?\s?\d/.test(t) && !t.includes("→"));
      if (candidate) current_price = candidate;
    }
    const currentPrice = parseMoney(current_price);

	// upside downside
    const upside_downside = row.find("td.table-cell-upside_downside").text().trim();
	
	// analyst firm
    const analyst_firm = row.find("td.table-cell-analyst").text().trim();
	
	// analyst name
    const analyst_name = row.find("td.table-cell-analyst_name .bz-ag-table__analyst-name").text().trim();
	
	// analyst score
    const analyst_score = row.find("td.table-cell-analyst_name .bz-ag-table__analyst-smart-score").text().trim();
	
	// price target change
    const price_target_change = row.find("td.table-cell-pt_prior").text().trim();
	
	// rating change
    const rating_change = row.find("td.table-cell-action_company").text().trim();
	
	// previos/current rating
    const previos_current_rating = row.find("td.table-cell-rating_current").text().trim();

    if (!dateISO || !ticker) return;

    out.push({
      dateISO,
      ticker,
	  company,
      currentPrice,
	  upside_downside,
	  analyst_firm,
	  analyst_name,
	  analyst_score,
      price_target_change,
	  rating_change,
      previos_current_rating,
      rawPriceText: current_price
    });
  });

  return out;
}

// ===== Embed helpers =====
function pickColor(r) {
  const endsWith = (suffix) => raw.endsWith(suffix);
  const POS = 0x2ecc71, NEG = 0xe74c3c, NEU = 0x95a5a6;
  var response = NEU;

  // 1) Respect explicit action if present
  const rc = (r.rating_change || "").toLowerCase();
  if (/downgrade/.test(rc)) response = NEG;
  if (/upgrade/.test(rc)) response = POS;
  if (/(maintains|reiterates)/.test(rc)) response = NEU;

  // 2) Parse current rating from the RIGHT side of the arrow
  const raw =
    (r.previos_current_rating || r.previous_current_rating || r.rating || "")
      .toLowerCase()
      .trim();

  if (["buy", "overweight", "outperform", "overperform", "sector outperform"].some(endsWith)) response = POS;
  if (["sell", "underweight", "underperform"].some(endsWith)) response = NEG;
  if (["hold", "neutral", "market perform", "equal weight", "sector perform"].some(endsWith)) response = NEU;

  return response;
}

/**
dateISO,
ticker,
company,
currentPrice,
upside_downside,
analyst_firm,
analyst_name,
analyst_score,
price_target_change,
rating_change,
previos_current_rating,
**/
function makeOneLine(r) {
  const parts = [
    `${r.dateISO}\n**$${r.ticker}** - ${r.company}:  ${r.rawPriceText || (isFinite(r.currentPrice) ? `${r.currentPrice}` : "—")}\n`,
    `${r.price_target_change}  ${r.rating_change} (${r.upside_downside}) ${r.previos_current_rating}\n`,
    `${r.analyst_name} (${r.analyst_firm}) accuracy: ${r.analyst_score}\n`
  ].filter(Boolean);

  const line = parts.join("");
  return line;
}

function buildEmbed(r) {
  return {
    description: makeOneLine(r),
    color: pickColor(r),
  };
}

// ===== Discord senders =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendDiscord(content) {
  // מצב טקסט (אם EMBED_MODE=0)
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, { content, allowed_mentions: { parse: [] } }, { timeout: 15000 });
      return;
    } catch (e) {
      if (e?.response?.status === 429) {
        const retryMs = Math.max(1000, Math.ceil(((e.response.data?.retry_after ?? 2) * 1000)));
        console.warn(`[rate-limit] 429: waiting ${retryMs}ms (attempt ${attempt})`);
        await sleep(retryMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to send after retries");
}

async function sendDiscordEmbeds(embeds, mention) {
  var content = "";
  if (mention != "") {
    content = `<@&${mention}>`;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, { embeds, content: content }, { timeout: 15000 });
      return;
    } catch (e) {
      if (e?.response?.status === 429) {
        const retryMs = Math.max(1000, Math.ceil(((e.response.data?.retry_after ?? 2) * 1000)));
        console.warn(`[rate-limit] 429: waiting ${retryMs}ms (attempt ${attempt})`);
        await sleep(retryMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to send embeds after retries");
}

(async () => {
  console.log(`[fetch] GET ${URL}`);
  const { data: html } = await axios.get(URL, {
    headers: {
      "User-Agent": process.env.USER_AGENT || "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    timeout: 20000
  });

  const rows = extractRows(html);
  const sent = await loadSent();

  const toSend = [];
  for (const r of rows) {
    const age = daysAgo(r.dateISO);
    if (!(age <= MAX_DAYS)) continue;
    if (!(isFinite(r.currentPrice) && r.currentPrice >= MIN_PRICE)) continue;

    const key = makeRowKey(r);
    if (sent.has(key)) continue;

    toSend.push({ key, r });
  }

  const limited = toSend.slice(0, MAX_PER_RUN);
  let sentCount = 0;

  if (EMBED_MODE) {
    // שליחת embeds בקבוצות של עד 10
    for (let i = 0; i < limited.length; i += EMBEDS_PER_REQ) {
      const slice = limited.slice(i, i + EMBEDS_PER_REQ);
      const embeds = slice.map(({ r }) => buildEmbed(r));

      var mention = "";
      var rate_percentage = slice[0].r.upside_downside;

      if (rate_percentage != undefined && rate_percentage != null && rate_percentage != "" && !Number.isNaN(rate_percentage) && Number.isFinite(rate_percentage)) {
        if (Math.abs(rate_percentage)  > BIG_RATE_THRESHOLD) {
          if (ALERT_ROLE_ID) {
            mention = ALERT_ROLE_ID;
          }
        }
      }

      await sendDiscordEmbeds(embeds, mention);

      for (const { key } of slice) {
        await appendSent(key);
        sent.add(key);
        sentCount++;
      }
      await sleep(RATE_LIMIT_MS);
    }
  } else {
    // מצב טקסט רגיל (אופציונלי)
    for (const { key, r } of limited) {
      const msg = makeOneLine(r);
      await sendDiscord(msg);
      await appendSent(key);
      sent.add(key);
      sentCount++;
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log(`[done] checked ${rows.length} rows; sent=${sentCount}; minPrice=${MIN_PRICE}, maxDays=${MAX_DAYS}`);
})().catch(err => {
  console.error("ERROR:", err?.response?.status, err?.response?.statusText, err?.message);
  process.exit(1);
});
