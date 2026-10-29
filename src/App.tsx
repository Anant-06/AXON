import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { GPUFluid } from './fluid';
import { ParticleSystem } from './particles';

interface CardData {
  id: string;
  videoUrl: string;
  leftMeta: string;
  rightMeta: string;
  tag: string;
}

const CARDS: CardData[] = [
  {
    id: 'lattices',
    videoUrl: 'https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/aaaf/oraciteslArea.mp4',
    leftMeta: 'Lattices\n/ zone',
    rightMeta: 'Ambient light\n/ study',
    tag: 'Light',
  },
  {
    id: 'prism',
    videoUrl: 'https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/aaaf/facet-glass-hero.mp4',
    leftMeta: 'Prism\n/ shell',
    rightMeta: 'Dispersion hero\n/ render',
    tag: 'Physics',
  },
  {
    id: 'nebular',
    videoUrl: 'https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/aaaf/stellarmind-hero.mp4',
    leftMeta: 'Nebular\n/ loop',
    rightMeta: 'Procedural hero\n/ sequence',
    tag: 'Volumes',
  },
  {
    id: 'fall',
    videoUrl: 'https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/aaaf/thedropthroughArea.mp4',
    leftMeta: 'Fall\n/ forward',
    rightMeta: 'Dolly track\n/ study',
    tag: 'Particles',
  },
];

const TAGS = [
  'All',
  'Light',
  'Physics',
  'Fluids',
  'Grid',
  'Audio',
  'Volumes',
  'Particles',
  'Capture',
  'Render',
];

function clampMap(val: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const t = Math.max(0, Math.min(1, (val - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

function StarPolygon() {
  const points = useMemo(() => {
    const pts: string[] = [];
    const cx = 20;
    const cy = 20;
    const rOuter = 12.5;
    const rInner = 5.2;
    for (let i = 0; i < 16; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 8;
      const r = i % 2 === 0 ? rOuter : rInner;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return pts.join(' ');
  }, []);

  return <polygon points={points} fill="#ffffff" />;
}

function VideoItem({ card }: { card: CardData }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Autoplay policy or loading interruption
      });
    }
  }, [card.videoUrl]);

  return (
    <div className="card pt-[18px] pb-[18px] border-t border-[var(--line)]">
      <div className="thumb h-[160px] rounded-[2px] bg-[#0a0a0a] overflow-hidden relative">
        <video
          ref={videoRef}
          src={card.videoUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="w-full h-full object-cover block"
        />
      </div>
      <div className="meta flex justify-between items-start gap-4 mt-[10px] text-[12px] leading-[1.35]">
        <div className="text-white whitespace-pre-line text-left">
          {card.leftMeta}
        </div>
        <div className="text-[var(--muted)] whitespace-pre-line text-right">
          {card.rightMeta}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeTag, setActiveTag] = useState<string>('All');

  // Filtered cards based on active tag
  const filteredCards = useMemo(() => {
    if (activeTag === 'All') return CARDS;
    const matched = CARDS.filter((c) => c.tag === activeTag);
    return matched.length > 0 ? matched : CARDS;
  }, [activeTag]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const isMobile = width <= 760;

    // Check software WebGL renderer
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 1.0);

    const fluid = new GPUFluid();
    const particles = new ParticleSystem(isMobile);
    particles.initTargets(renderer);

    // Mouse / Cursor tracking state
    let prevX = width * 0.5;
    let prevY = height * 0.5;
    let currX = width * 0.5;
    let currY = height * 0.5;
    let lastSplatTime = 0;
    let hasMoved = false;

    // Trigger initial gentle swirl so the field is alive immediately
    fluid.addSplat(
      { x: 0.5, y: 0.5 },
      { x: 0.52, y: 0.51 },
      { r: 4.0, g: -2.0, b: 1.0 },
      0.08
    );

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      let clientX = 0;
      let clientY = 0;

      if ('touches' in e && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if ('clientX' in e) {
        clientX = (e as MouseEvent).clientX;
        clientY = (e as MouseEvent).clientY;
      } else {
        return;
      }

      currX = clientX;
      currY = clientY;

      if (!hasMoved) {
        prevX = currX;
        prevY = currY;
        hasMoved = true;
      }

      const now = performance.now();
      const timeSinceLastSplat = now - lastSplatTime;
      const dx = currX - prevX;
      const dy = currY - prevY;
      const len = Math.hypot(dx, dy);

      if (len > 0.01) {
        // Splat radius: clamp-map(len, 0..5 → 0..60) × 0.6 (× 0.8 on mobile)
        const radiusPx = clampMap(len, 0, 5, 0, 60) * (isMobile ? 0.8 : 0.6);
        // Force multiplier: clamp-map(len, 0..15 → 0..10)
        const forceMult = clampMap(len, 0, 15, 0, 10);

        // Convert coordinates to UV (aspect-corrected)
        // If more than 50 ms passed since the last splat, the line starts at the current point
        const startX = timeSinceLastSplat > 50 ? currX : prevX;
        const startY = timeSinceLastSplat > 50 ? currY : prevY;

        const w = window.innerWidth;
        const h = window.innerHeight;

        const p0 = { x: startX / w, y: 1.0 - startY / h };
        const p1 = { x: currX / w, y: 1.0 - currY / h };

        // Colour: (dx * mult, -dy * mult, 1) into velocity
        const color = {
          r: dx * forceMult,
          g: -dy * forceMult,
          b: 1.0,
        };

        // Radius / 200 in UV units
        const radiusUv = radiusPx / 200.0;

        fluid.addSplat(p0, p1, color, radiusUv);
        lastSplatTime = now;
      }

      prevX = currX;
      prevY = currY;
    };

    window.addEventListener('mousemove', handlePointerMove, { passive: true });
    window.addEventListener('touchstart', handlePointerMove, { passive: true });
    window.addEventListener('touchmove', handlePointerMove, { passive: true });

    const handleResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
      particles.resize(w, h);
    };

    window.addEventListener('resize', handleResize);

    // Animation Loop
    let animId = 0;
    let lastTime = performance.now();
    let elapsedTime = 0;

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000.0, 0.1);
      lastTime = now;
      elapsedTime += dt;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const aspect = w / h;

      // Update gaze camera
      particles.updateGaze(currX, currY, w, h);

      // Step fluid simulation
      fluid.step(renderer, aspect);

      // Step particle simulation & render to screen
      particles.step(renderer, elapsedTime, dt, fluid);

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('touchstart', handlePointerMove);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('resize', handleResize);
      particles.dispose();
      fluid.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black select-none">
      {/* Layer 1: Fixed WebGL Canvas */}
      <canvas
        id="bg"
        ref={canvasRef}
        className="fixed inset-0 w-full h-full z-0 block bg-black"
      />

      {/* Layer 2: Fixed Monospace UI Overlay */}
      <div className="ui fixed inset-0 z-10 pointer-events-none">
        {/* Brand */}
        <div className="brand absolute top-[24px] left-[24px] flex flex-row items-center gap-[14px]">
          <div className="w-[40px] h-[40px] shrink-0">
            <svg
              width="40"
              height="40"
              viewBox="0 0 40 40"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="20" cy="20" r="18.5" stroke="#ffffff" strokeWidth="1.6" />
              <StarPolygon />
            </svg>
          </div>
          <div className="flex flex-col justify-center">
            <span className="text-[20px] font-normal text-white leading-none tracking-[0.02em]">
              AXON
            </span>
            <span className="text-[11px] text-[var(--muted)] mt-[2px] leading-tight tracking-[0.02em]">
              Motion research
            </span>
          </div>
        </div>

        {/* Counter */}
        <div className="counter absolute top-[24px] right-[24px] w-[44px] h-[44px] rounded-full border border-[var(--line)] bg-[#0a0a0a] flex items-center justify-center text-[14px] text-white">
          07
        </div>

        {/* Tags */}
        <div className="tags axon-tags absolute top-[120px] left-[24px] w-[320px] flex flex-wrap gap-[6px]">
          {TAGS.map((tag) => {
            const isActive = activeTag === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(tag)}
                className={`tag-chip ${isActive ? 'active' : ''}`}
              >
                {tag}
              </button>
            );
          })}
        </div>

        {/* Card list */}
        <div className="list axon-list absolute top-[250px] left-[24px] bottom-0 w-[320px] overflow-y-auto no-scrollbar pointer-events-auto pr-1">
          {filteredCards.map((card) => (
            <VideoItem key={card.id} card={card} />
          ))}
          {/* Bottom spacing padding */}
          <div className="h-[36px]" />
        </div>

        {/* Text column */}
        <div className="about axon-about absolute right-[90px] top-1/2 -translate-y-1/2 w-[380px] pointer-events-auto blend-text">
          {/* [info] */}
          <div className="mb-[2.2em]">
            <h2 className="text-[13px] text-[var(--accent)] mb-[1em] font-normal tracking-[0.02em]">
              [info]
            </h2>
            <p className="text-justify mb-[1em] text-[var(--text)] leading-[1.35]">
              Studies are published as they are built and may not run on every device.
            </p>
          </div>

          {/* [aims] */}
          <div className="mb-[2.2em]">
            <h2 className="text-[13px] text-[var(--accent)] mb-[1em] font-normal tracking-[0.02em]">
              [aims]
            </h2>
            <p className="text-justify mb-[1em] text-[var(--text)] leading-[1.35]">
              An open logbook of real-time rendering research: surfaces, fluids, fields, and the little tools we build to shape them.
            </p>
            <p className="text-justify mb-[1em] text-[var(--text)] leading-[1.35]">
              It is here to keep the work in view and to give each new project a place to grow.
            </p>
          </div>

          {/* [exploring] */}
          <div className="mb-[2.2em]">
            <h2 className="text-[13px] text-[var(--accent)] mb-[1em] font-normal tracking-[0.02em]">
              [exploring]
            </h2>
            <div className="leading-[1.6] text-[var(--text)]">
              • Signed surfaces &nbsp;• Cursor turbulence &nbsp;• Compute passes &nbsp;• Type in 3D space
            </div>
          </div>

          {/* [connect] */}
          <div>
            <h2 className="text-[13px] text-[var(--accent)] mb-[1em] font-normal tracking-[0.02em]">
              [connect]
            </h2>
            <div>
              <a href="#" className="axon-link text-[var(--text)]">
                Index -&gt; AXON
              </a>
              <a href="mailto:hello@axonlab.dev" className="axon-link text-[var(--text)]">
                Mail -&gt; hello@axonlab.dev
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
