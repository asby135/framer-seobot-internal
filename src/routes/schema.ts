import { Hono } from "hono";

const schema = new Hono();

// Field definitions for Framer CMS managed collection
// Backend is the single source of truth for field schema (DRY)
const FIELDS = [
  { id: "image", name: "Image", type: "image" },
  { id: "title", name: "Title", type: "string" },
  { id: "slug", name: "Slug", type: "string" },
  { id: "category", name: "Category", type: "string" },
  { id: "created", name: "Created", type: "date" },
  { id: "updated", name: "Updated", type: "date" },
  { id: "summary", name: "Summary", type: "string" },
  { id: "content", name: "Content", type: "formattedText" },
  { id: "tool", name: "Tool", type: "string" },
];

schema.get("/", (c) => {
  return c.json({ fields: FIELDS });
});

export { schema };
