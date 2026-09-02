const SOURCE_DOCUMENT_ID = "11piNVWd-2kF8Bd5hlZ4gNmLVP0R_czpDWNTvoElQAso";
const SOURCE_SHEET_ID = "1220163199";
const SOURCE_TAB = "ACTIVE CART";

function parseCsv(source) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function moneyCents(value) {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

function positiveNumber(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

const brandMarkers = [
  ["jerry garcia", "Jerry Garcia"],
  ["cannadots", "CannaDots"],
  ["canndots", "CannaDots"],
  ["honeypot", "HoneyPot"],
  ["cannatela", "Cannatela"],
  ["leilala", "Leilala & Watson"],
  ["joke n toke", "Joke n Toke"],
  ["satori", "Satori"],
  ["rosa reta", "Rosa Reta"],
  ["moondust", "Moondust"],
  ["royal genetics", "Royal Genetics"],
  ["wana", "Wana"],
  ["made in", "Made in Xiaolin"],
  ["flash", "Flash"],
];

function sourceRows(rows) {
  let brand = "urbanXtracts";
  const output = [];
  for (let index = 7; index < Math.min(rows.length, 160); index += 1) {
    const row = rows[index];
    const brandHeading = normalized(row[1]);
    for (const [needle, displayName] of brandMarkers) {
      if (brandHeading.includes(needle)) {
        brand = displayName;
        break;
      }
    }
    const productName = String(row[3] ?? "").trim();
    const unitPriceCents = moneyCents(row[8]);
    if (!productName || !unitPriceCents) continue;
    output.push({
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceSheetId: SOURCE_SHEET_ID,
      sourceTab: SOURCE_TAB,
      sourceRow: index + 1,
      brand,
      productName,
      productProfile: String(row[4] ?? "").trim() || null,
      terpenes: String(row[5] ?? "").trim() || null,
      thc: String(row[6] ?? "").trim() || null,
      caseSize: positiveNumber(row[7]),
      unitPriceCents,
      casePriceCents: moneyCents(row[9]),
    });
  }
  return output;
}

const response = await fetch(
  `https://docs.google.com/spreadsheets/d/${SOURCE_DOCUMENT_ID}/export?format=csv&gid=${SOURCE_SHEET_ID}`,
);
if (!response.ok) {
  throw new Error(`Wholesale source download failed with HTTP ${response.status}.`);
}
const rows = sourceRows(parseCsv(await response.text()));
if (rows.length !== 118) {
  throw new Error(`Expected 118 wholesale price rows; received ${rows.length}.`);
}
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
