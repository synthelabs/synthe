import { redactSecrets } from "../core/safety.ts";

// Shapes of personal data and secrets that a redacted pack, a telemetry export or anything the pilot publishes
// must not contain. Deliberately narrow: each shape is one a redaction step should have replaced with a token, and
// a false alarm stops an import or a publication, which is the safe side.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const SSN = /(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/;
const DIGIT_RUN = /(^|[^0-9])((?:\d[ -]?){12,18}\d)(?=[^0-9]|$)/g;

// The Luhn checksum real payment card numbers satisfy; random digit runs (order numbers) mostly do not.
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[2].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^0+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

// The kinds of personal data or secret found in the text, as plain names. Never returns the matched text.
export function personalDataKinds(text: string): string[] {
  const kinds: string[] = [];
  if (EMAIL.test(text)) kinds.push("email address");
  if (hasCardNumber(text)) kinds.push("payment card number");
  if (SSN.test(text)) kinds.push("national identity number");
  if (redactSecrets(text) !== text) kinds.push("credential");
  return kinds;
}
