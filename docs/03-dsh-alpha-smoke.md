# Isolated smoke on unverified DSH candidates

Tracker: [#29](https://github.com/lninghaha/dsh-coding-subscription-oauth/issues/29)

Use this cadence for hosts listed under `compatibility/dsh-bom.json` → `candidates[]` (today: `0.2.0-rc.1`). A candidate is a host **outside** `supportedDshRange`; hosts inside that range already start the plugin and need no ceremony.

## Rules

- Isolated `DSH_HOME=/tmp/dsh-verify-sub-<ver>` only.
- Prefix-install the candidate CLI; do **not** overwrite the operator's installed DSH.
- High port (default `18381`); never `3080`.
- Never restart operator `dsh-web`.
- Do **not** use `smoke:deployed` for this cadence (touches real sessions).
- Comment versions + reveal allow/deny codes on #29; never paste keys.

## Quick path (`0.1.2-alpha.*`)

```bash
pnpm run assert:node
pnpm run smoke:dsh-alpha
```

## Manual path (`0.2.0-rc.1` or other candidates)

1. Prefix-install: `npm install --prefix /tmp/dsh-cli-$VER @deepseek-ai/dsh@$VER`
2. `export DSH_HOME=/tmp/dsh-verify-sub-$VER`
3. `dsh plugin --profile web add <path-or-tarball>` then `dsh web --port 18381 --no-open`
4. Authenticate the isolated Web UI the way the candidate host requires (for example cookie after `/?token=…` on `0.1.5-rc.1`)
5. Assert Settings → Coding OAuth loads; client inject must not hard-fail on missing `@deepseek-ai/dsh-client-runtime`
6. Run the security checks below; kill only the smoke PID

## Checks

1. Loopback `Host` gateway reveal → allowed (non-403)
2. Non-loopback `Host` → **403**
3. No Cordis startup failure and no `allow-version` exemption prompt

A candidate outside `supportedDshRange` requires an explicit exemption to boot. Once a candidate is promoted, widen `supportedDshRange`, move the host into `verified`, and re-run `pnpm run check` — do **not** answer a startup denial by reintroducing an exact peer pin.
