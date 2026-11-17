// What a candidate prompt may add. Lane: egress and privacy. The shared candidateProblem (src/core/safety.ts) checks
// a prompt for secrets and size and has no baseline to compare with; the pilot also looks at the lines a candidate
// adds, because the candidate is shown to people and run on live traffic, and a prompt line can make the agent put
// conversation text into a link or an image that the reader's browser or the customer's client then fetches.

const URL_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/\S/i;
const SCHEME_RELATIVE = /(^|[\s(<[`"'])\/\/[a-z0-9][a-z0-9.-]*\.[a-z]/i;
const WEB_ADDRESS = /\b(?:www\.|(?:data|javascript|mailto|file):)\S/i;
const MARKDOWN_IMAGE = /!\[/;
// {order_id}, {{customer_message}}, ${name}: a slot that something fills with conversation text.
const PLACEHOLDER = /\$?\{\{?\s*[A-Za-z_][\w.-]*\s*\}?\}/;
const ACTIVE_HTML = /<\s*(?:img|script|iframe|a|link|svg|object|embed|video|audio|source|meta|style|form|input|base)\b/i;
// A long unbroken run of base64 or hex characters: a place to hide encoded text.
const ENCODED_RUN = /[A-Za-z0-9+/]{32,}|(?<![0-9a-fA-F])[0-9a-fA-F]{24,}(?![0-9a-fA-F])/;

const linesOf = (text: string): string[] => text.split(/\r\n|[\n\r\u2028\u2029]/);

// Returns why the lines the candidate adds to the baseline are refused, or null. The message names the kind of
// content and the line, never the line.
export function addedLineProblem(baseline: string, candidate: string): string | null {
  const had = new Set(linesOf(baseline).map((l) => l.trim()));
  const checks: [RegExp, string][] = [
    [URL_SCHEME, "a link or web address"], [SCHEME_RELATIVE, "a link or web address"], [WEB_ADDRESS, "a link or web address"],
    [MARKDOWN_IMAGE, "a markdown image"], [ACTIVE_HTML, "an HTML tag that loads or links something"],
    [PLACEHOLDER, "a {placeholder} that would be filled with conversation text"], [ENCODED_RUN, "a long run of encoded-looking characters"],
  ];
  const lines = linesOf(candidate);
  for (let i = 0; i < lines.length; i++) {
    if (had.has(lines[i].trim())) continue;
    for (const [pattern, what] of checks) if (pattern.test(lines[i])) return `it adds ${what} on line ${i + 1}, which a candidate may not do`;
  }
  return null;
}
