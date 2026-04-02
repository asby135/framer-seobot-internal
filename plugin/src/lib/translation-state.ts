// Shared module-level state for tracking translation progress across components.
// This persists across tab switches since the module stays loaded.

type Listener = () => void;

const translatingArticles = new Set<string>();
const listeners = new Set<Listener>();

export function isTranslating(articleId: string): boolean {
  return translatingArticles.has(articleId);
}

export function hasAnyTranslating(): boolean {
  return translatingArticles.size > 0;
}

export function getTranslatingIds(): string[] {
  return [...translatingArticles];
}

export function startTranslating(articleId: string): void {
  translatingArticles.add(articleId);
  notify();
}

export function stopTranslating(articleId: string): void {
  translatingArticles.delete(articleId);
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) {
    listener();
  }
}
