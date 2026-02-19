#!/usr/bin/env bun

import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { networkInterfaces } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -- load .env from script directory (non-fatal) --

const __dir = dirname(fileURLToPath(import.meta.url));
const __envPath = resolve(__dir, ".env");
let envLoaded = false;

try {
  const envContent = readFileSync(__envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  envLoaded = true;
} catch {
  envLoaded = false;
}

// -- types --

interface WizPilotParams {
  state?: boolean;
  dimming?: number;
  temp?: number;
  r?: number;
  g?: number;
  b?: number;
  w?: number;
  c?: number;
}

interface WizPilotState {
  state: boolean;
  dimming: number;
  temp?: number;
  r?: number;
  g?: number;
  b?: number;
  mac?: string;
}

interface WizResponse {
  result?: WizPilotState & { success?: boolean; mac?: string };
}

type RGB = [number, number, number];

interface Mode {
  title: string;
  params: WizPilotParams;
  desc: string;
  verify: (s: WizPilotState) => boolean;
  tagline: string;
}

interface Shader {
  render(t: number, w: number, h: number): string[];
  color(x: number, y: number, ch: string, w: number, h: number): RGB;
  successColor(ch: string): RGB;
  headerColor: RGB;
  titleColor: RGB;
}

interface Particle {
  phase: number;
  speed: number;
  drift: number;
  size: number;
}

interface DiscoveredBulb {
  ip: string;
  mac: string;
  moduleName: string;
  firmware: string;
  state: WizPilotState | null;
}

// -- config --

const WIZ_PORT = 38899;
const DISCOVERY_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 2000;
const SUBNET_SCAN_TIMEOUT_MS = 200;
const SUBNET_BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

const MODES: Record<string, Mode> = {
  movie: {
    title: "m o v i e t i m e",
    params: { state: true, dimming: 1, temp: 2200 },
    desc: "1% brightness  ·  2200K warm white",
    verify: (s) => s.state === true && s.dimming <= 2 && s.temp === 2200,
    tagline: "enjoy the movie",
  },
  chill: {
    title: "c h i l l t i m e",
    params: { state: true, dimming: 40, temp: 2700 },
    desc: "40% brightness  ·  2700K warm white",
    verify: (s) => s.state === true && s.dimming >= 38 && s.dimming <= 42 && s.temp === 2700,
    tagline: "time to unwind",
  },
  day: {
    title: "d a y t i m e",
    params: { state: true, dimming: 100, temp: 5000 },
    desc: "100% brightness  ·  5000K daylight",
    verify: (s) => s.state === true && s.dimming >= 98 && s.temp === 5000,
    tagline: "let there be light",
  },
};

// -- parse args --

interface ParsedArgs {
  modeName: string | null;
  hexColor: string | null;
  brightness: number | null;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let modeName: string | null = null;
  let hexColor: string | null = null;
  let brightness: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i].replace(/^-+/, "");

    if (a in MODES) {
      modeName = a;
    } else if (a === "color" || a === "c") {
      hexColor = args[++i];
    } else if (a === "brightness" || a === "bright" || a === "b" || a === "dim") {
      brightness = parseInt(args[++i], 10);
    } else if (/^[0-9a-fA-F]{3,6}$/.test(a) || /^#[0-9a-fA-F]{3,6}$/.test(args[i])) {
      hexColor = a.replace(/^#/, "");
    } else if (/^\d+%?$/.test(a)) {
      brightness = parseInt(a, 10);
    }
  }

  if (hexColor) {
    hexColor = hexColor.replace(/^#/, "");
    if (hexColor.length === 3) hexColor = hexColor.split("").map(c => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(hexColor)) {
      console.error(`\x1b[31m  invalid hex color: ${hexColor}\x1b[0m`);
      process.exit(1);
    }
  }

  if (brightness !== null && (isNaN(brightness) || brightness < 1 || brightness > 100)) {
    console.error(`\x1b[31m  brightness must be 1-100\x1b[0m`);
    process.exit(1);
  }

  if (!modeName && (hexColor || brightness !== null)) {
    const r = hexColor ? parseInt(hexColor.slice(0, 2), 16) : null;
    const g = hexColor ? parseInt(hexColor.slice(2, 4), 16) : null;
    const b = hexColor ? parseInt(hexColor.slice(4, 6), 16) : null;
    const dim = brightness ?? 100;

    const params: WizPilotParams = { state: true, dimming: dim };
    if (hexColor) {
      params.r = r!; params.g = g!; params.b = b!; params.w = 0; params.c = 0;
    }

    const desc = hexColor
      ? `${dim}% brightness  ·  rgb(${r}, ${g}, ${b})`
      : `${dim}% brightness`;

    MODES.custom = {
      title: hexColor ? `# ${hexColor.toUpperCase()}` : `${dim} %`,
      params,
      desc,
      verify: (s) => s.state === true,
      tagline: "looking good",
    };
    return { modeName: "custom", hexColor, brightness };
  }

  if (modeName && brightness !== null) {
    MODES[modeName] = {
      ...MODES[modeName],
      params: { ...MODES[modeName].params, dimming: brightness },
      desc: MODES[modeName].desc.replace(/\d+% brightness/, `${brightness}% brightness`),
    };
  }

  return { modeName, hexColor, brightness };
}

// -- terminal --

const cols = process.stdout.columns || 60;
const W = Math.min(cols - 4, 62);
const H = 14;
const hide = "\x1b[?25l";
const show = "\x1b[?25h";
const up = (n: number) => `\x1b[${n}A`;
const clr = "\x1b[2K";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const rgb = (r: number, g: number, b: number, s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;

// -- SDF toolkit --

const ramp = " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@";
const RL = ramp.length;
const A = 2.0;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function sdCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = (px - cx) * A, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function sdBox(px: number, py: number, cx: number, cy: number, hw: number, hh: number): number {
  const dx = Math.abs((px - cx) * A) - hw;
  const dy = Math.abs(py - cy) - hh;
  return Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0);
}

function hash(x: number, y: number): number {
  let h = (x * 73856093) ^ (y * 19349663);
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  return ((h >> 16) ^ h) & 0x7fffffff;
}

function noise(x: number, y: number): number {
  return (hash(Math.floor(x * 1000), Math.floor(y * 1000)) % 1000) / 1000;
}

function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const n00 = noise(ix, iy), n10 = noise(ix + 1, iy);
  const n01 = noise(ix, iy + 1), n11 = noise(ix + 1, iy + 1);
  return n00 * (1 - sx) * (1 - sy) + n10 * sx * (1 - sy) + n01 * (1 - sx) * sy + n11 * sx * sy;
}

function sat(v: number): number { return Math.max(0, Math.min(1, v)); }
function charFor(v: number): string { return ramp[Math.floor(sat(v) * (RL - 1))]; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// -- particles (shared pool) --

const particles: Particle[] = Array.from({ length: 18 }, (_, i) => ({
  phase: i * 0.7,
  speed: 0.3 + (hash(i, 42) % 100) / 150,
  drift: (hash(i, 77) % 100) / 100 - 0.5,
  size: 0.01 + (hash(i, 99) % 100) / 3000,
}));

// ============================================================
//  SHADER FACTORY
// ============================================================

function createShaders(currentMode: Mode): Record<string, Shader> {
  return {
    movie: {
      render(t: number, w: number, h: number): string[] {
        const lines: string[] = [];

        const pEmber    = smoothstep(0.0, 1.2, t);
        const pIgnite   = smoothstep(1.0, 2.0, t);
        const pBeamGrow = smoothstep(1.8, 4.0, t);
        const pScreen   = smoothstep(3.5, 5.0, t);
        const pDust     = smoothstep(3.0, 5.5, t);
        const pFilm     = smoothstep(4.5, 6.5, t);
        const pSettle   = smoothstep(6.0, 8.0, t);
        const pBulb     = smoothstep(5.0, 7.0, t);

        const ox = -0.42, oy = 0.42;
        const bx = 0.42, by = -0.92;
        const bLen = Math.sqrt(bx * bx + by * by);
        const bnx = bx / bLen, bny = by / bLen;

        for (let y = 0; y < h; y++) {
          let row = "";
          for (let x = 0; x < w; x++) {
            const u = x / w - 0.5, v = y / h - 0.5;
            let val = 0;

            const emberDist = sdCircle(u, v, ox, oy, 0.015);
            const emberThrob = 0.7 + 0.3 * Math.sin(t * 8);
            const ember = smoothstep(0.04, -0.02, emberDist) * pEmber * emberThrob;
            const emberHalo = smoothstep(0.12, -0.01, emberDist) * pEmber * 0.2;

            const toU = u - ox, toV = v - oy;
            const along = toU * bnx + toV * bny;
            const perpU = toU - bnx * along, perpV = toV - bny * along;
            const perp = Math.sqrt(perpU * perpU + perpV * perpV);

            const beamReach = pIgnite * 0.3 + pBeamGrow * 0.75;
            const reachMask = smoothstep(beamReach + 0.02, beamReach - 0.05, along)
              * smoothstep(-0.02, 0.04, along);

            const thinness = lerp(0.005, 0.04, pBeamGrow);
            const spread = thinness + Math.max(0, along) * lerp(0.02, 0.35, pBeamGrow);
            const beamEdge = smoothstep(spread, spread * 0.2, perp);

            const beamCore = smoothstep(spread * 0.3, 0, perp) * 0.3;
            const beam = (beamEdge * 0.55 + beamCore) * reachMask * pIgnite;

            const lampFlicker = lerp(
              0.6 + 0.4 * Math.sin(t * 15) * Math.sin(t * 23),
              0.95 + 0.05 * Math.sin(t * 7),
              pSettle
            );

            let dust = 0;
            if (pDust > 0.01) {
              for (const p of particles) {
                const pt = t * p.speed + p.phase;
                const prog = (pt % 1.4) / 1.4;
                const px = ox + bx * prog + Math.sin(pt * 1.7) * p.drift * 0.12;
                const py = oy + by * prog + Math.cos(pt * 2.3) * 0.04;
                const dd = sdCircle(u, v, px, py, p.size);
                dust += smoothstep(0.025, -0.005, dd) * 0.3;
              }
              dust *= pDust * beam;
            }

            const screenW = 0.28, screenH = 0.065;
            const screenCy = -0.38;
            const sDist = sdBox(u, v, 0, screenCy, screenW, screenH);

            const irisR = pScreen * 0.45;
            const irisDist = sdCircle(u, v, 0, screenCy, irisR);
            const irisMask = smoothstep(0.02, -0.01, irisDist);

            const sEdge = smoothstep(0.008, -0.004, sDist);
            const sGlow = smoothstep(0.1, -0.01, sDist) * 0.4;
            const screen = sEdge * irisMask * pScreen;
            const screenGlow = sGlow * pScreen * 0.5;

            const sFlk = lerp(1.0,
              0.7 + 0.3 * (Math.sin(t * 7.3) * 0.5 + 0.5) * (Math.sin(t * 11.1) * 0.3 + 0.7),
              pFilm);
            const filmBand = (Math.sin((u + t * 0.15) * 25) * 0.15
              + Math.sin((v + t * 0.08) * 40) * 0.1) * pFilm;

            const bp = 0.5 + 0.5 * Math.sin(t * 2.2);
            const bDist = sdCircle(u, v, 0, 0.48, 0.018 + bp * 0.006);
            const bulbGlow = smoothstep(0.12, -0.01, bDist) * (0.2 + bp * 0.1) * pBulb;
            const bulbCore = smoothstep(0.008, -0.008, bDist) * 0.5 * pBulb;
            const bulbLight = Math.max(0, 1 - sdCircle(u, v, 0, 0.48, 0) / 0.45)
              * 0.1 * (0.8 + bp * 0.2) * pBulb;

            const scan = (Math.sin(v * h * 6.28 + t * 4) * 0.5 + 0.5) * 0.05 * pFilm;
            const grain = (noise(u + t * 0.1, v + t * 0.07) - 0.5) * 0.07 * pFilm;

            val += ember + emberHalo;
            val += beam * lampFlicker;
            val += dust;
            val += screen * 0.7 * (sFlk + filmBand);
            val += screenGlow * sFlk;
            val += bulbGlow + bulbCore + bulbLight;
            val += scan * beam;
            val += grain * Math.max(beam, screen * 0.5);

            row += charFor(Math.pow(sat(val), 0.85));
          }
          lines.push(row);
        }
        return lines;
      },
      color(x: number, y: number, ch: string, w: number, h: number): RGB {
        const i = ramp.indexOf(ch) / RL;
        const u = x / w, v = y / h;
        if (v < 0.15 && u > 0.2 && u < 0.8 && i > 0.1)
          return [140 + i * 115 | 0, 150 + i * 105 | 0, 180 + i * 75 | 0];
        if (v > 0.75 && u < 0.2)
          return [200 + i * 55 | 0, 160 + i * 60 | 0, 80 + i * 40 | 0];
        if (v > 0.8 && u > 0.35 && u < 0.65)
          return [160 + i * 95 | 0, 100 + i * 70 | 0, 20 + i * 30 | 0];
        if (i > 0.03)
          return [110 + i * 145 | 0, 85 + i * 105 | 0, 40 + i * 55 | 0];
        return [70 + i * 100 | 0, 60 + i * 80 | 0, 35 + i * 50 | 0];
      },
      successColor(ch: string): RGB {
        const i = ramp.indexOf(ch) / RL;
        return [180 + i * 75 | 0, 110 + i * 80 | 0, 20 + i * 40 | 0];
      },
      headerColor: [208, 140, 40],
      titleColor: [255, 200, 60],
    },

    chill: {
      render(t: number, w: number, h: number): string[] {
        const lines: string[] = [];
        for (let y = 0; y < h; y++) {
          let row = "";
          for (let x = 0; x < w; x++) {
            const u = x / w - 0.5, v = y / h - 0.5;

            const b1x = Math.sin(t * 0.4) * 0.2, b1y = Math.cos(t * 0.35) * 0.25;
            const b2x = Math.cos(t * 0.3 + 2) * 0.25, b2y = Math.sin(t * 0.45 + 1) * 0.2;
            const b3x = Math.sin(t * 0.5 + 4) * 0.15, b3y = Math.cos(t * 0.25 + 3) * 0.3;

            const d1 = sdCircle(u, v, b1x, b1y, 0.12 + Math.sin(t * 0.7) * 0.03);
            const d2 = sdCircle(u, v, b2x, b2y, 0.1 + Math.cos(t * 0.6) * 0.02);
            const d3 = sdCircle(u, v, b3x, b3y, 0.08 + Math.sin(t * 0.8 + 2) * 0.025);

            const k = 0.15;
            const h1 = sat(0.5 + 0.5 * (d2 - d1) / k);
            const m12 = d1 * h1 + d2 * (1 - h1) - k * h1 * (1 - h1);
            const h2 = sat(0.5 + 0.5 * (d3 - m12) / k);
            const merged = m12 * h2 + d3 * (1 - h2) - k * h2 * (1 - h2);

            const blobVal = smoothstep(0.06, -0.04, merged);
            const blobEdge = smoothstep(0.02, -0.01, merged) * 0.3;

            const warmth = smoothstep(0.5, -0.3, v) * 0.2;

            const wave = (Math.sin(u * 8 + t * 0.8 + v * 4) * 0.5 + 0.5)
              * (Math.cos(v * 6 - t * 0.5) * 0.5 + 0.5) * 0.15;

            const flicker = vnoise(u * 3 + t * 0.5, v * 3 + t * 0.3) * 0.12;

            const dist = Math.sqrt(u * u * 4 + v * v * 4);
            const vignette = smoothstep(0.9, 0.3, dist);

            let val = (blobVal * 0.6 + blobEdge + warmth + wave + flicker) * vignette;
            row += charFor(Math.pow(sat(val), 0.75));
          }
          lines.push(row);
        }
        return lines;
      },
      color(x: number, y: number, ch: string, w: number, h: number): RGB {
        const i = ramp.indexOf(ch) / RL;
        const v = y / h;
        const r = lerp(160, 220, i) + v * -20 | 0;
        const g = lerp(80, 140, i) + v * -30 | 0;
        const b = lerp(50, 80, i) + v * -20 | 0;
        return [sat(r / 255) * 255 | 0, sat(g / 255) * 255 | 0, sat(b / 255) * 255 | 0];
      },
      successColor(ch: string): RGB {
        const i = ramp.indexOf(ch) / RL;
        return [180 + i * 60 | 0, 120 + i * 50 | 0, 50 + i * 30 | 0];
      },
      headerColor: [210, 130, 70],
      titleColor: [255, 180, 100],
    },

    day: {
      render(t: number, w: number, h: number): string[] {
        const lines: string[] = [];
        for (let y = 0; y < h; y++) {
          let row = "";
          for (let x = 0; x < w; x++) {
            const u = x / w - 0.5, v = y / h - 0.5;

            const sunY = 0.25 - Math.sin(t * 0.3) * 0.05;
            const sunDist = sdCircle(u, v, 0, sunY, 0.12);
            const sunCore = smoothstep(0.01, -0.03, sunDist);
            const sunGlow = smoothstep(0.25, -0.02, sunDist) * 0.5;

            const angle = Math.atan2(v - sunY, u * A);
            const rayCount = 12;
            const rayAngle = ((angle / (2 * Math.PI)) * rayCount + t * 0.3) % 1;
            const rayPattern = (Math.sin(rayAngle * Math.PI * 2) * 0.5 + 0.5);
            const rayDist = Math.sqrt((u * A) ** 2 + (v - sunY) ** 2);
            const rays = rayPattern * smoothstep(0.5, 0.08, rayDist) * smoothstep(0.04, 0.15, rayDist) * 0.35;

            const sky = smoothstep(0.5, -0.4, v) * 0.18;

            const cloud1x = u + t * 0.06;
            const cloud1 = smoothstep(0.55, 0.65, vnoise(cloud1x * 3, v * 6))
              * smoothstep(0.3, -0.1, v) * 0.25;
            const cloud2x = u - t * 0.04 + 0.5;
            const cloud2 = smoothstep(0.52, 0.62, vnoise(cloud2x * 4 + 10, v * 5 + 10))
              * smoothstep(0.35, -0.15, v) * 0.2;

            const horizon = smoothstep(0.04, 0.0, Math.abs(v - 0.3))
              * (0.15 + Math.sin(u * 20 + t * 2) * 0.05);

            const scatter = Math.max(0, 1 - rayDist / 0.6) * 0.08;

            let val = sunCore + sunGlow + rays + sky + cloud1 + cloud2 + horizon + scatter;
            row += charFor(Math.pow(sat(val), 0.7));
          }
          lines.push(row);
        }
        return lines;
      },
      color(x: number, y: number, ch: string, w: number, h: number): RGB {
        const i = ramp.indexOf(ch) / RL;
        const u = x / w - 0.5, v = y / h - 0.5;
        const sunDist = Math.sqrt(u * u * 4 + (v - 0.25) ** 2);

        const blend = smoothstep(0.1, 0.4, sunDist);
        const r = lerp(255, 100 + i * 80, blend) | 0;
        const g = lerp(220, 150 + i * 60, blend) | 0;
        const b = lerp(80, 190 + i * 65, blend) | 0;
        return [sat(r / 255) * 255 | 0, sat(g / 255) * 255 | 0, sat(b / 255) * 255 | 0];
      },
      successColor(ch: string): RGB {
        const i = ramp.indexOf(ch) / RL;
        return [200 + i * 55 | 0, 180 + i * 50 | 0, 80 + i * 60 | 0];
      },
      headerColor: [100, 170, 230],
      titleColor: [255, 230, 120],
    },

    custom: {
      render(t: number, w: number, h: number): string[] {
        const p = currentMode.params;
        const cr = p.r ?? 255, cg = p.g ?? 200, cb = p.b ?? 100;
        const lines: string[] = [];
        for (let y = 0; y < h; y++) {
          let row = "";
          for (let x = 0; x < w; x++) {
            const u = x / w - 0.5, v = y / h - 0.5;

            const swatchDist = sdBox(u, v, 0, 0, 0.3, 0.25);
            const swatch = smoothstep(0.02, -0.01, swatchDist);
            const swatchEdge = smoothstep(0.04, 0.01, swatchDist) * smoothstep(-0.01, 0.01, swatchDist);

            const breathe = Math.sin(t * 1.5) * 0.06 + 0.94;
            const inner = swatch * breathe;

            const rippleD = Math.max(0, swatchDist);
            const ripple1 = smoothstep(0.01, 0.0, Math.abs(rippleD - ((t * 0.15) % 0.4))) * 0.2;
            const ripple2 = smoothstep(0.01, 0.0, Math.abs(rippleD - ((t * 0.15 + 0.2) % 0.4))) * 0.15;

            const glow = smoothstep(0.4, -0.05, swatchDist) * 0.15;

            const shimmer = swatch * (Math.sin((u + v) * 30 + t * 3) * 0.04 + 0.04);

            let val = inner * 0.7 + swatchEdge * 0.3 + ripple1 + ripple2 + glow + shimmer;
            row += charFor(Math.pow(sat(val), 0.8));
          }
          lines.push(row);
        }
        return lines;
      },
      color(x: number, y: number, ch: string, w: number, h: number): RGB {
        const i = ramp.indexOf(ch) / RL;
        const p = currentMode.params;
        const cr = p.r ?? 255, cg = p.g ?? 200, cb = p.b ?? 100;
        const u = x / w - 0.5, v = y / h - 0.5;
        const dist = Math.sqrt(u * u * 4 + v * v * 4);
        const blend = smoothstep(0.3, 0.8, dist);
        return [
          lerp(cr * 0.5 + i * cr * 0.5, 80 + i * 60, blend) | 0,
          lerp(cg * 0.5 + i * cg * 0.5, 70 + i * 50, blend) | 0,
          lerp(cb * 0.5 + i * cb * 0.5, 60 + i * 40, blend) | 0,
        ].map(v => Math.min(255, Math.max(0, v))) as RGB;
      },
      successColor(ch: string): RGB {
        const i = ramp.indexOf(ch) / RL;
        const p = currentMode.params;
        const cr = p.r ?? 255, cg = p.g ?? 200, cb = p.b ?? 100;
        return [
          (cr * 0.4 + i * cr * 0.6) | 0,
          (cg * 0.4 + i * cg * 0.6) | 0,
          (cb * 0.4 + i * cb * 0.6) | 0,
        ].map(v => Math.min(255, Math.max(0, v))) as RGB;
      },
      get headerColor(): RGB {
        const p = currentMode.params;
        return [p.r ?? 200, p.g ?? 160, p.b ?? 100].map(v => Math.floor(v * 0.6)) as RGB;
      },
      get titleColor(): RGB {
        const p = currentMode.params;
        return [p.r ?? 255, p.g ?? 200, p.b ?? 120] as RGB;
      },
    },
  };
}

// -- shared success frame --

function successFrame(t: number, w: number, h: number): string[] {
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const u = x / w - 0.5, v = y / h - 0.5;
      const breathe = Math.sin(t * 1.8) * 0.08;
      const orbDist = sdCircle(u, v, 0, 0, 0.18 + breathe);
      const core = smoothstep(0.02, -0.04, orbDist);
      const glow = smoothstep(0.2, -0.02, orbDist) * 0.6;
      const ring1 = smoothstep(0.015, 0.0, Math.abs(orbDist + 0.05 + Math.sin(t * 3) * 0.01)) * 0.3;
      const ring2 = smoothstep(0.015, 0.0, Math.abs(orbDist + 0.12 + Math.sin(t * 2.5 + 1) * 0.015)) * 0.2;
      const angle = Math.atan2(v, u * A);
      const rays = (Math.sin(angle * 6 + t * 1.2) * 0.5 + 0.5) * smoothstep(0.35, 0.05, -orbDist) * 0.25;
      const shimmer = (noise(u + t * 0.05, v - t * 0.03) - 0.5) * 0.06 * glow;
      let val = core + glow + ring1 + ring2 + rays + shimmer;
      row += charFor(Math.pow(sat(val), 0.8));
    }
    lines.push(row);
  }
  return lines;
}

// -- renderer --

class Renderer {
  private shader: Shader;
  private modeTitle: string;
  started = false;
  interval: ReturnType<typeof setInterval> | null = null;
  t = 0;
  statusLines: string[] = [];

  constructor(shader: Shader, modeTitle: string) {
    this.shader = shader;
    this.modeTitle = modeTitle;
  }

  start() {
    process.stdout.write(hide);
    const title = `  ${this.modeTitle}  `;
    const pad = Math.max(0, Math.floor((W - title.length) / 2));
    const [hr, hg, hb] = this.shader.headerColor;
    const [tr, tg, tb] = this.shader.titleColor;
    process.stdout.write("\n");
    process.stdout.write(`  ${rgb(hr, hg, hb, "~".repeat(W))}\n`);
    process.stdout.write(`  ${" ".repeat(pad)}${bold(rgb(tr, tg, tb, title))}\n`);
    process.stdout.write(`  ${rgb(hr, hg, hb, "~".repeat(W))}\n`);
    process.stdout.write("\n");
    this.statusLines = [];
    this._drawShader();
    this._drawStatus();
    this.started = true;
    this.interval = setInterval(() => { this.t += 0.08; this._redraw(); }, 50);
  }

  _drawShader() {
    const lines = this.shader.render(this.t, W, H);
    for (let y = 0; y < lines.length; y++) {
      let out = "";
      for (let x = 0; x < lines[y].length; x++) {
        const ch = lines[y][x];
        if (ch === " " || ch === "`") { out += ch; continue; }
        const [r, g, b] = this.shader.color(x, y, ch, W, H);
        out += `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
      }
      process.stdout.write(`  ${out}\n`);
    }
  }

  _drawStatus() {
    process.stdout.write("\n");
    for (const line of this.statusLines) process.stdout.write(`${clr}  ${line}\n`);
    for (let i = this.statusLines.length; i < 4; i++) process.stdout.write(`${clr}\n`);
  }

  _redraw() {
    process.stdout.write(up(H + 6));
    this._drawShader();
    this._drawStatus();
  }

  setStatus(lines: string[]) { this.statusLines = lines; if (this.started) this._redraw(); }

  async finish(success: boolean) {
    if (this.interval) clearInterval(this.interval);
    if (success) {
      for (let i = 0; i < 30; i++) {
        this.t += 0.1;
        process.stdout.write(up(H + 6));
        const lines = successFrame(this.t, W, H);
        for (let y = 0; y < lines.length; y++) {
          let out = "";
          for (let x = 0; x < lines[y].length; x++) {
            const ch = lines[y][x];
            if (ch === " " || ch === "`") { out += ch; continue; }
            const [r, g, b] = this.shader.successColor(ch);
            out += `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
          }
          process.stdout.write(`  ${out}\n`);
        }
        this._drawStatus();
        await sleep(45);
      }
    }
    process.stdout.write(show);
  }

  stop() { if (this.interval) clearInterval(this.interval); process.stdout.write(show); }
}

// -- helpers --

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function formatMac(mac: string): string {
  const clean = mac.replace(/[^0-9a-fA-F]/g, "");
  return clean.match(/.{2}/g)?.join(":") ?? mac;
}

function describeState(pilot: WizPilotState | null): string {
  if (!pilot) return "unknown";
  if (!pilot.state) return "off";
  const parts = ["on"];
  if (pilot.dimming != null) parts.push(`${pilot.dimming}%`);
  if (pilot.temp) parts.push(`${pilot.temp}K`);
  else if (pilot.r != null && pilot.g != null && pilot.b != null) parts.push(`rgb(${pilot.r},${pilot.g},${pilot.b})`);
  return parts.join(" ");
}

function saveEnv(entries: Record<string, string>): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(__envPath, "utf-8").split("\n");
  } catch {}

  const updated = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      if (key in entries) {
        lines[i] = `${key}=${entries[key]}`;
        updated.add(key);
      }
    }
  }

  for (const [key, val] of Object.entries(entries)) {
    if (!updated.has(key)) lines.push(`${key}=${val}`);
  }

  const content = lines.filter((l, i) => i < lines.length - 1 || l.trim() !== "").join("\n");
  writeFileSync(__envPath, content.endsWith("\n") ? content : content + "\n");
}

function promptInput(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      resolve(chunk.trim());
    });
  });
}

// -- network --

function getBroadcastAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal && a.netmask) {
        const ip = a.address.split(".").map(Number);
        const mask = a.netmask.split(".").map(Number);
        return ip.map((o, i) => o | (~mask[i] & 255)).join(".");
      }
    }
  }
  return null;
}

function send(ip: string, payload: object, timeout = COMMAND_TIMEOUT_MS): Promise<WizResponse> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const msg = Buffer.from(JSON.stringify(payload));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; sock.close(); reject(new Error("timeout")); } }, timeout);
    sock.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); sock.close(); reject(e); } });
    sock.on("message", (data) => {
      if (!done) {
        done = true; clearTimeout(timer); sock.close();
        try { resolve(JSON.parse(data.toString())); }
        catch { reject(new Error(`malformed response: ${data.toString().slice(0, 80)}`)); }
      }
    });
    sock.send(msg, WIZ_PORT, ip, (e) => { if (e && !done) { done = true; clearTimeout(timer); sock.close(); reject(e); } });
  });
}

function discoverByBroadcast(mac: string, broadcastAddr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    let done = false;
    const msg = Buffer.from(JSON.stringify({
      method: "registration", params: { phoneMac: "AAAAAAAAAAAA", register: false, phoneIp: "0.0.0.0", id: "1" },
    }));
    const timer = setTimeout(() => { if (!done) { done = true; sock.close(); reject(new Error("broadcast timeout")); } }, DISCOVERY_TIMEOUT_MS);
    sock.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); sock.close(); reject(e); } });
    sock.on("message", (data: Buffer, rinfo: RemoteInfo) => {
      if (done) return;
      try {
        const resp = JSON.parse(data.toString());
        if (resp.result?.mac === mac) { done = true; clearTimeout(timer); sock.close(); resolve(rinfo.address); }
      } catch {}
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(msg, WIZ_PORT, broadcastAddr);
      setTimeout(() => { if (!done) sock.send(msg, WIZ_PORT, broadcastAddr); }, 1000);
    });
  });
}

function probeIP(ip: string, mac: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    let done = false;
    const msg = Buffer.from(JSON.stringify({ method: "getSystemConfig", params: {} }));
    const timer = setTimeout(() => { if (!done) { done = true; sock.close(); reject(new Error("timeout")); } }, SUBNET_SCAN_TIMEOUT_MS);
    sock.on("error", () => { if (!done) { done = true; clearTimeout(timer); sock.close(); reject(new Error("error")); } });
    sock.on("message", (data) => {
      if (done) return;
      done = true; clearTimeout(timer); sock.close();
      try { const r = JSON.parse(data.toString()); r.result?.mac === mac ? resolve(ip) : reject(new Error("wrong mac")); }
      catch { reject(new Error("parse")); }
    });
    sock.send(msg, WIZ_PORT, ip);
  });
}

type ProgressCallback = (a1: string | number, a2?: number) => void;

async function discoverBySubnetScan(mac: string, onProgress?: ProgressCallback): Promise<string> {
  const base = (() => {
    for (const addrs of Object.values(networkInterfaces())) {
      if (!addrs) continue;
      for (const a of addrs) { if (a.family === "IPv4" && !a.internal) return a.address.split(".").slice(0, 3).join("."); }
    }
    return null;
  })();
  if (!base) throw new Error("no network");
  const batch = SUBNET_BATCH_SIZE;
  for (let s = 1; s < 255; s += batch) {
    if (onProgress) onProgress(s, 254);
    const probes: Promise<string | null>[] = [];
    for (let i = s; i < Math.min(s + batch, 255); i++) probes.push(probeIP(`${base}.${i}`, mac).catch(() => null));
    const found = (await Promise.all(probes)).find(Boolean);
    if (found) return found;
  }
  throw new Error("not found");
}

async function discoverByMac(mac: string, broadcastAddr: string, onProgress?: ProgressCallback): Promise<{ ip: string; usedSubnetScan: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let failures = 0;

    const finish = (ip: string, usedSubnetScan: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ip, usedSubnetScan });
    };

    const fail = () => {
      failures++;
      if (failures >= 2) reject(new Error("not found"));
    };

    discoverByBroadcast(mac, broadcastAddr).then(ip => finish(ip, false)).catch(fail);

    setTimeout(() => {
      if (settled) return;
      if (onProgress) onProgress("scanning subnet...");
      discoverBySubnetScan(mac, onProgress).then(ip => finish(ip, true)).catch(fail);
    }, 500);
  });
}

async function sendWithRetry(ip: string, payload: object, retries = MAX_RETRIES): Promise<WizResponse> {
  let lastErr: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try { return await send(ip, payload); }
    catch (e) { lastErr = e as Error; if (i < retries - 1) await sleep(RETRY_DELAY_MS); }
  }
  throw lastErr;
}

// -- network: discover-all primitives --

function probeAny(ip: string): Promise<{ ip: string; mac: string } | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let done = false;
    const msg = Buffer.from(JSON.stringify({ method: "getSystemConfig", params: {} }));
    const timer = setTimeout(() => { if (!done) { done = true; sock.close(); resolve(null); } }, SUBNET_SCAN_TIMEOUT_MS);
    sock.on("error", () => { if (!done) { done = true; clearTimeout(timer); sock.close(); resolve(null); } });
    sock.on("message", (data) => {
      if (done) return;
      done = true; clearTimeout(timer); sock.close();
      try {
        const r = JSON.parse(data.toString());
        if (r.result?.mac) resolve({ ip, mac: r.result.mac });
        else resolve(null);
      } catch { resolve(null); }
    });
    sock.send(msg, WIZ_PORT, ip);
  });
}

function discoverAll(broadcastAddr: string, timeout = DISCOVERY_TIMEOUT_MS): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const found = new Map<string, string>();
    const sock = createSocket("udp4");
    const msg = Buffer.from(JSON.stringify({
      method: "registration", params: { phoneMac: "AAAAAAAAAAAA", register: false, phoneIp: "0.0.0.0", id: "1" },
    }));

    const timer = setTimeout(() => { sock.close(); resolve(found); }, timeout);

    sock.on("error", () => { clearTimeout(timer); sock.close(); resolve(found); });
    sock.on("message", (data: Buffer, rinfo: RemoteInfo) => {
      try {
        const resp = JSON.parse(data.toString());
        if (resp.result?.mac) found.set(resp.result.mac, rinfo.address);
      } catch {}
    });

    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(msg, WIZ_PORT, broadcastAddr);
      setTimeout(() => { try { sock.send(msg, WIZ_PORT, broadcastAddr); } catch {} }, 1000);
      setTimeout(() => { try { sock.send(msg, WIZ_PORT, broadcastAddr); } catch {} }, 2000);
    });
  });
}

async function discoverAllSubnetScan(onProgress?: ProgressCallback): Promise<Map<string, string>> {
  const base = (() => {
    for (const addrs of Object.values(networkInterfaces())) {
      if (!addrs) continue;
      for (const a of addrs) {
        if (a.family === "IPv4" && !a.internal) return a.address.split(".").slice(0, 3).join(".");
      }
    }
    return null;
  })();
  if (!base) return new Map();

  const found = new Map<string, string>();
  const batch = SUBNET_BATCH_SIZE;
  for (let s = 1; s < 255; s += batch) {
    if (onProgress) onProgress(s, 254);
    const probes: Promise<void>[] = [];
    for (let i = s; i < Math.min(s + batch, 255); i++) {
      probes.push(
        probeAny(`${base}.${i}`).then((r) => { if (r) found.set(r.mac, r.ip); })
      );
    }
    await Promise.all(probes);
  }
  return found;
}

function getSystemConfig(ip: string): Promise<{ moduleName: string; fwVersion: string } | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let done = false;
    const msg = Buffer.from(JSON.stringify({ method: "getSystemConfig", params: {} }));
    const timer = setTimeout(() => { if (!done) { done = true; sock.close(); resolve(null); } }, COMMAND_TIMEOUT_MS);
    sock.on("error", () => { if (!done) { done = true; clearTimeout(timer); sock.close(); resolve(null); } });
    sock.on("message", (data) => {
      if (done) return;
      done = true; clearTimeout(timer); sock.close();
      try {
        const r = JSON.parse(data.toString());
        resolve({ moduleName: r.result?.moduleName ?? "unknown", fwVersion: r.result?.fwVersion ?? "?" });
      } catch { resolve(null); }
    });
    sock.send(msg, WIZ_PORT, ip);
  });
}

// -- guards --

function requireMac(): string {
  const mac = process.env.WIZ_MAC;
  if (!mac || mac === "your_bulb_mac_here") {
    console.error(red("  no bulb configured"));
    console.error(dim("  run: wiz discover"));
    process.exit(1);
  }
  return mac;
}

interface RequireBulbIpOpts {
  onStatus?: (lines: string[]) => void;
}

async function requireBulbIp(mac: string, opts?: RequireBulbIpOpts): Promise<string> {
  const onStatus = opts?.onStatus;
  const macFmt = formatMac(mac);

  const cachedIp = process.env.WIZ_IP;
  if (cachedIp) {
    try {
      const resp = await send(cachedIp, { method: "getPilot", params: {} }, 500);
      if (resp.result?.mac === mac) return cachedIp;
    } catch {}
  }

  const broadcastAddr = getBroadcastAddress();
  if (!broadcastAddr) {
    if (onStatus) throw new Error("no network interface found");
    console.error(red("  no network interface found"));
    process.exit(1);
  }

  const skipBroadcast = process.env.WIZ_SKIP_BROADCAST === "1";
  let ip: string;
  let usedSubnetScan = false;

  try {
    if (skipBroadcast) {
      if (onStatus) onStatus([dim("scanning subnet..."), dim(`target ${macFmt}`)]);
      ip = await discoverBySubnetScan(mac, (a1, a2) => {
        if (typeof a1 === "number" && a2 && onStatus) {
          onStatus([dim(`scanning subnet... ${(a1 / a2 * 100) | 0}%`), dim(`target ${macFmt}`)]);
        }
      });
      usedSubnetScan = true;
    } else {
      if (onStatus) onStatus([dim("scanning network..."), dim(`broadcast ${broadcastAddr}  target ${macFmt}`)]);
      const result = await discoverByMac(mac, broadcastAddr, (a1, a2) => {
        if (onStatus) {
          if (typeof a1 === "string") onStatus([dim(a1), dim(`target ${macFmt}`)]);
          else if (typeof a1 === "number" && a2) onStatus([dim(`scanning subnet... ${(a1 / a2 * 100) | 0}%`), dim(`target ${macFmt}`)]);
        }
      });
      ip = result.ip;
      usedSubnetScan = result.usedSubnetScan;
    }
  } catch {
    if (onStatus) throw new Error("bulb not found on network");
    console.error(red("  bulb not found on network"));
    console.error(dim(`  mac ${macFmt}`));
    process.exit(1);
  }

  const updates: Record<string, string> = {};
  if (ip !== cachedIp) updates.WIZ_IP = ip;
  if (usedSubnetScan && !skipBroadcast) updates.WIZ_SKIP_BROADCAST = "1";
  if (Object.keys(updates).length > 0) {
    saveEnv(updates);
    if (updates.WIZ_IP) process.env.WIZ_IP = ip;
    if (updates.WIZ_SKIP_BROADCAST) process.env.WIZ_SKIP_BROADCAST = "1";
  }

  return ip;
}

// -- commands --

async function cmdDiscover() {
  process.stdout.write(`\n  ${dim("scanning network...")}\n`);

  const broadcastAddr = getBroadcastAddress();
  if (!broadcastAddr) {
    console.error(red("  no network interface found"));
    console.error(dim("  check that wi-fi is connected"));
    process.exit(1);
  }

  let found = await discoverAll(broadcastAddr);

  if (found.size === 0) {
    process.stdout.write(`  ${dim("broadcast found nothing, scanning subnet...")}\n`);
    found = await discoverAllSubnetScan((a1, a2) => {
      if (typeof a1 === "number" && a2) {
        process.stdout.write(`\r  ${dim(`scanning subnet... ${(a1 / a2 * 100) | 0}%`)}`);
      }
    });
    if (found.size > 0) process.stdout.write("\n");
  }

  if (found.size === 0) {
    console.error(red("\n  no bulbs found on network"));
    console.error(dim("  are your wiz lights powered on? same wi-fi?"));
    process.exit(1);
  }

  const bulbs: DiscoveredBulb[] = [];
  for (const [mac, ip] of found) {
    const [cfg, pilot] = await Promise.all([
      getSystemConfig(ip),
      send(ip, { method: "getPilot", params: {} }).catch(() => null),
    ]);
    bulbs.push({
      ip,
      mac,
      moduleName: cfg?.moduleName ?? "unknown",
      firmware: cfg?.fwVersion ?? "?",
      state: (pilot?.result as WizPilotState) ?? null,
    });
  }

  bulbs.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  console.log();
  console.log(`  ${dim("#")}  ${dim("IP".padEnd(16))}${dim("MAC".padEnd(20))}${dim("Module".padEnd(20))}${dim("FW".padEnd(10))}${dim("State")}`);
  for (let i = 0; i < bulbs.length; i++) {
    const b = bulbs[i];
    const stateStr = describeState(b.state);
    console.log(`  ${String(i + 1).padStart(1)}  ${b.ip.padEnd(16)}${formatMac(b.mac).padEnd(20)}${b.moduleName.padEnd(20)}${b.firmware.padEnd(10)}${stateStr}`);
  }
  console.log();

  if (!process.stdin.isTTY) return;

  const currentMac = process.env.WIZ_MAC;
  let selection: number | null = null;

  if (bulbs.length === 1) {
    const answer = await promptInput(`  save as default? [Y/n]: `);
    if (answer.toLowerCase() === "n") return;
    selection = 0;
  } else {
    const answer = await promptInput(`  save as default? [1-${bulbs.length}, skip]: `);
    if (answer === "skip" || answer === "" || answer === "s") return;
    const n = parseInt(answer, 10);
    if (isNaN(n) || n < 1 || n > bulbs.length) {
      console.log(dim("  skipped"));
      return;
    }
    selection = n - 1;
  }

  const chosen = bulbs[selection];
  saveEnv({ WIZ_MAC: chosen.mac, WIZ_IP: chosen.ip, WIZ_SKIP_BROADCAST: "" });
  process.env.WIZ_MAC = chosen.mac;
  process.env.WIZ_IP = chosen.ip;
  delete process.env.WIZ_SKIP_BROADCAST;

  if (currentMac && currentMac !== chosen.mac && currentMac !== "your_bulb_mac_here") {
    console.log(dim(`  updated: ${formatMac(currentMac)} → ${formatMac(chosen.mac)}`));
  }
  console.log(green(`  saved — ${formatMac(chosen.mac)} at ${chosen.ip}`));
  console.log();
}

async function cmdOn() {
  const mac = requireMac();
  const ip = await requireBulbIp(mac);

  await sendWithRetry(ip, { method: "setPilot", params: { state: true } });

  let stateDesc = "";
  try {
    const resp = await send(ip, { method: "getPilot", params: {} });
    if (resp.result) stateDesc = ` — ${describeState(resp.result).replace(/^on /, "")}`;
  } catch {}

  console.log(`  light on${stateDesc}`);
}

async function cmdOff() {
  const mac = requireMac();
  const ip = await requireBulbIp(mac);

  await sendWithRetry(ip, { method: "setPilot", params: { state: false } });
  console.log(`  light off`);
}

async function cmdStatus() {
  const mac = requireMac();
  const ip = await requireBulbIp(mac);

  let resp: WizResponse;
  try {
    resp = await send(ip, { method: "getPilot", params: {} });
  } catch {
    console.error(red("  could not read bulb state"));
    process.exit(1);
  }

  const s = resp.result;
  if (!s) {
    console.error(red("  empty response from bulb"));
    process.exit(1);
  }

  console.log();
  console.log(`  power:      ${s.state ? "on" : "off"}`);
  if (s.state) {
    console.log(`  brightness: ${s.dimming ?? "?"}%`);
    if (s.temp) console.log(`  color temp: ${s.temp}K`);
    else if (s.r != null) console.log(`  color:      rgb(${s.r}, ${s.g}, ${s.b})`);
  }
  console.log();
}

async function cmdAnimatedPreset() {
  const mac = requireMac();

  const { modeName: arg } = parseArgs();
  const mode = arg ? MODES[arg] : null;

  if (!mode) {
    showHelp(1);
    return;
  }

  const shaders = createShaders(mode);
  const shader = shaders[arg!] || shaders.chill;

  const r = new Renderer(shader, mode.title);
  process.on("SIGINT", () => { r.stop(); process.exit(130); });
  process.on("SIGTERM", () => { r.stop(); process.exit(143); });

  r.start();

  const macFmt = formatMac(mac);
  let ip: string;
  try {
    ip = await requireBulbIp(mac, { onStatus: (lines) => r.setStatus(lines) });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "no network interface found") {
      r.setStatus([red("no network interface found"), "", dim("check that wi-fi is connected")]);
    } else {
      r.setStatus([red("bulb not found on network"), "", dim("is it powered on? same wi-fi?"), dim(`mac ${macFmt}`)]);
    }
    await sleep(2000); r.stop(); process.exit(1);
  }

  r.setStatus([green(`found bulb at ${ip}`), dim(`mac ${macFmt}`), dim(`setting ${arg} mode...`)]);

  let state: WizResponse | undefined;
  try { state = await sendWithRetry(ip, { method: "getPilot", params: {} }); }
  catch { r.setStatus([green(`found bulb at ${ip}`), yellow("could not read current state"), dim(`setting ${arg} mode...`)]); }

  let resp: WizResponse;
  try { resp = await sendWithRetry(ip, { method: "setPilot", params: mode.params }); }
  catch (e) {
    r.setStatus([green(`found bulb at ${ip}`), red(`failed: ${(e as Error).message}`), "", dim("try power-cycling the bulb")]);
    await sleep(2000); r.stop(); process.exit(1);
  }

  if (!resp.result?.success) {
    r.setStatus([green(`found bulb at ${ip}`), red("bulb rejected command"), dim(JSON.stringify(resp).slice(0, 60))]);
    await sleep(2000); r.stop(); process.exit(1);
  }

  let verified: boolean;
  try { const c = await sendWithRetry(ip, { method: "getPilot", params: {} }); verified = mode.verify(c.result as WizPilotState); }
  catch { verified = false; }

  const prev = state?.result;
  const prevDesc = prev
    ? dim(`was: ${prev.state ? "on" : "off"}, ${prev.dimming ?? "?"}%, ${prev.temp ?? [prev.r, prev.g, prev.b].join("/")}`)
    : "";

  r.setStatus([
    verified ? green(`${arg} mode active`) : yellow(`${arg} mode sent (unverified)`),
    dim(mode.desc), prevDesc, verified ? dim(mode.tagline) : "",
  ].filter(Boolean));

  await r.finish(true);
  process.exit(0);
}

// -- help --

function showHelp(exitCode: number): never {
  const c = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log(`\n  ${c("wiz")} — control your wiz light\n`);
  console.log(`  commands:`);
  console.log(`    ${c("wiz discover")}    ${d("scan network and pick your bulb")}`);
  console.log(`    ${c("wiz on")}          ${d("turn light on")}`);
  console.log(`    ${c("wiz off")}         ${d("turn light off")}`);
  console.log(`    ${c("wiz status")}      ${d("show current bulb state")}`);
  console.log();
  console.log(`  presets:`);
  console.log(`    ${c("wiz -movie")}      ${d("1% · 2200K  — pico projector darkness")}`);
  console.log(`    ${c("wiz -chill")}      ${d("40% · 2700K — warm evening ambiance")}`);
  console.log(`    ${c("wiz -day")}        ${d("100% · 5000K — bright daylight")}`);
  console.log();
  console.log(`  custom:`);
  console.log(`    ${c("wiz ff6b35")}      ${d("set color by hex")}`);
  console.log(`    ${c("wiz ff6b35 50")}   ${d("hex color at 50% brightness")}`);
  console.log(`    ${c("wiz -b 75")}       ${d("set brightness only (1-100)")}`);
  console.log(`    ${c("wiz -chill -b 60")}${d(" preset with brightness override")}`);
  console.log();
  process.exit(exitCode);
}

function showWelcome(): never {
  const c = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log(`\n  ${c("wiz")} — control your wiz light\n`);
  console.log(`  no bulb configured yet. run:\n`);
  console.log(`    ${c("wiz discover")}    ${d("scan network and pick your bulb")}`);
  console.log();
  process.exit(0);
}

// -- entry point --

const subcmd = process.argv[2]?.replace(/^-+/, "");

if (subcmd === "discover" || subcmd === "scan") {
  cmdDiscover();
} else if (subcmd === "off") {
  cmdOff();
} else if (subcmd === "on") {
  cmdOn();
} else if (subcmd === "status") {
  cmdStatus();
} else if (subcmd === "help" || subcmd === "h") {
  showHelp(0);
} else if (!process.argv[2] && (!envLoaded || !process.env.WIZ_MAC || process.env.WIZ_MAC === "your_bulb_mac_here")) {
  showWelcome();
} else {
  cmdAnimatedPreset();
}
