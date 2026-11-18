import {
    createSystem,
    Vector3,
    Group,
    Mesh,
    SphereGeometry,
    PlaneGeometry,
    MeshBasicMaterial,
    CanvasTexture,
    SRGBColorSpace,
    Color,
    Object3D,
    AdditiveBlending,
    MathUtils,
  } from '@iwsdk/core';
  
  // ---------- Settings (yahin se tune kar sakte ho) ----------
  const SESSION_SECONDS = 90;
  const HOLD_TO_START = 1.0; // hands itne seconds dikhein toh session start
  const PINCH_DIST = 0.03; // thumb-tip aur index-tip ki doori (meter)
  const PINCH_MIDDLE_MIN = 1.4; // fist ko pinch na samjhe
  const GRAB_RADIUS = 0.15; // pinch particle ke itna paas ho toh release
  const PARTICLE_COUNT = 12;
  const ORB_MIN = 0.06;
  const ORB_MAX = 0.15;
  const DISTANCE = 0.65; // orb user se kitni door (meter)
  const BACKGROUND = 0x0a0f24; // dark dusk
  
  const TIP_NAMES = [
    'index-finger-tip',
    'middle-finger-tip',
    'ring-finger-tip',
    'pinky-finger-tip',
  ];
  
  type Phase = 'intro' | 'session' | 'summary';
  
  interface HandState {
    tracked: boolean;
    ratio: number; // average fingertip distance / palm size
    middle: number; // middle finger extension ratio
    pinching: boolean;
    pinchPrev: boolean;
    tip: Vector3; // index fingertip position
  }
  
  interface Particle {
    mesh: Mesh;
    mat: MeshBasicMaterial;
    base: Vector3;
    phase: number;
    released: boolean;
    relT: number;
  }
  
  interface TextLine {
    text: string;
    size: number;
    color?: string;
  }
  
  // ---------- Canvas se text panel (VR mein text dikhane ke liye) ----------
  class Label {
    readonly mesh: Mesh;
    private ctx: CanvasRenderingContext2D;
    private tex: CanvasTexture;
    private last = '';
  
    constructor(width: number, height: number) {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = Math.round((1024 * height) / width);
      this.ctx = canvas.getContext('2d')!;
      this.tex = new CanvasTexture(canvas);
      this.tex.colorSpace = SRGBColorSpace;
      this.mesh = new Mesh(
        new PlaneGeometry(width, height),
        new MeshBasicMaterial({
          map: this.tex,
          transparent: true,
          depthWrite: false,
        }),
      );
    }
  
    set(lines: TextLine[]): void {
      const key = JSON.stringify(lines);
      if (key === this.last) {
        return;
      }
      this.last = key;
      const ctx = this.ctx;
      const c = ctx.canvas;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = 'rgba(20, 28, 60, 0.7)';
      ctx.fillRect(0, 0, c.width, c.height);
      const total = lines.reduce((s, l) => s + l.size * 1.35, 0);
      let y = (c.height - total) / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const l of lines) {
        ctx.font = `${l.size}px sans-serif`;
        ctx.fillStyle = l.color ?? '#ffffff';
        ctx.fillText(l.text, c.width / 2, y);
        y += l.size * 1.35;
      }
      this.tex.needsUpdate = true;
    }
  }
  
  function formatTime(sec: number): string {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  
  export class DuskSystem extends createSystem({}) {
    private root = new Group();
    private bg = new Color(BACKGROUND);
    private orb!: Mesh;
    private halo!: Mesh;
    private orbMat = new MeshBasicMaterial({ color: 0x2f4bd8 });
    private haloMat = new MeshBasicMaterial({
      color: 0x6f8fff,
      transparent: true,
      opacity: 0.15,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    private label!: Label;
    private particles: Particle[] = [];
  
    private colorClosed = new Color(0x2f4bd8);
    private colorOpen = new Color(0xffb36b);
  
    private hands: HandState[] = [0, 1].map(() => ({
      tracked: false,
      ratio: 0,
      middle: 0,
      pinching: false,
      pinchPrev: false,
      tip: new Vector3(),
    }));
  
    // keyboard fallback (desktop / emulator)
    private spaceDown = false;
    private enterPressed = false;
    private releaseKey = false;
  
    // temp vectors
    private tmp = new Vector3();
    private headPos = new Vector3();
    private fwd = new Vector3();
    private target = new Vector3();
    private placed = false;
  
    // state
    private phase: Phase = 'intro';
    private phaseT = 0;
    private holdT = 0;
    private open = 0;
    private rMin = 1.1;
    private rMax = 1.85;
  
    // session stats (sab real, measured)
    private sessionT = 0;
    private dir = 1;
    private extreme = 0;
    private riseT = 0;
    private fallT = 0;
    private high = false;
    private lastHighT: number | null = null;
    private cycles: number[] = [];
    private releasedCount = 0;
  
    init(): void {
      this.world.scene.background = this.bg;
      this.world.scene.add(this.root);
  
      const sphereGeo = new SphereGeometry(1, 48, 32);
      this.orb = new Mesh(sphereGeo, this.orbMat);
      this.halo = new Mesh(sphereGeo, this.haloMat);
      this.root.add(this.orb);
      this.root.add(this.halo);
  
      this.label = new Label(0.5, 0.2);
      this.label.mesh.position.set(0, 0.36, 0);
      this.root.add(this.label.mesh);
  
      const pGeo = new SphereGeometry(0.014, 16, 12);
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const a = MathUtils.randFloat(-1.2, 1.2);
        const e = MathUtils.randFloat(-0.5, 0.5);
        const r = MathUtils.randFloat(0.26, 0.38);
        const base = new Vector3(
          r * Math.sin(a) * Math.cos(e),
          r * Math.sin(e) - 0.05,
          r * Math.cos(a) * Math.cos(e) * 0.8 - 0.05,
        );
        const mat = new MeshBasicMaterial({
          color: 0xcfd8ff,
          transparent: true,
          opacity: 0.9,
        });
        const mesh = new Mesh(pGeo, mat);
        mesh.position.copy(base);
        this.root.add(mesh);
        this.particles.push({
          mesh,
          mat,
          base,
          phase: Math.random() * Math.PI * 2,
          released: false,
          relT: 0,
        });
      }
  
      const onDown = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          this.spaceDown = true;
          e.preventDefault();
        } else if (e.code === 'Enter') {
          this.enterPressed = true;
        } else if (e.code === 'KeyR') {
          this.releaseKey = true;
        }
      };
      const onUp = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          this.spaceDown = false;
        }
      };
      window.addEventListener('keydown', onDown);
      window.addEventListener('keyup', onUp);
      this.cleanupFuncs.push(() => {
        window.removeEventListener('keydown', onDown);
        window.removeEventListener('keyup', onUp);
      });
    }
  
    // ---------- Hand tracking (WebXR hand joints) ----------
    private readHand(i: number): void {
      const h = this.hands[i];
      h.pinchPrev = h.pinching;
      h.tracked = false;
      h.pinching = false;
  
      const hand = this.world.renderer.xr.getHand(i);
      const j = hand.joints as unknown as Record<string, Object3D | undefined>;
      const wrist = j['wrist'];
      const knuckle = j['middle-finger-phalanx-proximal'];
      const thumb = j['thumb-tip'];
      const idx = j['index-finger-tip'];
      if (!wrist?.visible || !knuckle?.visible || !thumb?.visible || !idx?.visible) {
        return;
      }
  
      const size = wrist.position.distanceTo(knuckle.position);
      if (size < 0.02) {
        return;
      }
  
      let sum = 0;
      let n = 0;
      for (const name of TIP_NAMES) {
        const t = j[name];
        if (t?.visible) {
          sum += wrist.position.distanceTo(t.position);
          n++;
        }
      }
      if (n < 3) {
        return;
      }
  
      h.ratio = sum / n / size;
      const mid = j['middle-finger-tip'];
      h.middle = mid?.visible ? wrist.position.distanceTo(mid.position) / size : 0;
      h.pinching =
        thumb.position.distanceTo(idx.position) < PINCH_DIST &&
        h.middle > PINCH_MIDDLE_MIN;
      idx.getWorldPosition(h.tip);
      h.tracked = true;
    }
  
    // ---------- Placement: orb user ke saamne ----------
    private placeRoot(smooth: boolean): void {
      const cam = this.world.camera;
      cam.getWorldPosition(this.headPos);
      cam.getWorldDirection(this.fwd);
      this.fwd.y = 0;
      if (this.fwd.lengthSq() < 1e-4) {
        this.fwd.set(0, 0, -1);
      }
      this.fwd.normalize();
      this.target.copy(this.headPos).addScaledVector(this.fwd, DISTANCE);
      this.target.y = this.headPos.y - 0.1;
      if (smooth) {
        this.root.position.lerp(this.target, 0.1);
      } else {
        this.root.position.copy(this.target);
      }
      this.root.rotation.y = Math.atan2(-this.fwd.x, -this.fwd.z);
    }
  
    private resetParticles(): void {
      for (const p of this.particles) {
        p.released = false;
        p.relT = 0;
        p.mesh.visible = true;
        p.mesh.scale.setScalar(1);
        p.mat.opacity = 0.9;
        p.mesh.position.copy(p.base);
      }
    }
  
    private startSession(): void {
      this.phase = 'session';
      this.phaseT = 0;
      this.sessionT = 0;
      this.dir = 1;
      this.extreme = this.open;
      this.riseT = 0;
      this.fallT = 0;
      this.high = false;
      this.lastHighT = null;
      this.cycles = [];
      this.releasedCount = 0;
      this.resetParticles();
    }
  
    private tryRelease(pos: Vector3): void {
      let best: Particle | null = null;
      let bestD = GRAB_RADIUS;
      for (const p of this.particles) {
        if (p.released) {
          continue;
        }
        p.mesh.getWorldPosition(this.tmp);
        const d = this.tmp.distanceTo(pos);
        if (d < bestD) {
          best = p;
          bestD = d;
        }
      }
      if (best) {
        best.released = true;
        best.relT = 0;
        this.releasedCount++;
      }
    }
  
    private trackBreath(dt: number): void {
      const o = this.open;
  
      // inhale (rising) vs exhale (falling) ka time
      if (this.dir > 0) {
        if (o > this.extreme) {
          this.extreme = o;
        } else if (this.extreme - o > 0.2) {
          this.dir = -1;
          this.extreme = o;
        }
      } else if (o < this.extreme) {
        this.extreme = o;
      } else if (o - this.extreme > 0.2) {
        this.dir = 1;
        this.extreme = o;
      }
      if (this.dir > 0) {
        this.riseT += dt;
      } else {
        this.fallT += dt;
      }
  
      // ek full breath = do baar "open" tak pahunchne ke beech ka time
      if (!this.high && o > 0.7) {
        this.high = true;
        if (this.lastHighT !== null) {
          this.cycles.push(this.sessionT - this.lastHighT);
        }
        this.lastHighT = this.sessionT;
      } else if (this.high && o < 0.3) {
        this.high = false;
      }
    }
  
    private showSummary(): void {
      const lines: TextLine[] = [{ text: 'Session complete', size: 64 }];
      const n = this.cycles.length;
      if (n >= 2) {
        const avg = this.cycles.reduce((a, b) => a + b, 0) / n;
        lines.push({
          text: `${n} breaths  |  avg ${avg.toFixed(1)} s  (${(60 / avg).toFixed(1)} per min)`,
          size: 38,
        });
        if (this.riseT > 0.5) {
          lines.push({
            text: `Exhale time was ${(this.fallT / this.riseT).toFixed(1)}x your inhale time`,
            size: 38,
          });
        }
      } else {
        lines.push({ text: 'Not enough full breaths measured.', size: 38 });
        lines.push({ text: 'Open and close your hands slowly next time.', size: 38 });
      }
      lines.push({ text: `Thoughts released: ${this.releasedCount}`, size: 38 });
      lines.push({ text: 'Pinch to begin again', size: 34, color: '#9fb4ff' });
      this.label.set(lines);
    }
  
    update(delta: number, time: number): void {
      // scene ka halka background ko override karne se rokta hai
      if (this.world.scene.background !== this.bg) {
        this.world.scene.background = this.bg;
      }
  
      const dt = Math.min(delta, 0.1);
      this.readHand(0);
      this.readHand(1);
      const tracked = this.hands[0].tracked || this.hands[1].tracked;
  
      // ---- openness (0 = band haath, 1 = khule haath) ----
      let targetOpen = this.spaceDown ? 1 : 0;
      if (tracked) {
        let r = 0;
        let n = 0;
        for (const h of this.hands) {
          if (h.tracked) {
            r += h.ratio;
            n++;
          }
        }
        r /= n;
        this.rMin = Math.min(this.rMin, r);
        this.rMax = Math.max(this.rMax, r);
        targetOpen = MathUtils.clamp((r - this.rMin) / (this.rMax - this.rMin), 0, 1);
      }
      this.open += (targetOpen - this.open) * (1 - Math.exp(-dt * 8));
  
      // ---- pinch edge ----
      let pinchEdge = false;
      for (const h of this.hands) {
        if (h.pinching && !h.pinchPrev) {
          pinchEdge = true;
          if (this.phase === 'session') {
            this.tryRelease(h.tip);
          }
        }
      }
      if (this.releaseKey) {
        if (this.phase === 'session') {
          const p = this.particles.find((x) => !x.released);
          if (p) {
            p.released = true;
            p.relT = 0;
            this.releasedCount++;
          }
        }
        this.releaseKey = false;
      }
  
      // ---- phases ----
      this.phaseT += dt;
      if (this.phase === 'intro') {
        if (!this.placed) {
          this.placeRoot(false);
          this.placed = true;
        } else {
          this.placeRoot(true);
        }
        this.holdT = tracked ? this.holdT + dt : 0;
        this.label.set([
          { text: 'Dusk', size: 80 },
          { text: 'Hold your hands up to begin', size: 44 },
        ]);
        if (this.holdT >= HOLD_TO_START || this.enterPressed) {
          this.enterPressed = false;
          this.startSession();
        }
      } else if (this.phase === 'session') {
        this.sessionT += dt;
        this.trackBreath(dt);
        this.label.set([
          { text: this.dir > 0 ? 'Breathe in' : 'Breathe out', size: 76 },
          { text: 'Open hands = in   |   Close hands = out', size: 34, color: '#9fb4ff' },
          { text: formatTime(SESSION_SECONDS - this.sessionT), size: 48 },
        ]);
        if (this.sessionT >= SESSION_SECONDS) {
          this.phase = 'summary';
          this.phaseT = 0;
          this.showSummary();
        }
      } else {
        if ((pinchEdge || this.enterPressed) && this.phaseT > 1.5) {
          this.enterPressed = false;
          this.holdT = 0;
          this.phase = 'intro';
          this.phaseT = 0;
          this.placed = false;
          this.resetParticles();
        }
        this.enterPressed = false;
      }
  
      // ---- orb visuals ----
      const scale = MathUtils.lerp(ORB_MIN, ORB_MAX, this.open);
      this.orb.scale.setScalar(scale);
      this.halo.scale.setScalar(scale * 1.5);
      this.orbMat.color.lerpColors(this.colorClosed, this.colorOpen, this.open);
      this.haloMat.color.copy(this.orbMat.color);
      this.haloMat.opacity = 0.12 + 0.2 * this.open;
  
      // ---- particles ----
      for (const p of this.particles) {
        if (p.released) {
          p.relT += dt;
          p.mesh.position.y += dt * 0.15;
          p.mat.opacity = Math.max(0, 0.9 * (1 - p.relT / 1.5));
          p.mesh.scale.setScalar(1 + p.relT);
          if (p.relT >= 1.5) {
            p.mesh.visible = false;
          }
        } else {
          p.mesh.position.set(
            p.base.x + Math.sin(time * 0.6 + p.phase) * 0.012,
            p.base.y + Math.cos(time * 0.5 + p.phase) * 0.012,
            p.base.z,
          );
        }
      }
    }
  }