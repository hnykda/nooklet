# Progress — QR pairing with one-time codes, device management under `admin` (B-655, B-603 follow-up)

Branch: this worktree's branch (based on main @ 72a2b12). Ports: 6470-6474 only. Not merged, not
pushed.

## Status

- [ ] Server: `pairing_code` table (schema v8), `pairing.create` / `pairing.redeem` /
      `token.list` / `token.revoke` ops, rate limiter, socket close on revoke
- [ ] Web: Settings → Devices, QR (lazy), `/pair` landing page, `nooklet://connect?…&code=…`
- [ ] CLI: `nooklet pair`
- [ ] Docs: security inventory, guide, sql-schema, ADR
- [ ] Verification

## Decisions

(filled in as made)

## How to resume

Read this file, `git log --oneline 72a2b12..HEAD`, then continue at the first unchecked item.

## BUGS.md updates to fold in

(filled in at the end)
