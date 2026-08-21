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

/** Why an article's FAQ schema is unusable, or "ok". */
export type FaqVerdict = "missing" | "invalid" | "not-faq" | "thin" | "ok";

/**
 * Minimum Q&A pairs for a FAQPage worth emitting.
 *
 * The generator is asked for 2-6. One pair parses and validates but is not
 * what the prompt asked for, and is the shape a truncated or retried
 * generation tends to leave behind — so it is reported rather than passed.
 */
export const MIN_FAQ_PAIRS = 2;

/**
 * Audit one article's schema_jsonld.
 *
 * Framer emits the BlogPosting/Article node itself from the CMS page, so the
 * only schema this pipeline owns is the FAQPage. A generation that fails its
 * schema retry still publishes — deliberately, an article without rich data
 * beats no article — which means missing schema is silent by design and has to
 * be looked for.
 */
export function faqVerdict(raw: string | null | undefined): FaqVerdict {
  if (!raw || !raw.trim()) return "missing";
  if (!isValidJsonLd(raw)) return "invalid";

  const obj = JSON.parse(raw) as Record<string, unknown>;
  const nodes: Array<Record<string, unknown>> = Array.isArray(obj["@graph"])
    ? (obj["@graph"] as Array<Record<string, unknown>>)
    : [obj];

  const faq = nodes.find((n) => n && n["@type"] === "FAQPage");
  if (!faq) return "not-faq";

  const entities = faq.mainEntity;
  const pairs = Array.isArray(entities) ? entities : entities ? [entities] : [];
  const answered = pairs.filter((q) => {
    const node = q as Record<string, unknown> | null;
    if (!node || node["@type"] !== "Question" || !node.name) return false;
    const a = node.acceptedAnswer as Record<string, unknown> | undefined;
    return Boolean(a && a.text);
  });

  return answered.length >= MIN_FAQ_PAIRS ? "ok" : "thin";
}
