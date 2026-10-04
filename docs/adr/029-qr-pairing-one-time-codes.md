# ADR 029: Pair devices with one-time codes behind an https page; `admin` gates device management

Date: 2026-10-04. Status: accepted (design approved by the owner; implemented on the qr-pairing
branch, `docs/progress/qr-pairing.md`).

## Context

B-603 added `nooklet://connect?url=…&token=…`: a link that carries a device token. A QR code of it
would put a long-lived credential on screen, in screenshots and in the clipboard. B-655 recorded
that the `admin` scope granted nothing beyond `write`, and the owner decided it should gate server
administration: listing and revoking tokens (revoke a lost phone from another device), pairing.

## Decision

1. **One-time pairing codes.** An `admin` session asks for a code (`pairing.create`): 128 random
   bits, stored as sha256, single use, 10 minutes, granting at most `write` (+sync). A new code from
   the same creator cancels its earlier unused one. The phone trades the code for its own token
   (`pairing.redeem`), named after the device, with no other credential. The trade claims the code
   with a conditional UPDATE in the same transaction that mints the token, so it happens once.
2. **`pairing.redeem` is an op like any other**, in the one `defineOp` registry, marked
   `auth: "none"`. It is public only because its route is also on `PUBLIC_ROUTES`; either lock
   alone leaves it closed. It is HTTP-only (never MCP) and rate-limited in process (10/min per TCP
   peer, 60/min total). Unknown, expired, used and cancelled codes get one identical answer.
3. **The QR encodes an https page**, `https://<server>/g/<graph>/pair#code=…`, not the custom
   scheme. The page offers "Open in the nooklet app" (`nooklet://connect?url=…&code=…`) and, where
   the browser can run nooklet, "use this browser". The code is in the fragment, so it never
   reaches a server, proxy or tailnet log.
4. **`admin` = `write` + device management** (`pairing.create`, `token.list`, `token.revoke`).
   The loopback web-client auto-token becomes `admin`: a caller that can load the page as the
   server's own machine can already read the database and `root.token`. Pairing never yields
   `admin`. `token.revoke` closes the token's open WebSockets (B-676 H3).

## Alternatives rejected

- **QR of the token link.** Simple, but the QR is the credential, valid until revoked, wherever a
  photo or screenshot of it goes.
- **QR of `nooklet://connect?…&code=…` directly.** Apple does not document the Camera app opening
  custom schemes, and developer reports say it shows them as text or sends them to a browser
  (sources in the progress file). Universal Links would work but need an
  `apple-app-site-association` file on a domain in the app's entitlements, which a self-hosted
  server on each owner's own hostname cannot have.
- **Short human-typable codes (6 digits).** Brute-forceable without a strict lockout, and the code
  is never typed: it travels in a QR or a link.
- **A dedicated unauthenticated route outside the registry.** It would be a parallel path, which
  `CLAUDE.md` rules out; it would also be missing from OpenAPI and the typed client.
- **Letting the root token act as a graph admin.** A second auth path into every graph; the root
  token stays process-level (`/graphs` only).

## Costs

- One more public endpoint, and the first in-process rate limiter (per-process memory; a restart
  forgets counts).
- The desktop app's auto-token is now more powerful (it could revoke the phone). Acceptable for the
  reason in decision 4; `--no-loopback-token` turns it off.
- `token create --link` still exists and is still less safe; it is documented as such.
