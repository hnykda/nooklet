/**
 * B-706: a token pasted into a form, cleaned and checked before anything is sent.
 *
 * The owner pasted a valid device token with the `.` that followed it in a chat message; the
 * server refused `nk_….`, and the screen said the token "was rejected", so the hunt was for a
 * revoked token rather than a stray character. Tokens have a fixed shape, so both mistakes can be
 * caught here: what surrounds a token when it is copied out of prose is stripped, and what is left
 * is checked against the shape the server mints.
 */

/**
 * `nk_` + 24 random bytes in hex (`packages/server/src/auth/tokens.ts#createToken`). Also `vrt_`,
 * the prefix tokens were minted with before the rename: the server checks a token by its hash
 * alone, so those still work and must not be refused here.
 */
export const DEVICE_TOKEN_RE = /^(?:nk|vrt)_[0-9a-f]{48}$/;
export const DEVICE_TOKEN_LENGTH = 51;
/** `nkroot_` + 24 random bytes in hex (`packages/server/src/auth/root-token.ts`). */
export const ROOT_TOKEN_RE = /^nkroot_[0-9a-f]{48}$/;
export const ROOT_TOKEN_LENGTH = 55;

/**
 * Whitespace anywhere (a token copied across a line wrap, a trailing newline), then quotes,
 * backticks and brackets around it and punctuation after it, as prose and Markdown leave them:
 * `"nk_…".`, `` `nk_…` ``, `(nk_…),`. Nothing stripped can be part of a token: those are letters,
 * digits and `_` only.
 */
export function normalizeToken(raw: string): string {
  let t = raw.replace(/\s+/g, "");
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^["'`‘’“”«»([{<]+/, "").replace(/["'`‘’“”«»)\]}>.,;:!?…]+$/, "");
  } while (t !== prev);
  return t;
}

export type TokenKind = "device" | "root";

/**
 * Why `token` (already normalised) is not a `kind` token, or `undefined` if it has the shape. Says
 * which token it is when it is the other kind — the switcher's form takes both, for different
 * buttons, so pasting the wrong one is an easy slip.
 */
export function tokenShapeProblem(token: string, kind: TokenKind): string | undefined {
  if (kind === "device") {
    if (DEVICE_TOKEN_RE.test(token)) return undefined;
    if (ROOT_TOKEN_RE.test(token)) {
      return (
        "That's the server's root token (nkroot_…), which can't connect a device. Create a device " +
        "token with `nooklet token create` on the machine running nooklet: it starts with nk_ and " +
        `is ${DEVICE_TOKEN_LENGTH} characters.`
      );
    }
    return (
      "That doesn't look like a nooklet token — it should start with nk_ and be " +
      `${DEVICE_TOKEN_LENGTH} characters.`
    );
  }
  if (ROOT_TOKEN_RE.test(token)) return undefined;
  if (DEVICE_TOKEN_RE.test(token)) {
    return (
      "That's a device token (nk_…). This needs the server's root token — run `nooklet token " +
      `root\` on the machine running it: it starts with nkroot_ and is ${ROOT_TOKEN_LENGTH} characters.`
    );
  }
  return (
    "That doesn't look like a root token — it should start with nkroot_ and be " +
    `${ROOT_TOKEN_LENGTH} characters.`
  );
}
