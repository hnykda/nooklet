/**
 * Appearance basics (research/13 §4.2 item 6): the reader's text size, content width, and a box
 * of their own CSS. Three settings and a `<style>` tag, and deliberately no more — the demand
 * behind them (104 votes, ~600k theme downloads) is "let me read this at my size, my width, in my
 * colours", not a theme engine.
 *
 * Same shape and the same reasoning as `./page-title.ts` and `../app/theme.ts`: stored per device
 * in `localStorage`, never in the graph. How big the text is on THIS screen is a property of this
 * screen (a phone, a 27" monitor, a reader's eyes), not of the notes, and syncing it would make one
 * device's choice fight another's.
 *
 * The size and width are not written as pixel values from here. `styles/shell.css` is the one
 * place a raw size may appear (see its header); this module only sets `data-text-size` /
 * `data-measure` on `<html>` and the stylesheet's `:root[data-…]` blocks move the tokens. That
 * keeps the scale in one file, and it keeps this module free of numbers that would drift from it.
 *
 * Custom CSS is injected into one `<style id="nooklet-custom-css">` that is REPLACED on every
 * change, never appended to: appending would leave every previous draft of a rule in the document,
 * and "why does my old colour still show" is exactly the kind of bug nobody can see the cause of.
 * Nothing is validated beyond "it is text" — this is the reader's own machine and their own page.
 */

import { createSignal } from "solid-js";

export type TextSize = "small" | "default" | "large" | "larger";
export type ContentWidth = "narrow" | "normal" | "wide";

export const TEXT_SIZES: ReadonlyArray<{ value: TextSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

export const CONTENT_WIDTHS: ReadonlyArray<{ value: ContentWidth; label: string }> = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
];

const TEXT_SIZE_KEY = "nooklet.appearance.textSize";
const WIDTH_KEY = "nooklet.appearance.contentWidth";
const CSS_KEY = "nooklet.appearance.customCss";
const STYLE_ID = "nooklet-custom-css";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. The default is fine.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Preference lost on reload; not worth surfacing.
  }
}

function isTextSize(v: unknown): v is TextSize {
  return TEXT_SIZES.some((s) => s.value === v);
}

function isContentWidth(v: unknown): v is ContentWidth {
  return CONTENT_WIDTHS.some((w) => w.value === v);
}

function loadTextSize(): TextSize {
  const v = read(TEXT_SIZE_KEY);
  return isTextSize(v) ? v : "default";
}

function loadContentWidth(): ContentWidth {
  const v = read(WIDTH_KEY);
  return isContentWidth(v) ? v : "normal";
}

function loadCustomCss(): string {
  return read(CSS_KEY) ?? "";
}

const [textSizeSignal, setTextSizeSignal] = createSignal<TextSize>(loadTextSize());
const [widthSignal, setWidthSignal] = createSignal<ContentWidth>(loadContentWidth());
const [cssSignal, setCssSignal] = createSignal<string>(loadCustomCss());

function applyTextSize(size: TextSize): void {
  if (typeof document === "undefined") return;
  // The default is the absence of the attribute, so `:root`'s own scale applies untouched.
  if (size === "default") delete document.documentElement.dataset.textSize;
  else document.documentElement.dataset.textSize = size;
}

function applyContentWidth(width: ContentWidth): void {
  if (typeof document === "undefined") return;
  if (width === "normal") delete document.documentElement.dataset.measure;
  else document.documentElement.dataset.measure = width;
}

function applyCustomCss(css: string): void {
  if (typeof document === "undefined") return;
  // Replace, never append (see the header). Remove first, even when the new text is empty, so
  // clearing the box really does clear the page.
  for (const el of document.querySelectorAll(`#${STYLE_ID}`)) el.remove();
  if (css.trim() === "") return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** The reader's text size step. Reactive. */
export const textSize = textSizeSignal;
/** The reader's content width. Reactive. */
export const contentWidth = widthSignal;
/** The reader's own CSS, verbatim. Reactive. */
export const customCss = cssSignal;

export function setTextSize(size: TextSize): void {
  if (!isTextSize(size)) return;
  setTextSizeSignal(size);
  applyTextSize(size);
  write(TEXT_SIZE_KEY, size === "default" ? null : size);
}

export function setContentWidth(width: ContentWidth): void {
  if (!isContentWidth(width)) return;
  setWidthSignal(width);
  applyContentWidth(width);
  write(WIDTH_KEY, width === "normal" ? null : width);
}

export function setCustomCss(css: string): void {
  setCssSignal(css);
  applyCustomCss(css);
  write(CSS_KEY, css.trim() === "" ? null : css);
}

/**
 * Put the stored choices on the document. Runs once at import — `shell/AppShell.tsx` imports this
 * module for exactly that, so the stored size/width/CSS are on screen from the first paint rather
 * than whenever something else happens to import it first.
 */
export function applyAppearance(): void {
  applyTextSize(textSizeSignal());
  applyContentWidth(widthSignal());
  applyCustomCss(cssSignal());
}

applyAppearance();
