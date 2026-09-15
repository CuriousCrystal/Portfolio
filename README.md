# Umbra — A Motion Study

A scroll-driven cinematic piece: two videos scrubbed frame-accurately by
scroll position, with editorial text reveals synced to each scene. Built as
one continuous pinned sequence rather than a series of stacked sections —
scroll speed, video playback direction, and text timing all stay locked
together, forward or backward.

**[Live site →](https://your-deployment-url.pages.dev)** _(update this link
once deployed)_

## How it works

- **Scroll-scrubbed video** — `video.currentTime` is driven directly by
  scroll progress via a GSAP `ScrollTrigger`, not autoplayed. Scrolling
  backward plays the footage backward.
- **Lenis** provides the inertia/smoothing on top of raw wheel/touch input,
  wired into GSAP's own ticker so the two stay in sync.
- **Masked-line text reveals** — each scene's copy enters and exits via
  clipped, staggered line transforms timed to specific moments in the
  footage, not just a generic fade.
- Both source clips are re-encoded with a short keyframe interval
  (`-g 8 -keyint_min 8`) specifically so arbitrary scroll-driven seeks stay
  fast — the default long keyframe spacing most encoders use makes
  scroll-scrubbing stutter badly.

## Stack

[Vite](https://vitejs.dev/) + TypeScript, [GSAP](https://gsap.com/) /
ScrollTrigger, [Lenis](https://lenis.darkroom.engineering/). No framework —
one page, one script.

## Running locally

```bash
npm install
npm run dev       # dev server at localhost:5173
npm run build     # production build → dist/
npm run preview   # serve the production build locally
```

## Deploying

`npm run build` outputs a static `dist/` folder — deploy that, not the repo
root. On Cloudflare Pages: build command `npm run build`, output directory
`dist`.
