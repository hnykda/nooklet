/**
 * The one counting rule: whitespace-separated runs of anything, over a block's raw stored text.
 * `[[Some Page]]` is two words, `**bold**` one, a URL one — markup is not stripped, which keeps
 * the rule cheap and predictable. Shared with the app's All pages view (B-645), which counts on
 * the local replica: importing it from here is what keeps that column and this plugin's status-bar
 * item from ever disagreeing about the same page.
 */
export function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}
