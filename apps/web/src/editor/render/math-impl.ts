/**
 * The lazily-loaded half of `./math.ts`: KaTeX plus its stylesheet (which references the fonts,
 * which the browser then fetches only for the glyph families a formula actually uses). Only this
 * file may import from `katex`.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import "./math.css";

export { katex };
