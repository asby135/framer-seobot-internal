/**
 * JSON-LD validation + HTML-safe serialization.
 *
 * schema_jsonld values are LLM-generated and rendered into a Framer page via
 * `<script type="application/ld+json">{{schema_jsonld | unsafeRaw}}</script>`.
 * That render path does NOT escape its input. A JSON string can legally
 * contain the literal text `</script>` (e.g. inside a headline or an FAQ
 * answer that quotes an HTML snippet), which would break out of the script
 * tag, stored XSS on every published article page.
 *
 * JSON.parse succeeding does NOT make a string safe for an HTML <script>
 * context. sanitizeJsonLd() parses, shape-checks, then re-serializes with the
 * HTML-significant characters escaped to \\uXXXX so the result is safe to embed
 * verbatim inside a <script> tag. This is the same escaping frameworks like
 * Next.js apply to inline JSON.
 */

/**
 * Minimum-shape predicate: valid JSON with `@context: "https://schema.org"`
 * and either `@type` or `@graph` present.
 *
 * This only checks parseability + shape. It does NOT check HTML safety,
 * use sanitizeJsonLd() before storing or emitting the value anywhere it will
 * be rendered.
 */
export function isValidJsonLd(raw: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return false;
    if (obj["@context"] !== "https://schema.org") return false;
    if (!obj["@type"] && !obj["@graph"]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate + return an HTML-<script>-safe serialization of the JSON-LD, or
 * null if the input is not valid JSON-LD.
 *
 * The returned string contains no literal `<`, `>`, `&`, U+2028, or U+2029,
 * it is safe to embed verbatim inside a `<script type="application/ld+json">`
 * tag. Escaping these characters to \\uXXXX does not change how a JSON parser
 * (or a schema.org consumer) reads the document.
 */
export function sanitizeJsonLd(raw: string): string | null {
  if (!isValidJsonLd(raw)) return null;
  // raw passed isValidJsonLd, so JSON.parse cannot throw here.
  const reserialized = JSON.stringify(JSON.parse(raw));
  return reserialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
