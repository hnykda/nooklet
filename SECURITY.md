# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/hnykda/nooklet/security/advisories/new).
Do not open a public issue for them.

Include what you found, how to reproduce it, which version or commit you tested, and how you run
the server (loopback, tailnet, public proxy, container). A proof of concept helps.

nooklet has one maintainer. You will get a reply on the advisory, and the fix and its disclosure
are coordinated with you there, with credit unless you prefer otherwise.

## Supported versions

nooklet has no stable release yet. Fixes go to the `main` branch; run the latest `main`.

## Scope

In scope: the server (`packages/server`), the web client (`apps/web`), the desktop shell
(`apps/desktop`), the iOS shell, the container image in `deploy/docker`, and the built-in plugins.

Out of scope, by design (see the [security model](docs/guide/security.md)):

- attacks that need write access to the server's data directory or the device's storage
- plugins installed by the operator, which run as trusted code
- a token holder doing what that token's scope allows
- plain-`http://` deployments beyond localhost, which are unsupported

The security model, the recommended deployment and the checklist for public exposure are in
[docs/guide/security.md](docs/guide/security.md) and
[docs/guide/self-hosting.md](docs/guide/self-hosting.md).
