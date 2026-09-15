import "./style.css";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

/** Buttery inertia scrolling — decouples visual scroll from raw wheel/trackpad
 * input so the whole scrub feels fluid instead of following the browser's
 * native (stepped, platform-dependent) scroll exactly. Wired into GSAP's own
 * ticker so ScrollTrigger reads Lenis's smoothed position every frame.
 *
 * Uses `lerp` rather than a fixed `duration`: duration mode commits each
 * wheel tick to its own fixed-time ease, which compounds into a noticeable
 * drift after you stop scrolling; lerp mode instead chases whatever the
 * current target is every frame, so it stays smooth but tightly coupled to
 * live input. Same lerp value on every device — the scrub should feel the
 * same on a phone as it does on a laptop. */
function initSmoothScroll() {
  const lenis = new Lenis({
    lerp: 0.1,
    smoothWheel: true,
    syncTouch: false, // native touch scroll feels better than a lerped one on mobile
    // This page's core mechanic IS scroll-linked motion (the video scrub) —
    // it isn't a decorative extra a reduced-motion user can skip, so unlike
    // most sites we don't let the OS/browser preference silently turn
    // smoothing off (Lenis's default). Without this, "prefers-reduced-motion"
    // being on anywhere in the chain makes the whole scrub feel stepped/native
    // even though this code looks and is otherwise wired correctly.
    respectReducedMotion: false,
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

type Band = [enterStart: number, enterEnd: number, exitStart: number, exitEnd: number];

// Fraction of each staggered line's own duration used as the offset to the
// next line. Sizing the per-line duration so stagger*(n-1) + duration lands
// exactly on the band's end keeps the last line's motion finishing in sync
// with the container's autoAlpha cutoff, instead of getting cut off mid-exit.
const STAGGER_FRACTION = 0.3;

/** Wires one scene's masked-line enter/exit into a scrubbed timeline at the given band. */
function addSceneToTimeline(tl: gsap.core.Timeline, scene: HTMLElement, [enterStart, enterEnd, exitStart, exitEnd]: Band) {
  const eyebrow = scene.querySelector(".scene-eyebrow");
  const lines = scene.querySelectorAll(".line-inner");
  const n = lines.length;

  const enterDur = enterEnd - enterStart;
  const exitDur = exitEnd - exitStart;
  const enterItemDur = enterDur / (1 + (n - 1) * STAGGER_FRACTION);
  const exitItemDur = exitDur / (1 + (n - 1) * STAGGER_FRACTION);

  gsap.set(scene, { autoAlpha: 0 });
  gsap.set(lines, { yPercent: 115 });
  if (eyebrow) gsap.set(eyebrow, { autoAlpha: 0, letterSpacing: "0.32em" });

  tl.set(scene, { autoAlpha: 1 }, enterStart)
    .fromTo(eyebrow, { autoAlpha: 0 }, { autoAlpha: 1, duration: enterDur, ease: "sine.out" }, enterStart)
    .to(eyebrow, { letterSpacing: "0.16em", duration: enterDur, ease: "sine.out" }, enterStart)
    .to(lines, { yPercent: 0, duration: enterItemDur, ease: "power2.out", stagger: enterItemDur * STAGGER_FRACTION }, enterStart)
    .to(lines, { yPercent: -115, duration: exitItemDur, ease: "power1.in", stagger: exitItemDur * STAGGER_FRACTION }, exitStart)
    .to(eyebrow, { autoAlpha: 0, duration: exitDur, ease: "sine.in" }, exitStart)
    .set(scene, { autoAlpha: 0 }, exitEnd);
}

/** Reveals a scene immediately — used only for the very first scene, since its
 * band starts at t=0, exactly the scrub timeline's own creation time. GSAP's
 * scrub renderer treats that as "unchanged" and skips painting it, so the
 * normal scroll-driven reveal would never fire until the user scrolls away
 * and back to the top. Kept short so it's finished well before a visitor who
 * scrolls immediately could reach this scene's scrubbed exit and have both
 * animations fighting over the same transform. */
function revealSceneNow(scene: HTMLElement) {
  gsap.set(scene, { autoAlpha: 1 });
  const eyebrow = scene.querySelector(".scene-eyebrow");
  gsap.to(scene.querySelectorAll(".line-inner"), { yPercent: 0, duration: 0.5, ease: "power2.out", stagger: 0.05, delay: 0.1 });
  if (eyebrow) gsap.to(eyebrow, { autoAlpha: 1, letterSpacing: "0.16em", duration: 0.45, ease: "sine.out", delay: 0.1 });
}

/** iOS Safari (and some other mobile browsers) won't reliably honor
 * `currentTime` seeks on a video that has never actually entered the
 * "playing" state — even when muted, even when readyState says metadata is
 * loaded. Playing a frame and immediately pausing "unlocks" seeking for the
 * rest of the video's life. Muted+playsinline video is exempt from autoplay
 * restrictions in effectively every current mobile browser, so this runs
 * without needing a user gesture first. */
function primeForSeeking(video: HTMLVideoElement) {
  video.play().then(() => video.pause()).catch(() => video.pause());
}

/** Scroll-scrubbing needs to seek to arbitrary byte offsets on demand, which
 * browsers implement as range-requesting the network resource — if the host
 * doesn't serve HTTP Range requests (some CDN/static-host configs silently
 * ignore the Range header and return the full file with 200 instead of 206),
 * every seek past the currently-buffered position is just dropped by the
 * browser: currentTime never moves, even though readyState/buffered still
 * look fine. Fetching the file into memory once and pointing the video at a
 * blob: URL sidesteps that entirely — a blob is random-access locally, so
 * every seek is instant regardless of what the server supports. These clips
 * are only a few MB each, small enough to fetch whole. Always the mp4 (not
 * the webm alternate) since h.264 plays natively on every target browser
 * including iOS Safari, which has no WebM support at all. */
async function loadAsBlob(video: HTMLVideoElement): Promise<void> {
  const source = video.querySelector<HTMLSourceElement>('source[type="video/mp4"]');
  if (!source) return;
  const blob = await (await fetch(source.src)).blob();
  video.src = URL.createObjectURL(blob);
}

/** Drives a video's currentTime from a scrub proxy. Skips redundant seeks
 * while one is already in flight (avoids flooding the decoder and lagging
 * behind scroll), then re-checks on "seeked" once it resolves — otherwise a
 * scrub that stops exactly while a seek is in progress would permanently
 * settle a frame or two short of the true final target. */
function wireScrub(video: HTMLVideoElement, proxy: { t: number }) {
  const apply = () => {
    if (video.readyState >= 1 && !video.seeking && Math.abs(video.currentTime - proxy.t) > 0.015) {
      video.currentTime = proxy.t;
    }
  };
  video.addEventListener("seeked", apply);
  return apply;
}

/**
 * One continuous pinned scroll-scrub spanning two clips as a single shot:
 * clip A (the descent) scrubs to black; once its scene text has fully
 * cleared and a beat of pure black has passed, clip B (the arrival)
 * dissolves in over that black and scrubs forward to its last frame,
 * finishing right as its own final scene ("Arrival") exits; the whole shot
 * then fades to true black, and the closing mark fades in on top of that
 * black — a deliberate end card, not just a trail into empty space. One
 * timeline, one progress bar, no seam anywhere.
 *
 * Segment boundaries are fractions of the whole scrub (out of 1105
 * vh-equivalent units): A scrubs over [0, 500], a black gap to 545, clip B
 * dissolves in over 545-605, scrubs over 605-955 (paced to its own ~8.3s
 * length), the shot fades to black over 955-1045, then the end card fades
 * in over the remaining 1045-1105.
 */
async function initHero() {
  const hero = document.querySelector<HTMLElement>("#hero");
  const videoA = hero?.querySelector<HTMLVideoElement>(".hero-video-a");
  const videoB = hero?.querySelector<HTMLVideoElement>(".hero-video-b");
  const close = hero?.querySelector<HTMLElement>(".hero-close");
  const endcard = hero?.querySelector<HTMLElement>(".hero-endcard");
  const scenes = hero ? gsap.utils.toArray<HTMLElement>(hero.querySelectorAll(".scene")) : [];
  const progressFill = hero?.querySelector<HTMLElement>(".hero-progress-fill");
  if (!hero || !videoA || !videoB || !close || !endcard) return;

  // Falls back to the original network-streamed <source> on fetch failure
  // (offline, blocked request) — scrubbing degrades to whatever the host's
  // Range support allows instead of the video failing to load at all.
  await Promise.allSettled([loadAsBlob(videoA), loadAsBlob(videoB)]);

  primeForSeeking(videoA);
  primeForSeeking(videoB);
  gsap.set(videoB, { autoAlpha: 0 });
  gsap.set(close, { opacity: 0 });
  gsap.set(endcard, { opacity: 0 });

  const SEG_A_END = 500 / 1105;
  const CROSSFADE_START = 545 / 1105;
  const SEG_B_START = 605 / 1105;
  const B_SCRUB_END = 955 / 1105;
  const CLOSE_END = 1045 / 1105;

  const build = (durationA: number, durationB: number) => {
    const proxyA = { t: 0 };
    const proxyB = { t: 0 };

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: hero,
        start: "top top",
        end: "bottom bottom",
        // Lenis is now the layer providing scroll inertia — a numeric scrub
        // lag here on top of that stacks two smoothing systems, which reads
        // as sluggish/disconnected rather than fluid. Bind tightly instead
        // and let Lenis alone own the "smooth" feel.
        scrub: true,
        onUpdate: (self) => {
          if (progressFill) progressFill.style.width = `${self.progress * 100}%`;
        },
      },
    });

    tl.to(proxyA, { t: durationA, duration: SEG_A_END, ease: "none", onUpdate: wireScrub(videoA, proxyA) }, 0);

    tl.to(proxyB, { t: durationB, duration: B_SCRUB_END - SEG_B_START, ease: "none", onUpdate: wireScrub(videoB, proxyB) }, SEG_B_START);

    // Clip B rides above A (see z-index in CSS); fading it in is enough to
    // complete the handoff without touching clip A underneath.
    tl.to(videoB, { autoAlpha: 1, duration: SEG_B_START - CROSSFADE_START, ease: "sine.out" }, CROSSFADE_START);

    // Clip B's last frame holds (its own scrub has finished, right as scene
    // VIII exits) and fades straight to black; the mark then signs off the
    // piece on top of that black, rather than the site just trailing into
    // nothing.
    tl.to(close, { opacity: 1, duration: CLOSE_END - B_SCRUB_END, ease: "sine.in" }, B_SCRUB_END);
    tl.to(endcard, { opacity: 1, duration: 1 - CLOSE_END, ease: "sine.out" }, CLOSE_END);

    // Each clip's scene bands are authored in that clip's own local 0..1
    // progress, then mapped onto the shared timeline: A into [0, SEG_A_END],
    // B into [SEG_B_START, B_SCRUB_END] — B's own scrubbing window, before
    // the closing dissolve-to-still-and-black begins.
    const localBands: Band[] = [
      [0.0, 0.055, 0.17, 0.225],
      [0.275, 0.33, 0.435, 0.49],
      [0.535, 0.59, 0.695, 0.75],
      [0.8, 0.855, 0.965, 1.0],
    ];
    const mapA = (x: number) => x * SEG_A_END;
    const mapB = (x: number) => SEG_B_START + x * (B_SCRUB_END - SEG_B_START);
    const bands: Band[] = [...localBands.map((b) => b.map(mapA) as Band), ...localBands.map((b) => b.map(mapB) as Band)];

    bands.forEach((band, i) => scenes[i] && addSceneToTimeline(tl, scenes[i], band));

    // Scene 0 enters at t=0 — see revealSceneNow's comment.
    if (scenes[0]) revealSceneNow(scenes[0]);
  };

  const ready = (v: HTMLVideoElement) => v.readyState >= 1 && isFinite(v.duration);
  const settle = (durationA: number, durationB: number) => {
    build(durationA, durationB);
    ScrollTrigger.refresh();
  };

  if (ready(videoA) && ready(videoB)) {
    settle(videoA.duration, videoB.duration);
  } else {
    let settled = false;
    const onMeta = () => {
      if (!settled && ready(videoA) && ready(videoB)) {
        settled = true;
        settle(videoA.duration, videoB.duration);
      }
    };
    videoA.addEventListener("loadedmetadata", onMeta);
    videoB.addEventListener("loadedmetadata", onMeta);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        settle(ready(videoA) ? videoA.duration : 11.5, ready(videoB) ? videoB.duration : 8.33);
      }
    }, 1500);
  }
}

initSmoothScroll();
initHero();
