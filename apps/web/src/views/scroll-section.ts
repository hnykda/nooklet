/**
 * Scroll a Settings section to the top and keep it there while the panel is still filling in.
 *
 * A one-off `scrollIntoView` at mount was not enough: the sections above load their data after
 * the panel opens (templates, embeddings status, devices), so the scroll first lands clamped at
 * the end of a still-short panel, then those sections grow and push the target down. "Open plugin
 * manager" left Plugins 21 px from the bottom edge, or below it with more devices and templates on
 * the server (`tools/probes/settings-section-scroll.spec.ts`; `commands.spec.ts` B-98 failed in a
 * full e2e run with the section out of view).
 *
 * So the scroll is re-applied whenever the panel's size changes, until the person scrolls, clicks
 * or types — after that, where the panel sits is theirs — or the section goes away. Returns the
 * stop function, for `onCleanup`.
 */
export function scrollSectionIntoView(section: HTMLElement): () => void {
  // `scrollIntoView` and `ResizeObserver` are absent under jsdom; a missing scroll must not take
  // the panel down.
  const scroll = () => section.scrollIntoView?.({ block: "start" });
  scroll();
  const panel = section.parentElement;
  if (!panel || typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(scroll);
  observer.observe(panel);
  const userEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stop = () => {
    observer.disconnect();
    for (const type of userEvents) window.removeEventListener(type, stop, true);
  };
  for (const type of userEvents) window.addEventListener(type, stop, true);
  return stop;
}
