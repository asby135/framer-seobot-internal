// Human-readable labels for article status. Raw values like
// "generation_failed" leak the underscore into the UI when displayed directly.
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  review: "Needs Review",
  published: "Published",
  generation_failed: "Failed",
  archived: "Archived",
};

export function humanStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
