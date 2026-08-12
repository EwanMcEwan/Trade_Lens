/**
 * Minimal, dependency-free HTML table extraction.
 *
 * Both finviz and openinsider return HTML, not JSON, and both have changed
 * their markup over the years. So rather than indexing into fixed column
 * positions, this maps cells by their *header text* — a layout reshuffle
 * then reorders keys instead of silently returning garbage.
 */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  "#39": "'", "#039": "'", "#x27": "'", "#160": " ",
  delta: "Δ", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'",
  ldquo: '"', rdquo: '"', deg: "°", middot: "·", times: "×",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === "#") {
      const n = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(n)) return String.fromCodePoint(n);
    }
    return m;
  });
}

/** Strip tags and collapse whitespace, keeping the visible text of a cell. */
export function cellText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
  ).replace(/\s+/g, " ").trim();
}

/** Normalise a header into a stable object key: "Filing Date" -> "filing_date". */
export function normaliseHeader(s) {
  return cellText(s)
    // Spell out the delta sign first. openinsider's "ΔOwn" column would
    // otherwise collapse to "own" and collide with its "Owned" column,
    // whichever way the site happens to emit the character.
    .replace(/[Δδ]/g, "delta ")
    .toLowerCase()
    .replace(/[%$]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "col";
}

/** Split a chunk of HTML into its <tr> rows, each as an array of cell HTML. */
function extractRows(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(tableHtml))) {
    const cells = [];
    const tdRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(c[2]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Every <table> in the document, outermost-first, as raw HTML strings. */
function extractTables(html) {
  const out = [];
  const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}

/**
 * Find the first table whose header row contains all of `requiredHeaders`
 * (matched case-insensitively as substrings) and return its rows as objects.
 *
 * Returns { headers, rows } or null when no table matches.
 */
export function parseTable(html, requiredHeaders = []) {
  const required = requiredHeaders.map(h => h.toLowerCase());

  for (const table of extractTables(html)) {
    const raw = extractRows(table);
    if (raw.length < 2) continue;

    // The header is the first row whose cells satisfy every requirement.
    let headerIdx = -1;
    for (let i = 0; i < Math.min(raw.length, 4); i++) {
      const texts = raw[i].map(c => cellText(c).toLowerCase());
      const ok = required.every(req => texts.some(t => t.includes(req)));
      if (ok) { headerIdx = i; break; }
    }
    if (headerIdx === -1) continue;

    const headerCells = raw[headerIdx].map(cellText);
    // Disambiguate repeated headers (finviz reuses blanks) so keys stay unique.
    const seen = new Map();
    const headers = headerCells.map(h => {
      const base = normaliseHeader(h);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}_${n}`;
    });

    const rows = [];
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const cells = raw[i];
      // Skip repeated header bands and spacer rows.
      if (cells.length < Math.max(2, Math.floor(headers.length / 2))) continue;
      const obj = {};
      headers.forEach((h, j) => { obj[h] = cells[j] === undefined ? "" : cellText(cells[j]); });
      obj._html = cells;
      rows.push(obj);
    }
    if (rows.length) return { headers, rows };
  }
  return null;
}

/** Pull the first href out of a cell's raw HTML, if there is one. */
export function firstHref(cellHtml) {
  const m = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(String(cellHtml || ""));
  return m ? decodeEntities(m[1]) : null;
}

/** "1,234.56" -> 1234.56 ; "$1.2M" -> 1200000 ; "" -> null */
export function toNumber(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/[$,+]/g, "").replace(/\s/g, "");
  if (!t || t === "-" || t === "—") return null;
  let mult = 1;
  const suffix = t.slice(-1).toUpperCase();
  if (suffix === "K") { mult = 1e3; t = t.slice(0, -1); }
  else if (suffix === "M") { mult = 1e6; t = t.slice(0, -1); }
  else if (suffix === "B") { mult = 1e9; t = t.slice(0, -1); }
  else if (suffix === "%") { t = t.slice(0, -1); }
  const neg = /^\(.*\)$/.test(t);
  if (neg) t = t.slice(1, -1);
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return (neg ? -n : n) * mult;
}
