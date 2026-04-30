const required = ["LOAD_PLAN_CSV_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const csvUrl = process.env.LOAD_PLAN_CSV_URL;
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const trackerId = process.env.TRACKER_ID || "oldbury-main";
const defaultKennsPerLoad = Number(process.env.DEFAULT_KENNS_PER_LOAD || 11);
const preserveStatus = String(process.env.PRESERVE_STATUS || "true").toLowerCase() !== "false";

const statusFields = [
  "bumper_picking",
  "bumper_picked",
  "cage_picking",
  "cage_picked",
  "checked",
  "complete",
  "despatched",
  "shortage",
  "shortage_note",
  "bumper_picking_at",
  "bumper_picked_at",
  "cage_picking_at",
  "cage_picked_at",
  "checked_at",
  "complete_at",
  "despatched_at",
  "shortage_at"
];

function normaliseHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim());

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map(normaliseHeader);

  return lines.slice(1)
    .map((line) => {
      const cells = parseCsvLine(line);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = String(cells[index] || "").trim();
      });
      return row;
    })
    .filter((row) => Object.values(row).some((value) => String(value).trim()));
}

function truthy(value) {
  return ["1", "true", "yes", "y", "done"].includes(String(value || "").trim().toLowerCase());
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildType(row) {
  const raw = String(row.build_type || row.gru || row.bespoke || "").trim();
  const normalised = raw.toLowerCase();

  if (["bespoke", "yes", "y", "1", "true"].includes(normalised)) {
    return "Bespoke";
  }

  if (raw && !["n", "no", "false", "0"].includes(normalised)) {
    return raw;
  }

  return "";
}

function importRows(rawRows) {
  return rawRows
    .map((row, index) => ({
      tracker_id: trackerId,
      kenn: row.kenn || row.reference || "",
      model: row.model || "",
      build_type: buildType(row),
      colour: row.colour || row.color || "",
      notes: row.notes || "",
      shipment_date: row.shipment_date || row.ship_date || row.date || null,
      shortage_note: row.shortage_note || "",
      load_no: numberOrZero(row.load_no || row.load || row.load_number) || Math.floor(index / defaultKennsPerLoad) + 1,
      load_pos: numberOrZero(row.load_pos || row.position || row.load_position) || index % defaultKennsPerLoad + 1,
      bumper_picking: truthy(row.bumper_picking),
      bumper_picked: truthy(row.bumper_picked),
      cage_picking: truthy(row.cage_picking),
      cage_picked: truthy(row.cage_picked),
      checked: truthy(row.checked),
      complete: truthy(row.complete),
      despatched: truthy(row.despatched),
      shortage: truthy(row.shortage)
    }))
    .filter((row) => row.kenn);
}

async function supabase(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=minimal",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function fetchCsv() {
  const headers = {};

  if (process.env.LOAD_PLAN_CSV_BEARER_TOKEN) {
    headers.authorization = `Bearer ${process.env.LOAD_PLAN_CSV_BEARER_TOKEN}`;
  }

  const response = await fetch(csvUrl, { headers });

  if (!response.ok) {
    throw new Error(`CSV fetch failed (${response.status}): ${await response.text()}`);
  }

  return response.text();
}

function mergePreservedStatus(newRows, existingRows) {
  if (!preserveStatus) {
    return newRows;
  }

  const existingByKenn = new Map(existingRows.map((row) => [String(row.kenn), row]));

  return newRows.map((row) => {
    const existing = existingByKenn.get(String(row.kenn));

    if (!existing) {
      return row;
    }

    const preserved = {};
    statusFields.forEach((field) => {
      if (existing[field] !== undefined && existing[field] !== null) {
        preserved[field] = existing[field];
      }
    });

    return { ...row, ...preserved };
  });
}

async function main() {
  console.log(`Fetching load plan CSV for tracker ${trackerId}...`);
  const csvText = await fetchCsv();
  const parsedRows = parseCsv(csvText);
  const newRows = importRows(parsedRows);

  if (!newRows.length) {
    throw new Error("CSV did not contain any valid KENN rows.");
  }

  const existingRows = await supabase(`tracker_rows?tracker_id=eq.${encodeURIComponent(trackerId)}&select=*`, {
    headers: { prefer: "return=representation" }
  });

  const rowsToInsert = mergePreservedStatus(newRows, existingRows || []);

  console.log(`Replacing ${existingRows?.length || 0} existing rows with ${rowsToInsert.length} CSV rows...`);
  await supabase(`tracker_rows?tracker_id=eq.${encodeURIComponent(trackerId)}`, { method: "DELETE" });
  await supabase("tracker_rows", { method: "POST", body: JSON.stringify(rowsToInsert) });

  console.log("Load plan sync complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
