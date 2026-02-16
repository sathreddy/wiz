# wiz

CLI to control Wiz smart lights over your local network. Built with [Bun](https://bun.sh).

Each mode plays a unique ASCII shader animation in your terminal while setting the light.

## Setup

```sh
# clone and configure
cp env.example .env
# edit .env — set WIZ_MAC to your bulb's MAC address (no colons, lowercase)

# symlink into your PATH
ln -s "$(pwd)/wiz" ~/bin/wiz
```

Requires [Bun](https://bun.sh) (`brew install oven-sh/bun/bun`).

## Usage

```
wiz <mode> [options]
```

### Presets

| Mode | Brightness | Temp | Use case |
|------|-----------|------|----------|
| `-movie` | 1% | 2200K | Pico projector darkness |
| `-chill` | 40% | 2700K | Warm evening ambiance |
| `-day` | 100% | 5000K | Bright daylight |

### Custom

```sh
wiz ff6b35          # set color by hex
wiz ff6b35 50       # hex color at 50% brightness
wiz -b 75           # brightness only (1-100)
wiz -chill -b 60    # preset with brightness override
```

## How it works

1. Discovers bulb on the local network by MAC address (UDP broadcast, falls back to subnet scan)
2. Sends `setPilot` command via Wiz JSON-RPC protocol (UDP port 38899)
3. Verifies state with `getPilot`, retries on failure (3x with 500ms delay)

## Protocol

Wiz bulbs speak a JSON-RPC protocol over UDP on port 38899. Key commands:

- `registration` — discover bulbs via broadcast
- `getPilot` — read current light state
- `setPilot` — set color, temperature, brightness, power
- `getSystemConfig` — read MAC, firmware, module info

Quirks:
- RGB mode: must send `w: 0, c: 0` or white LEDs contaminate the color
- RGB mode minimum dimming is 10; color temp mode accepts dimming as low as 1
- Never send `temp` and `r/g/b` in the same command
- `dimming: 0` does not turn off the light — use `state: false`
