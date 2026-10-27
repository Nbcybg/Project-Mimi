# Release checklist

Use this before tagging a release that includes the connector platform,
workflow reliability, versioning or security changes. Record the result and the
date; do not mark an item passed without running it.

## 1. Baseline

- [x] Node.js is `>= 24` (`node --version`).
- [ ] Dependencies installed from the lockfile in a clean checkout.
- [x] No `.env`, vault file, user profile or real credential is part of the
      change.
- [x] Version in `package.json` and `CHANGELOG.md` agree.
- [x] The target platforms are known: Windows, macOS, Docker, or a subset.

## 2. Typecheck and tests

```powershell
npm.cmd run typecheck
npm.cmd test
node --test packages/core/src/test/e2e/connector-workflow.e2e.test.ts
node --test packages/core/src/test/connector-performance.test.ts
```

- [x] Typecheck is clean.
- [x] Full suite passes. As of 2026-10-24 it is **528/528**.
- [x] E2E is **3/3**.
- [x] Performance is **5/5**.
- [x] No test calls a real provider; all network tests use `fakeFetch` or an
      injected `fetchFn`.
- [x] Performance numbers and bottlenecks are recorded in
      [`performance.md`](performance.md).

`PERF-4E-01` is resolved: the node-execution cap is 1000 and a capped run fails
explicitly instead of returning success. Keep the boundary regression test green.

## 3. Build and package

- [x] `npm.cmd run build:desktop` succeeds on the release machine (if the
      desktop package is in scope).
- [ ] `npm.cmd run build:mac` succeeds **on macOS**; this cannot be verified on
      Windows.
- [x] The built app starts with a fresh user folder and with an existing one.
- [ ] `docker build` / container start has been run, or Docker is explicitly out
      of scope for this release.
- [x] The packaged app contains no app-owned tests, test fixtures or local user
      data.

## 4. Migration and compatibility

- [ ] A copy of a real pre-release user folder upgrades on first start; keep the
      original backup untouched.
- [x] Fresh database reaches schema version **17**.
- [x] A version-1 database upgrades and keeps messages.
- [x] `node --test packages/core/src/test/db.test.ts packages/core/src/test/chat-media.test.ts`
      passes.
- [x] Workflows saved before 4C still run without a version pin and use the
      latest connector version.
- [x] Workflows pinned to an older connector version still run, and a removed
      pinned version fails with a readable error.
- [x] Imported n8n / Make / Zapier workflows remain disabled until enabled and
      carry no imported credentials.
- [x] OpenAPI import is still documented as draft-only if persistence has not
      shipped.

## 5. Secret scan

Run from the repository root and triage every hit:

```powershell
$patterns = 'xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]{20,}'
Get-ChildItem packages,docs,scripts -Recurse -File -Include *.ts,*.js,*.json,*.md |
  Select-String -Pattern $patterns
```

- [x] Every hit is a synthetic fixture or documentation placeholder, not a
      live credential.
- [x] No token appears in workflow JSON, run history, logs or a committed
      `user/` folder.
- [x] No real token appears in screenshots, docs or a bug report.
- [x] If a real credential was committed, revoke it at the provider before
      rewriting history.

## 6. Security and manual checks

- [x] `packages/core/src/test/connector-security.test.ts` passes (7 tests).
- [ ] A custom HTTP tool cannot reach a LAN address until **Allow local network
      (LAN)** is ticked; an existing LAN tool is re-saved with that option.
- [ ] An OAuth connector disconnects and reconnects; refresh happens once and
      the old refresh token is not replayed.
- [x] A webhook with a wrong signature is refused; a valid one runs once.
- [ ] Run the manual UI lists:
      [`ui-smoke.md`](ui-smoke.md), [`ui-smoke-phase2.md`](ui-smoke-phase2.md),
      [`migration-ui.md`](migration-ui.md), [`longtail-ui.md`](longtail-ui.md).
- [x] A run hit by a node timeout is recorded as failed, not left running.
- [x] A duplicate webhook event does not run the workflow twice.

Residual risks accepted in [`security-review.md`](security-review.md): DNS
rebinding TOCTOU, optional PKCE, no provider revocation call, and trusted
MCP/shell configuration. These do not replace the checks above.

## 7. Verification log

**2026-10-24 (Windows 10.0.26200, Node v24.18.0)**

- `npm.cmd run typecheck`: clean.
- `npm.cmd test`: **528/528** passing.
- Connector E2E: **3/3**; performance/stress: **5/5**; security:
  **7/7**; migration files: **15/15**.
- `npm.cmd run build:desktop`: succeeded; `dist/Mimi/Mimi-0.5.0-win64.zip`
  is 213.7 MB and contains `Mimi.exe`, the bundled Node runtime and Electron.
  App-owned `test`/`fixtures` trees are excluded from the package.
- Packaged server smoke test: `/health` returned
  `{"ok":true,"version":"0.5.0",...}` with a fresh user folder and again with
  the same folder; the resulting database is schema **17**.
- Secret scan: 4 hits, all synthetic `demo-placeholder-token-not-real` or
  `xoxb-migration-test-token` fixtures.
- Docker CLI is not installed; macOS packaging and the manual UI/security
  checks were not run.

## 8. Release decision

| Gate | Result | Date / owner |
| --- | --- | --- |
| Typecheck | Pass | 2026-10-24 |
| Full tests | Pass, 528/528 | 2026-10-24 |
| E2E / performance | Pass, 3/3 and 5/5 | 2026-10-24 |
| Windows package | Pass, build + fresh/existing smoke | 2026-10-24 |
| macOS package | Blocked: needs macOS | |
| Docker | Blocked: Docker not installed | |
| Migration | Partial: automated and schema 17 pass; real user folder pending | 2026-10-24 |
| Secret scan | Pass, synthetic hits only | 2026-10-24 |
| Manual UI / security | Pending | |
| PERF-4E-01 regression | Pass, 1000-node cap test | 2026-10-24 |

Current decision: hold release until macOS, Docker, the real-folder migration
and the manual UI/security gates are either run or explicitly waived.

Any unchecked gate needs an explicit written decision, not a silent waiver.
