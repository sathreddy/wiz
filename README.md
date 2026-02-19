# wiz

Control your [Wiz](https://www.wizconnected.com/) smart lights from the terminal. Each mode plays a unique ASCII animation while it sets the light.

Single file, no dependencies, runs on [Bun](https://bun.sh).

## Getting started

### 1. Install Bun

```sh
brew install oven-sh/bun/bun
```

Or see [bun.sh](https://bun.sh) for other install methods.

### 2. Clone this repo

```sh
git clone https://github.com/sathreddy/wiz.git
cd wiz
```

### 3. Add `wiz` to your PATH

```sh
ln -s "$(pwd)/wiz.ts" ~/bin/wiz
```

> Make sure `~/bin` is in your PATH. If it isn't, add `export PATH="$HOME/bin:$PATH"` to your `~/.zshrc` (or `~/.bashrc`), then restart your terminal.

### 4. Find your bulb

Make sure your Wiz bulb is powered on and connected to the same Wi-Fi network as your computer, then run:

```sh
wiz discover
```

This scans your network, shows a table of bulbs it finds, and lets you pick one to save as your default. You only need to do this once.

## Usage

### Presets

```sh
wiz -movie          # 1% brightness, 2200K — movie time
wiz -chill          # 40% brightness, 2700K — warm evening
wiz -day            # 100% brightness, 5000K — bright daylight
```

### Basics

```sh
wiz on              # turn light on (restores previous setting)
wiz off             # turn light off
wiz status          # show current brightness, color, and power state
```

### Custom colors and brightness

```sh
wiz ff6b35          # set color by hex code
wiz ff6b35 50       # hex color at 50% brightness
wiz -b 75           # just set brightness (1-100)
wiz -chill -b 60    # preset with brightness override
```

## Network troubleshooting

`wiz` talks to your bulb over your local Wi-Fi — no cloud, no internet required. But some routers make this harder than it should be.

**Common issues:**

- **Bulb not found?** Make sure the bulb is on the same Wi-Fi network. Wiz bulbs only connect to 2.4GHz, so if your computer is on 5GHz, your router needs to allow cross-band traffic.
- **Discovery is slow?** Some routers block UDP broadcast between devices. `wiz` automatically falls back to scanning your subnet directly. After the first successful scan, it remembers the bulb's IP so future commands are instant.
- **Router in "Route" mode?** Some ISP-provided routers (Airtel GPON, etc.) default to a mode that isolates devices from each other. Look for a "Port Mode" or "AP Isolation" setting and switch it to Bridge mode.

If discovery keeps failing, try `wiz discover` after power-cycling the bulb.

## Make it your own

This is a single-file script — everything lives in `wiz.ts`. Fork this repo and customize it however you want:

- **Add your own presets** — the `MODES` object near the top of the file defines each preset's brightness, color temperature, and the ASCII animation it plays. Copy one and tweak the values.
- **Change the animations** — each preset has a shader function that draws the terminal animation frame-by-frame. They use simple math (sine waves, circles, noise) — no graphics libraries.
- **Add new commands** — the command router at the bottom of the file dispatches based on the first argument. Add a new `else if` branch and a command function.
- **Control multiple bulbs** — the `.env` file stores one bulb's MAC and IP. You could extend it to support named bulbs, rooms, or groups.

### Project structure

| File | What it does |
|------|-------------|
| `wiz.ts` | The entire app — one executable script |
| `.env` | Your bulb's MAC address and IP (created by `wiz discover`, not committed) |
| `env.example` | Template showing the available config variables |

## How it works

1. Checks for a cached bulb IP in `.env` — if it responds, uses it instantly
2. Otherwise races a UDP broadcast against a subnet scan to find the bulb by MAC address
3. Sends commands via the Wiz JSON-RPC protocol (UDP port 38899)
4. Verifies the bulb state after each command and retries on failure
