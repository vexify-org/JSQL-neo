# Contributing to JSQL-NEO

Thanks for taking the time to contribute. JSQL-NEO is a Rust-powered embedded database with native, WASM, and pure-JS engines plus MySQL, PostgreSQL, MongoDB, and Redis protocol front ends.

## Code of Conduct

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report unacceptable behavior to the maintainers.

## Before you start

- Search existing [issues](https://github.com/vexify-org/JSQL-neo/issues) and pull requests to avoid duplicate work.
- For large features or breaking changes, open an issue first so we can agree on the approach.
- Security vulnerabilities must not be reported in public issues. See [SECURITY.md](SECURITY.md).

## Requirements

- Node.js 14 or newer (CI runs Node.js 22)
- npm
- Rust stable and Cargo for native changes (`rustup.rs`)
- A C toolchain (`build-essential`, Xcode Command Line Tools, or MSVC) for native builds

## Development setup

```bash
git clone https://github.com/vexify-org/JSQL-neo.git
cd JSQL-neo
npm install
npm test
```

`npm install` runs `postinstall.js`, which downloads a verified native binary for your platform or builds it from source when Cargo is available. If the native module is unavailable, the WASM/JS engine is used automatically.

Run the broader suite before opening a pull request:

```bash
npm run test:all
```

Useful focused commands:

```bash
npm run test:parser
npm run test:native
npm run test:multi
npm run test:mongo
npm run test:dml
npm run test:coverage
```

## Native module changes

The Rust crate lives in `nativesrc/jsql-neo-native`. Build it with:

```bash
cd nativesrc/jsql-neo-native
cargo build --release
```

Then copy the artifact to `native/jsql-neo-native.node`:

- Linux: `target/release/libjsql_neo_native.so`
- macOS: `target/release/libjsql_neo_native.dylib`
- Windows: `target/release/jsql_neo_native.dll`

When changing native behavior, update the JS fallback path as well and run both `npm run test:native` and `npm run test:wasm` (or `npm run test:all`). Keep the N-API surface compatible with N-API 6.

## Coding guidelines

- Match the style of the file you are editing; do not reformat unrelated code.
- Keep changes focused. One pull request should solve one problem.
- Add or update tests for behavior changes and bug fixes.
- Do not commit secrets, tokens, private keys, or generated binaries.
- Update `README.md`, `CHANGELOG.md`, or `doc/` when user-facing behavior changes.
- For protocol changes, test with a real client when possible (`mysql`, `psql`, `redis-cli`, `mongosh`) in addition to the unit tests.
- For security-sensitive paths, prefer fail-closed defaults and explicit opt-in escape hatches.

## Commit messages

Use clear, imperative messages. Conventional prefixes are encouraged:

```text
feat: add ...
fix: correct ...
docs: update ...
test: cover ...
refactor: simplify ...
chore: release vX.Y.Z
```

## Pull request process

1. Fork the repository and create a topic branch from `main`.
2. Make your changes, add tests, and run `npm test` plus `npm run test:all`.
3. Fill in the pull request template, including the related issue and test evidence.
4. Keep the pull request small and describe any breaking changes or security impact.
5. A maintainer will review. Address review comments with new commits; do not force-push unless asked.

CI runs the test suite and, for tagged releases, builds native modules for Linux (glibc and musl), macOS, and Windows.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

Questions are welcome in [GitHub Issues](https://github.com/vexify-org/JSQL-neo/issues). 中文贡献者也可以直接用中文提 issue 或 PR。
