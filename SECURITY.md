# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 6.5.x   | Yes       |
| < 6.5   | No        |

Only the latest 6.5.x release receives security fixes. Please upgrade before
reporting an issue that may already be fixed.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

https://github.com/vexify-org/JSQL-neo/security/advisories/new

If private reporting is unavailable, contact the maintainer
[@vexify-root](https://github.com/vexify-root) on GitHub and ask for a private
channel before sharing details.

Please include:

- Affected version and commit/tag
- Operating system, architecture, Node.js version, and engine (native, WASM, or JS)
- A minimal reproduction or proof of concept
- Impact and attack surface (for example: protocol server, plugin loading,
  `postinstall` download, SQL parser, native module)
- Any known mitigations or workarounds

## What to expect

- We aim to acknowledge reports within 72 hours.
- We will confirm the affected versions and assess severity.
- We will keep you informed of remediation progress and coordinate disclosure.
- We aim to release a fix within 30 days for high-severity issues, sooner when
  practical. Complex issues may take longer; we will explain the timeline.

Please give us a reasonable window to fix the issue before public disclosure.
We will credit reporters in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- SQL execution, parsing, and storage engine behavior
- MySQL, PostgreSQL, MongoDB, and Redis protocol servers
- Authentication, access control, and cross-database isolation
- Plugin and JavaScript module sandboxing
- Native module loading and the `postinstall` download/verification path
- Denial of service caused by untrusted network input

Out of scope:

- Vulnerabilities in third-party dependencies (report them upstream; we will
  update when a fixed release is available)
- Attacks that require a trusted local user to run arbitrary code or modify the
  database files directly
- Social engineering, physical access, or compromised maintainer accounts
- Missing security headers on documentation-only sites
- Reports generated solely by automated scanners without a demonstrated impact

## Safe harbor

We support good-faith security research. If you follow this policy, do not
access or modify other users' data, do not disrupt production systems, and do
not disclose the issue publicly before a fix is available, we will not pursue
legal action and will work with you on disclosure.

## Security practices

- Release assets are published with `SHA256SUMS`; the installer verifies the
  checksum and fails closed.
- Native downloads are restricted to the official GitHub release host, with
  redirects validated and authorization headers stripped on cross-origin hops.
- JavaScript modules and user-defined functions run in a restricted sandbox by
  default. Full host access requires explicit opt-in via
  `JSQL_ALLOW_UNSAFE_MODULES=1` or `JSQL_ALLOW_UNSAFE_UDF=1`.
- Protocol servers enforce message-size limits and per-database access checks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and testing guidance.
