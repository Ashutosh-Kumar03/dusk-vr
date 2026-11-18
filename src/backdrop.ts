import {
    createSystem,
    Mesh,
    SphereGeometry,
    MeshBasicMaterial,
    Color,
    BackSide,
    Vector3,
    Box3,
    Object3D,
  } from '@iwsdk/core';
  
  const DARK = 0x0a0f24;
  const RADIUS = 30;
  
  // in naamon wale starter scene ke objects chhupao
  const HIDE_WORDS = [
    'floor',
    'stage',
    'plinth',
    'sideboard',
    'graphite',
    'lamp',
    'robot',
    'welcome',
    'gallery',
  ];
  
  export class BackdropSystem extends createSystem({}) {
    private dome!: Mesh;
    private camPos = new Vector3();
    private box = new Box3();
    private size = new Vector3();
    private timer = 10; // pehle frame par hi check karo
  
    init(): void {
      this.world.scene.background = new Color(DARK);
      this.dome = new Mesh(
        new SphereGeometry(RADIUS, 32, 16),
        new MeshBasicMaterial({
          color: DARK,
          side: BackSide,
          toneMapped: false,
          fog: false,
        }),
      );
      this.dome.frustumCulled = false;
      this.world.scene.add(this.dome);
    }
  
    private shouldHide(o: Object3D): boolean {
      if (o === this.dome || !o.visible) {
        return false;
      }
      const name = o.name.toLowerCase();
      if (name && HIDE_WORDS.some((w) => name.includes(w))) {
        return true;
      }
      // koi bhi bada aur chapta mesh (floor jaisa) bhi chhupao
      if ((o as Mesh).isMesh) {
        this.box.setFromObject(o);
        if (this.box.isEmpty()) {
          return false;
        }
        this.box.getSize(this.size);
        return this.size.y < 0.5 && (this.size.x > 6 || this.size.z > 6);
      }
      return false;
    }
  
    update(delta: number): void {
      // gumbad hamesha user ke saath rahe
      this.world.camera.getWorldPosition(this.camPos);
      this.dome.position.copy(this.camPos);
  
      // har 1 second mein check karo
      this.timer += delta;
      if (this.timer < 1) {
        return;
      }
      this.timer = 0;
      this.world.scene.traverse((o: Object3D) => {
        if (this.shouldHide(o)) {
          o.visible = false;
          console.log('[Backdrop] hid:', o.name || '(no name)', o.type);
        }
      });
    }
  }