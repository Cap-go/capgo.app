// Generates the product images shown next to each plan in Stripe Checkout.
//
// Each plan is a 4-slot isometric "release stack": lit layers = the plan tier,
// unlit slots show what the next plan unlocks. No text in the image, since
// Stripe already renders the plan name and the thumbnail is ~48px.
//
// Usage: bun scripts/generate_stripe_plan_images.ts
// Output: assets/stripe-plans/<plan>.svg and <plan>.png (1024x1024, needs rsvg-convert)
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(import.meta.dirname, '..', 'assets', 'stripe-plans')
const SIZE = 1024
const SLOTS = 4
const HALF_W = 230
const HALF_H = 115
const DEPTH = 46
const GAP = 112
const BASE_Y = 668

const plans = [
  { name: 'solo', lit: 1, accent: false },
  { name: 'maker', lit: 2, accent: false },
  { name: 'team', lit: 3, accent: false },
  { name: 'enterprise', lit: 4, accent: true },
]

function layer(cy: number, state: 'lit' | 'top' | 'ghost', accent: boolean) {
  const cx = SIZE / 2
  const top = `${cx},${cy - HALF_H} ${cx + HALF_W},${cy} ${cx},${cy + HALF_H} ${cx - HALF_W},${cy}`
  const left = `${cx - HALF_W},${cy} ${cx},${cy + HALF_H} ${cx},${cy + HALF_H + DEPTH} ${cx - HALF_W},${cy + DEPTH}`
  const right = `${cx},${cy + HALF_H} ${cx + HALF_W},${cy} ${cx + HALF_W},${cy + DEPTH} ${cx},${cy + HALF_H + DEPTH}`
  if (state === 'ghost') {
    return `<g stroke="#8fd3ff" stroke-opacity="0.3" stroke-width="5" stroke-linejoin="round" stroke-dasharray="16 12">
    <polygon points="${left}" fill="#0b3350" fill-opacity="0.35"/>
    <polygon points="${right}" fill="#0b3350" fill-opacity="0.25"/>
    <polygon points="${top}" fill="#0b3350" fill-opacity="0.45"/>
  </g>`
  }
  const topFill = state === 'top' ? (accent ? 'url(#topAccent)' : 'url(#topLit)') : (accent ? 'url(#topBaseAccent)' : 'url(#topBase)')
  return `<g stroke-linejoin="round">
    <polygon points="${left}" fill="${accent ? '#0d8f9a' : '#0b7fd1'}"/>
    <polygon points="${right}" fill="${accent ? '#0a6f86' : '#0763a8'}"/>
    <polygon points="${top}" fill="${topFill}" stroke="#ffffff" stroke-opacity="${state === 'top' ? 0.55 : 0.25}" stroke-width="4"/>
  </g>`
}

function planSvg(lit: number, accent: boolean) {
  // Ghost slots are painted first so the lit top face stays fully visible.
  const ghosts: string[] = []
  const solids: string[] = []
  for (let i = 0; i < SLOTS; i++) {
    const cy = BASE_Y - i * GAP
    if (i >= lit)
      ghosts.unshift(layer(cy, 'ghost', accent))
    else
      solids.push(layer(cy, i === lit - 1 ? 'top' : 'lit', accent))
  }
  const layers = [...ghosts, ...solids]
  const glowY = BASE_Y - (lit - 1) * GAP
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0" stop-color="#06304d"/>
      <stop offset="1" stop-color="#001827"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${accent ? '#1FB2A5' : '#119eff'}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${accent ? '#1FB2A5' : '#119eff'}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topBase" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2aa8ff"/>
      <stop offset="1" stop-color="#119eff"/>
    </linearGradient>
    <linearGradient id="topBaseAccent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2ccdbd"/>
      <stop offset="1" stop-color="#14a0c8"/>
    </linearGradient>
    <linearGradient id="topLit" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8fd3ff"/>
      <stop offset="1" stop-color="#119eff"/>
    </linearGradient>
    <linearGradient id="topAccent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7ff0de"/>
      <stop offset="0.5" stop-color="#1FB2A5"/>
      <stop offset="1" stop-color="#119eff"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <ellipse cx="${SIZE / 2}" cy="${glowY}" rx="380" ry="260" fill="url(#glow)"/>
  ${layers.join('\n  ')}
</svg>
`
}

mkdirSync(OUT_DIR, { recursive: true })
for (const plan of plans) {
  const svgPath = join(OUT_DIR, `${plan.name}.svg`)
  writeFileSync(svgPath, planSvg(plan.lit, plan.accent))
  execFileSync('rsvg-convert', ['-w', String(SIZE), '-h', String(SIZE), svgPath, '-o', join(OUT_DIR, `${plan.name}.png`)])
  console.log(`wrote ${plan.name}`)
}
