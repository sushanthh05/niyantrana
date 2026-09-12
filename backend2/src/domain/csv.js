/**
 * Minimal RFC 4180 CSV parser.
 *
 * Hand-rolled rather than adding a dependency, and extracted here rather than
 * left in the seed script: wearable import needs the same parser, and a second
 * copy of a quoting-sensitive routine is how two copies drift apart
 * (Duplicate Code).
 *
 * A naive `split(',')` is not sufficient for either caller. Food names contain
 * commas ("Rice, parboiled"), and exported wearable CSVs quote any field that
 * might.
 */

/**
 * Parse CSV text into an array of objects keyed by the header row.
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }  // escaped quote
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const populated = rows.filter((cells) => cells.some((cell) => cell !== ''));
  if (!populated.length) return [];

  const [header, ...body] = populated;
  return body.map((cells) => Object.fromEntries(
    header.map((name, index) => [name.trim(), cells[index]]),
  ));
}

export default parseCsv;
