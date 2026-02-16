# Wiz v2 Light Control Guide

## Network Discovery

The Wiz light communicates over **UDP on port 38899** using JSON payloads. Discovery works by sending a UDP broadcast to the local network.

### Prerequisites

```bash
python3 -m venv /tmp/wiz-venv
/tmp/wiz-venv/bin/pip install pywizlight
```

### Discover Lights

```python
import asyncio
from pywizlight import discovery

async def main():
    bulbs = await discovery.discover_lights(broadcast_space="192.168.1.255")
    for bulb in bulbs:
        print(f"Found: {bulb.ip}")

asyncio.run(main())
```

**Result:** Found bulb at `192.168.1.2`

## Bulb Details

| Field | Value |
|-------|-------|
| IP | 192.168.1.2 |
| MAC | 9877d53d0bd8 |
| Module | ESP25_SHRGB_01 (RGB) |
| Firmware | 1.36.1 |
| Driver Chip | BP5758D |
| Color Temp Range | 2200K - 6500K |
| Gradient Support | Yes |

## Basic Control

```python
from pywizlight import wizlight, PilotBuilder
import asyncio

async def main():
    light = wizlight("192.168.1.2")

    # Get current state
    state = await light.updateState()
    print(f"On: {state.get_state()}")
    print(f"Brightness: {state.get_brightness()}")
    print(f"Color Temp: {state.get_colortemp()}")
    print(f"Scene: {state.get_scene()}")

    # Turn on with RGB color
    await light.turn_on(PilotBuilder(rgb=(255, 0, 0), brightness=255))

    # Turn on with color temperature
    await light.turn_on(PilotBuilder(colortemp=2700, brightness=128))

    # Turn off
    await light.turn_off()

asyncio.run(main())
```

## Light Dance Sequence

A multi-phase color dance: flashes, strobes, rainbow wave, breathing pulses, and a rapid-fire finale.

```python
from pywizlight import wizlight, PilotBuilder
import asyncio

async def dance():
    light = wizlight("192.168.1.2")

    state = await light.updateState()
    original_brightness = state.get_brightness()
    original_temp = state.get_colortemp()

    # (r, g, b, brightness, delay_seconds)
    moves = [
        # Flash section
        (255, 0, 0, 255, 0.4),
        (0, 0, 0, 0, 0.15),
        (0, 0, 255, 255, 0.4),
        (0, 0, 0, 0, 0.15),
        (0, 255, 0, 255, 0.4),
        (0, 0, 0, 0, 0.15),
        # Color parade
        (255, 0, 255, 255, 0.3),
        (255, 255, 0, 255, 0.3),
        (0, 255, 255, 255, 0.3),
        (255, 128, 0, 255, 0.3),
        # Strobe
        (255, 255, 255, 255, 0.1),
        (0, 0, 0, 0, 0.1),
        (255, 255, 255, 255, 0.1),
        (0, 0, 0, 0, 0.1),
        (255, 255, 255, 255, 0.1),
        (0, 0, 0, 0, 0.1),
        # Rainbow wave
        (255, 0, 0, 200, 0.25),
        (255, 127, 0, 200, 0.25),
        (255, 255, 0, 200, 0.25),
        (0, 255, 0, 200, 0.25),
        (0, 0, 255, 200, 0.25),
        (75, 0, 130, 200, 0.25),
        (148, 0, 211, 200, 0.25),
        # Red pulse
        (255, 0, 0, 50, 0.2),
        (255, 0, 0, 150, 0.2),
        (255, 0, 0, 255, 0.2),
        (255, 0, 0, 150, 0.2),
        (255, 0, 0, 50, 0.2),
        # Blue pulse
        (0, 0, 255, 50, 0.2),
        (0, 0, 255, 150, 0.2),
        (0, 0, 255, 255, 0.2),
        (0, 0, 255, 150, 0.2),
        (0, 0, 255, 50, 0.2),
        # Grand finale
        (255, 0, 0, 255, 0.12),
        (0, 255, 0, 255, 0.12),
        (0, 0, 255, 255, 0.12),
        (255, 255, 0, 255, 0.12),
        (255, 0, 255, 255, 0.12),
        (0, 255, 255, 255, 0.12),
        (255, 128, 0, 255, 0.12),
        (128, 0, 255, 255, 0.12),
        (255, 255, 255, 255, 0.5),
    ]

    for r, g, b, brightness, delay in moves:
        if brightness == 0:
            await light.turn_off()
        else:
            await light.turn_on(PilotBuilder(rgb=(r, g, b), brightness=brightness))
        await asyncio.sleep(delay)

    # Restore original state
    await light.turn_on(PilotBuilder(
        colortemp=original_temp or 2700,
        brightness=original_brightness or 43
    ))

asyncio.run(dance())
```

## Raw UDP Commands (No Library)

You can also control the bulb without pywizlight using raw UDP:

```bash
# Get current state
echo '{"method":"getPilot","params":{}}' | nc -u -w1 192.168.1.2 38899

# Turn on red at full brightness
echo '{"method":"setPilot","params":{"state":true,"dimming":100,"r":255,"g":0,"b":0}}' | nc -u -w1 192.168.1.2 38899

# Turn off
echo '{"method":"setPilot","params":{"state":false}}' | nc -u -w1 192.168.1.2 38899

# Get system config (MAC, firmware, etc.)
echo '{"method":"getSystemConfig","params":{}}' | nc -u -w1 192.168.1.2 38899
```

## HomeKit Integration

### Via Home Assistant (recommended — already running on Mac Mini "chip" at 192.168.1.4)

1. In HA: **Settings > Devices & Services > Add Integration > WiZ** (may auto-discover at 192.168.1.2)
2. In HA: **Settings > Devices & Services > Add Integration > HomeKit Bridge** — select "light" domain
3. Scan the QR code from HA notifications in the Apple Home app

### Prerequisite

In the Wiz v2 phone app, enable **Settings > Security > Allow local communication**.

### HA External URL

`https://home.cookiesden.com` (internal: `http://192.168.1.4:8123`)
