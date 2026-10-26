// Escape LIKE/ILIKE metacharacters so user input matches literally.
export function escapeIlike(term: string): string {
  return term.replace(/[\\%_]/g, String.raw`\$&`)
}
