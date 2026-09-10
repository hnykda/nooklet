/**
 * Page naming rules.
 *
 * - Identity is case-insensitive (like Logseq): `key = normalizePageName(name)`.
 * - Namespaces use "/" inside the name: "A/B/C" is a child of "A/B", which is a child of "A".
 * - File names (for markdown export / Logseq import) use Logseq's :triple-lowbar format:
 *   "/" becomes "___" and characters that are unsafe in file names are percent-encoded.
 */

export function normalizePageName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function namespaceParts(name: string): string[] {
  return name
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** "A/B/C" -> "A/B"; "A" -> null */
export function namespaceParent(name: string): string | null {
  const parts = namespaceParts(name);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

/** All ancestors, nearest first: "A/B/C" -> ["A/B", "A"] */
export function namespaceAncestors(name: string): string[] {
  const out: string[] = [];
  let cur = namespaceParent(name);
  while (cur !== null) {
    out.push(cur);
    cur = namespaceParent(cur);
  }
  return out;
}

const UNSAFE_FILE_CHARS = /[<>:"\\|?*#%]/g;

/** Page name -> file base name (without extension), Logseq :triple-lowbar compatible. */
export function pageNameToFileName(name: string): string {
  let s = name.replace(
    UNSAFE_FILE_CHARS,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  // disambiguate underscores next to "/" and literal "___" before "/" becomes "___"
  s = s.replace(/___/g, "%5F%5F%5F").replace(/_\//g, "%5F/").replace(/\/_/g, "/%5F");
  s = s.replace(/\//g, "___");
  if (s.startsWith(".")) s = `%2E${s.slice(1)}`;
  return s;
}

/** File base name (without extension) -> page name. Accepts triple-lowbar and legacy %2F encodings. */
export function fileNameToPageName(base: string): string {
  let s = base.replace(/___/g, "/");
  try {
    s = decodeURIComponent(s);
  } catch {
    s = s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  }
  return s;
}
