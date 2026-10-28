---
name: evil-buttons
description: Design reference of 29 animated button components (Evil Buttons, React + Tailwind + motion). Use when designing or building a button, its states (loading/success/error, hold-to-confirm, copy, cooldown, toggle) or button motion, or when shen mentions evil-buttons or a component from it such as MorphStatusButton.
---

# Evil Buttons

Source: https://github.com/radiumcoders/evil-buttons (Apache-2.0, see `LICENSE.txt`), live demos at https://www.evilbuttons.com/docs/<slug>.
This folder holds an unchanged copy of every component (`components/*.tsx`) and its docs page with props and usage (`docs/*.mdx`). `components/_utils.ts` is upstream `lib/utils.ts` (the `cn` helper). Copied from commit 63b868e (2026-10-24).

## How to use it

1. Pick the closest component from the list below.
2. Read its `docs/<slug>.mdx` for props, variants and usage, then its `components/<file>.tsx` for the exact timing, easing, colors and DOM structure.
3. Build it in the target stack. In a shadcn/React project install it directly with `npx shadcn@latest add @evilbuttons/<name>`. In WAswitch (Electron, plain HTML/CSS/JS in `src/shell`, `src/float`, `src/popup`, no React or Tailwind) rebuild the idea in vanilla JS and CSS, do not add React, Tailwind or motion as dependencies.
4. In WAswitch the project UI design rules win over the upstream look (memory `waswitch-ui-design-rules`): Radix UI Colors only, 0.5px borders, minimal motion (ease-out 250ms), no flashy effects, min 12px text. Take the interaction pattern and state handling, drop glow, shaders, confetti and physics.

If the copy here looks stale, check upstream for new components: `git clone --depth 1 https://github.com/radiumcoders/evil-buttons` and read `registry.components.json`.

## Fits a work app (states and safety)

| Component | Component file | Docs | What it does |
| --- | --- | --- | --- |
| MorphStatusButton | `components/morph-status-button.tsx` | `docs/morph-status-button.mdx` | One button that morphs through idle, loading, success and error in place, no layout shift. Accepts an async onClick or a controlled `status`. |
| HoldButton | `components/hold-button.tsx` | `docs/hold-button.mdx` | Hold to confirm: inner fill grows 0 to 100%, release early to abort. |
| SlideToDetonate | `components/slide-to-detonate.tsx` | `docs/slide-to-detonate.mdx` | Slide-to-confirm gate before a destructive action. |
| CooldownButton | `components/cooldown-button.tsx` | `docs/cooldown-button.mdx` | Locks behind a draining radial timer after each click to stop double submits. |
| CopyButton | `components/copy-button.tsx` | `docs/copy-button.mdx` | Shows the copied text briefly above itself after copying. |
| RevealButton | `components/reveal-button.tsx` | `docs/reveal-button.mdx` | Reveals a hidden value (key, password) on hold or toggle, blur-in, eye icon. |
| CommandButton | `components/command-button.tsx` | `docs/command-button.mdx` | Global keyboard shortcut shown as keycaps that sink as keys are held. |
| RealisticSwitch | `components/realistic-switch.tsx` | `docs/realistic-switch.mdx` | Latching push switch that stays down while on. |
| ClickPowerUp | `components/click-powerup.tsx` | `docs/click-power-up.mdx` | Bracketed button that arms on hover and flashes on click. |
| DoubtButton | `components/doubt-button.tsx` | `docs/doubt-button.mdx` | Escalating confirmations before the real action fires (joke version of a confirm dialog). |

## Styles

| Component | Component file | Docs | What it does |
| --- | --- | --- | --- |
| MinimalButton | `components/minimal.tsx` | `docs/minimal-button.mdx` | Quiet dark button, hairline ring, inner highlight, chevron nudges on hover. Closest to WAswitch taste. |
| ThreeDButton | `components/3d-button.tsx` | `docs/3d-button.mdx` | Minimal 3D deck-style press with a sliding sheen. |
| ShinyButton | `components/shiny-button.tsx` | `docs/shiny-button.mdx` | Glossy gradient, inner glow, glint on click. |
| AquaButton | `components/aqua-button.tsx` | `docs/aqua-button.mdx` | Apple Aqua style glossy pill. |
| BrutalButton | `components/brutal-button.tsx` | `docs/brutal-button.mdx` | NeoBrutalism, hard shadow, stark border. |
| MoviePassButton | `components/movie-pass.tsx` | `docs/movie-pass.mdx` | Ticket that tears along its perforation on click. |

## Effects

| Component | Component file | Docs | What it does |
| --- | --- | --- | --- |
| HighlightButton | `components/highlight-button.tsx` | `docs/highlight-button.mdx` | Cursor spotlight, border lights near the pointer, click ripple. |
| FrameButton | `components/frame-button.tsx` | `docs/frame-button.mdx` | Corner markers spread on hover and lock on press, scan sweep. |
| ChromeButton | `components/chrome-button.tsx` | `docs/chrome-button.mdx` | Liquid chrome ring border, follows light/dark theme. |
| GlitchButton | `components/glitch-button.tsx` | `docs/glitch-button.mdx` | RGB-split glitch bursts and scanlines. |
| DitherButton | `components/dither-button.tsx` | `docs/dither-button.mdx` | Animated 4x4 ordered-dither background, knockout label. |
| EvilEyeButton | `components/evil-eye-button.tsx` | `docs/evil-eye-button.mdx` | Eye behind the label tracks the cursor and blinks. |
| ConfettiButton | `components/confetti-button.tsx` | `docs/confetti-button.mdx` | Restrained confetti burst on click (canvas-confetti). |
| AshBurstButton | `components/ash-burst-button.tsx` | `docs/ash-burst-button.mdx` | Ember glow and Matter.js ash physics on click. |
| MinecraftButton | `components/minecraft-button.tsx` | `docs/minecraft-button.mdx` | Pixel stone button that cracks, shatters and respawns. |

## Mischief (jokes, not for real UI)

| Component | Component file | Docs | What it does |
| --- | --- | --- | --- |
| TrollButton | `components/troll-button.tsx` | `docs/troll-button.mdx` | Dodges the cursor until it runs out of stamina. |
| StickyButton | `components/sticky.tsx` | `docs/sticky-button.mdx` | Magnetic pull toward the cursor with parallax tilt. |
| ThrusterButton | `components/thruster-button.tsx` | `docs/thruster-button.mdx` | Flies to the cursor on air jets with WebGL smoke. |
| DemonicButton | `components/demonic-button.tsx` | `docs/demonic-button.mdx` | Hold to raise devil horns and canvas fire. |

## Updating this copy

Re-copy `components/evil-buttons/*.tsx` to `components/`, `content/docs/*.mdx` to `docs/`, `lib/utils.ts` to `components/_utils.ts` and `LICENSE` to `LICENSE.txt`, add rows for new entries in `registry.components.json`, and update the commit above.
