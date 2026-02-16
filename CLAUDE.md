# wiz — Claude Code context

## Project

Single-file Bun CLI (`wiz`) that controls Wiz v2 RGB smart lights over LAN via UDP JSON-RPC.

No dependencies. No build step. The `wiz` file is both the source and the executable (`#!/usr/bin/env bun`).

## Architecture

Everything lives in one file, organized top-to-bottom:

1. `.env` loader — non-fatal, sets `envLoaded` flag (script-relative via `import.meta.url`)
2. Config constants and mode definitions (`MODES` object)
3. Arg parser — supports preset flags, hex colors, brightness, overrides
4. Terminal helpers — ANSI escape codes, cursor control
5. SDF toolkit — `smoothstep`, `sdCircle`, `sdBox`, value noise, density ramp
6. Shader factory — `createShaders(mode)` returns per-mode shaders, avoids null mode refs at module scope
7. Renderer class — takes shader + title, drives the animation loop at 50ms interval
8. Helpers — `saveEnv`, `formatMac`, `describeState`, `promptInput`
9. Network — UDP send/receive, broadcast discovery, subnet scan fallback, retry logic
10. Discover-all primitives — `discoverAll` (broadcast), `discoverAllSubnetScan`, `getSystemConfig`
11. Guards — `requireMac()`, `requireBulbIp(mac)` with cached IP fast path
12. Commands — `cmdDiscover`, `cmdOn`, `cmdOff`, `cmdStatus`, `cmdAnimatedPreset`
13. Command router — entry point, dispatches based on `process.argv[2]`

## Wiz protocol

- UDP port 38899, JSON-RPC (no auth, LAN trust)
- `setPilot` for control, `getPilot` for state, `registration` for discovery
- RGB mode: always include `w: 0, c: 0`; minimum dimming = 10
- Color temp mode: dimming can go as low as 1; range 2200-6500K
- Never mix `temp` with `r/g/b` in the same command
- `state: false` to turn off (not `dimming: 0`)
- Responses include `mac` field — verify it matches the target bulb

## Conventions

- No external dependencies — only `node:dgram`, `node:os`, `node:fs`, `node:path`, `node:url`
- ASCII rendering uses a 92-character density ramp with per-character true-color ANSI
- Shaders are SDF-based: signed distance functions for shapes, smoothstep for blending
- Network discovery: broadcast first, subnet scan fallback (batches of 30)
- All timeouts/retries are configurable via constants at the top

## Files

| File | Purpose |
|------|---------|
| `wiz` | The entire app — executable Bun script |
| `.env` | `WIZ_MAC=<mac>` + `WIZ_IP=<ip>` — not committed, written by `wiz discover` |
| `env.example` | Template for `.env` |
| `.gitignore` | Ignores `.env` and `node_modules/` |

## Testing

No test suite. Test against a real bulb on the network:

- `wiz discover` — table shows devices, selection saves to `.env`
- `wiz status` — output matches physical bulb state
- `wiz off` → `wiz on` — bulb toggles, output shows state
- `wiz on` (second run) — cached IP fast path, no scan
- `wiz -chill` — animated preset flow still works
- `wiz` with no `.env` — first-run welcome, no crash
- Delete `.env`, `wiz -chill` — helpful error pointing to `wiz discover`
