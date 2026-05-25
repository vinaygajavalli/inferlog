/**
 * PII redaction. Runs in the worker, before previews touch the database, so raw
 * PII never lands at rest. Deliberately conservative pattern-based redaction —
 * it favours over-redaction. For production you'd layer a proper detector
 * (e.g. Presidio / a NER model) behind the same interface; the call site
 * wouldn't change.
 *
 * Returns the scrubbed text and whether anything was redacted, so the row can
 * carry a `pii_redacted` flag for auditing.
 */

interface Rule {
  type: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { type: "EMAIL", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  // E.164-ish / common phone formats
  {
    type: "PHONE",
    re: /(?<!\d)(\+?\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}(?!\d)/g,
  },
  // credit-card-like 13-16 digit groups
  { type: "CARD", re: /(?<!\d)(?:\d[ -]?){13,16}(?!\d)/g },
  // US SSN
  { type: "SSN", re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  // IPv4
  { type: "IP", re: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g },
  // common API key / bearer token shapes
  { type: "SECRET", re: /\b(sk|pk|rk|api|key|token|bearer)[-_][A-Za-z0-9]{12,}\b/gi },
];

export function redact(input: string | undefined): {
  text: string | undefined;
  redacted: boolean;
} {
  if (!input) return { text: input, redacted: false };
  let text = input;
  let redacted = false;
  for (const rule of RULES) {
    text = text.replace(rule.re, () => {
      redacted = true;
      return `[${rule.type}_REDACTED]`;
    });
  }
  return { text, redacted };
}
