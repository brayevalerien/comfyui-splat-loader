import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark";

const NODE_ID = "LoadSplatViewport";
const VIEW_HEIGHT = 360;
const FRAME_MARGIN = 1.2;
const EXT_TO_TYPE = {
  spz: SplatFileType.SPZ,
  ply: SplatFileType.PLY,
  splat: SplatFileType.SPLAT,
  ksplat: SplatFileType.KSPLAT,
};
// name, direction from target to camera, camera up (Z-up for top/bottom to avoid gimbal).
const PRESETS = [
  ["Front", [0, 0, 1], [0, 1, 0]],
  ["Back", [0, 0, -1], [0, 1, 0]],
  ["Left", [-1, 0, 0], [0, 1, 0]],
  ["Right", [1, 0, 0], [0, 1, 0]],
  ["Top", [0, 1, 0], [0, 0, -1]],
  ["Bottom", [0, -1, 0], [0, 0, 1]],
];

// Map a ComfyUI input-relative path ("3d/foo.spz") to a /view URL.
function splatFileURL(modelFile) {
  const idx = modelFile.lastIndexOf("/");
  const subfolder = idx >= 0 ? modelFile.slice(0, idx) : "";
  const filename = idx >= 0 ? modelFile.slice(idx + 1) : modelFile;
  const params = new URLSearchParams({ filename, type: "input", subfolder });
  return api.apiURL(`/view?${params}`);
}

function widget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function styleButton(btn) {
  Object.assign(btn.style, {
    font: "12px sans-serif",
    color: "#eee",
    background: "rgba(40,40,40,0.85)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "4px",
    padding: "3px 8px",
    cursor: "pointer",
  });
}

class SplatViewport {
  constructor(node) {
    this.node = node;
    this.splatMesh = null;
    this.disposed = false;
    this.flipped = true; // 3DGS files are usually Y-down -> default 180 about X
    this.center = new THREE.Vector3();
    this.radius = 1;

    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      width: "100%",
      height: `${VIEW_HEIGHT}px`,
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "6px",
      overflow: "hidden",
      background: "#1a1a1a",
    });

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    const fov = widget(node, "fov")?.value ?? 35;
    this.perspCam = new THREE.PerspectiveCamera(fov, 1, 0.01, 1000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    this.camera = this.perspCam;
    this.camera.position.set(2, 1.5, 3);

    this.rebuildControls();
    this.captureCanvasEvents();
    this.buildToolbar();

    this.widget = node.addDOMWidget("splat_viewport", "splat_viewport", this.container, {
      serialize: false,
      hideOnZoom: false,
    });
    this.widget.computeSize = () => [node.size?.[0] ?? 320, VIEW_HEIGHT + 8];

    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.container);

    this.renderer.setAnimationLoop(() => this.frame());

    this.hookFileWidget();
    this.hookSizeWidgets();
    this.hookCameraWidgets();
    this.installCapture();
    if (widget(node, "camera_type")?.value === "orthographic") this.setCameraType("orthographic");
    this.layout();

    const initial = widget(node, "model_file")?.value;
    if (initial && initial !== "none") this.loadSplat(initial);
  }

  rebuildControls() {
    const target = this.controls?.target?.clone();
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    if (target) this.controls.target.copy(target);
  }

  // The frontend has a global handler that forwards wheel events to the graph zoom,
  // unless the wheel target is inside a [data-capture-wheel="true"] element that
  // contains the focused element. Mark the viewport and keep it focused so
  // OrbitControls receives the wheel instead of the graph.
  captureCanvasEvents() {
    this.container.setAttribute("data-capture-wheel", "true");
    this.container.tabIndex = 0;
    this.container.style.outline = "none";
    const focus = () => this.container.focus({ preventScroll: true });
    this.container.addEventListener("pointerenter", focus);
    this.container.addEventListener("pointerdown", focus);
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  buildToolbar() {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      zIndex: "10",
    });

    const row = (...buttons) => {
      const r = document.createElement("div");
      Object.assign(r.style, { display: "flex", gap: "6px", flexWrap: "wrap" });
      buttons.forEach((b) => r.appendChild(b));
      return r;
    };
    const button = (label, onclick) => {
      const b = document.createElement("button");
      b.textContent = label;
      styleButton(b);
      b.onclick = onclick;
      return b;
    };

    const actions = row(
      button("Load file", () => this.pickFile()),
      button("Flip up/down", () => this.toggleFlip()),
      button("Reset view", () => this.splatMesh && this.frameCamera(this.splatMesh)),
    );
    const presets = row(...PRESETS.map(([name]) => button(name, () => this.setPreset(name))));

    bar.appendChild(actions);
    bar.appendChild(presets);
    this.container.appendChild(bar);
  }

  toggleFlip() {
    this.flipped = !this.flipped;
    if (this.splatMesh) {
      this.splatMesh.rotation.x = this.flipped ? Math.PI : 0;
      this.frameCamera(this.splatMesh);
    }
  }

  setPreset(name) {
    const [, dir, up] = PRESETS.find(([n]) => n === name);
    const dist = this.camera.position.distanceTo(this.controls.target) || this.radius * 3 || 3;
    this.camera.up.set(...up);
    this.camera.position.copy(this.controls.target).addScaledVector(new THREE.Vector3(...dir), dist);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setCameraType(type) {
    const next = type === "orthographic" ? this.orthoCam : this.perspCam;
    if (next === this.camera) return;
    const pos = this.camera.position.clone();
    const up = this.camera.up.clone();
    const target = this.controls.target.clone();
    this.camera = next;
    this.camera.position.copy(pos);
    this.camera.up.copy(up);
    this.rebuildControls();
    this.controls.target.copy(target);
    this.layout();
    this.controls.update();
  }

  pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".spz,.ply,.splat,.ksplat";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const rel = await this.uploadSplatFile(file);
        const fw = widget(this.node, "model_file");
        if (fw) {
          const opts = fw.options.values;
          if (!opts.includes(rel)) opts.push(rel);
          fw.value = rel;
          fw.callback?.(rel);
        } else {
          this.loadSplat(rel);
        }
      } catch (e) {
        console.error("[splat-loader] upload failed", e);
      }
    };
    input.click();
  }

  async uploadSplatFile(file) {
    const form = new FormData();
    form.append("image", file, file.name);
    form.append("type", "input");
    form.append("subfolder", "3d");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    const data = await resp.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  outputAspect() {
    const w = widget(this.node, "width")?.value || 1;
    const h = widget(this.node, "height")?.value || 1;
    return w / h;
  }

  applyAspect(aspect) {
    if (this.camera.isOrthographicCamera) {
      const h = this.radius * FRAME_MARGIN;
      const w = h * aspect;
      this.camera.left = -w;
      this.camera.right = w;
      this.camera.top = h;
      this.camera.bottom = -h;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  // Letterbox the canvas inside the fixed-height box so its aspect matches the
  // output width/height: what you frame is what gets captured.
  layout() {
    const cw = this.container.clientWidth || 1;
    const ch = this.container.clientHeight || 1;
    const aspect = this.outputAspect();
    let w = cw;
    let h = cw / aspect;
    if (h > ch) {
      h = ch;
      w = ch * aspect;
    }
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.renderer.setSize(w, h, false);
    this.applyAspect(aspect);
  }

  frame() {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  hookFileWidget() {
    const fw = widget(this.node, "model_file");
    if (!fw) return;
    const prev = fw.callback;
    fw.callback = (value) => {
      prev?.call(fw, value);
      if (value && value !== "none") this.loadSplat(value);
    };
  }

  hookSizeWidgets() {
    for (const name of ["width", "height"]) {
      const sw = widget(this.node, name);
      if (!sw) continue;
      const prev = sw.callback;
      sw.callback = (value) => {
        prev?.call(sw, value);
        this.layout();
      };
    }
  }

  hookCameraWidgets() {
    const fw = widget(this.node, "fov");
    if (fw) {
      const prev = fw.callback;
      fw.callback = (value) => {
        prev?.call(fw, value);
        this.perspCam.fov = value;
        this.perspCam.updateProjectionMatrix();
      };
    }
    const cw = widget(this.node, "camera_type");
    if (cw) {
      const prev = cw.callback;
      cw.callback = (value) => {
        prev?.call(cw, value);
        this.setCameraType(value);
      };
    }
  }

  async loadSplat(modelFile) {
    if (this.splatMesh) {
      this.scene.remove(this.splatMesh);
      this.splatMesh.dispose?.();
      this.splatMesh = null;
    }
    try {
      const ext = modelFile.split(".").pop().toLowerCase();
      const mesh = new SplatMesh({ url: splatFileURL(modelFile), fileType: EXT_TO_TYPE[ext] });
      mesh.rotation.x = this.flipped ? Math.PI : 0;
      this.splatMesh = mesh;
      this.scene.add(mesh);
      await mesh.initialized;
      this.frameCamera(mesh);
    } catch (e) {
      console.error("[splat-loader] failed to load", modelFile, e);
    }
  }

  // Frame on the dense core. Scene splats often have ~1% floater splats far from
  // the subject that blow up the true bounding box; a percentile radius ignores them.
  frameCamera(mesh) {
    mesh.updateMatrixWorld(true);
    const ps = mesh.packedSplats;
    const num = ps?.numSplats || 0;

    let localCenter;
    let radius;
    if (num > 0 && ps.getSplat) {
      const stride = Math.max(1, Math.floor(num / 40000));
      const xs = [];
      const ys = [];
      const zs = [];
      for (let i = 0; i < num; i += stride) {
        const s = ps.getSplat(i);
        if (s.opacity !== undefined && s.opacity < 0.05) continue;
        xs.push(s.center.x);
        ys.push(s.center.y);
        zs.push(s.center.z);
      }
      const median = (arr) => {
        const a = arr.slice().sort((p, q) => p - q);
        return a.length ? a[a.length >> 1] : 0;
      };
      const cx = median(xs);
      const cy = median(ys);
      const cz = median(zs);
      const rs = xs.map((x, i) => Math.hypot(x - cx, ys[i] - cy, zs[i] - cz)).sort((a, b) => a - b);
      radius = Math.max(rs[Math.floor(rs.length * 0.9)] || 1e-3, 1e-3);
      localCenter = new THREE.Vector3(cx, cy, cz);
    } else {
      const box = mesh.getBoundingBox();
      localCenter = box.getCenter(new THREE.Vector3());
      radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    }

    this.center.copy(mesh.localToWorld(localCenter.clone()));
    this.radius = radius;
    const fov = (this.perspCam.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * FRAME_MARGIN;
    this.controls.target.copy(this.center);
    const dir = new THREE.Vector3(0.6, 0.4, 1).normalize();
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    for (const cam of [this.perspCam, this.orthoCam]) {
      cam.near = Math.max(dist / 1000, 1e-3);
      cam.far = dist * 1000 + radius * 10;
    }
    this.camera.zoom = 1;
    this.layout();
    this.controls.update();
  }

  cameraInfo() {
    const p = this.camera.position;
    const t = this.controls.target;
    const q = this.camera.quaternion;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
      fov: this.perspCam.fov,
      aspect: this.outputAspect(),
      zoom: this.camera.zoom,
      cameraType: this.camera.isOrthographicCamera ? "orthographic" : "perspective",
    };
  }

  async uploadFrame(blob, index) {
    const form = new FormData();
    form.append("image", blob, `capture_${Date.now()}_${index}.png`);
    form.append("type", "temp");
    form.append("subfolder", "splat_viewport");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    const data = await resp.json();
    const name = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
    return `${name} [${data.type || "temp"}]`;
  }

  // Render the framed view at the node's width/height and upload as PNG(s).
  // camera aspect already equals width/height (see layout), so the capture
  // matches the framed preview. frames > 1 orbits a full turn for a batch.
  async capture() {
    const width = Math.max(1, Math.round(widget(this.node, "width")?.value ?? 1024));
    const height = Math.max(1, Math.round(widget(this.node, "height")?.value ?? 1024));
    const framesVal = Math.round(widget(this.node, "frames")?.value ?? 1);
    const n = Math.max(1, Math.abs(framesVal));
    const sign = framesVal < 0 ? -1 : 1;

    this.renderer.setAnimationLoop(null);
    const dpr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.applyAspect(width / height);

    const target = this.controls.target.clone();
    const base = this.camera.position.clone();
    const up = this.camera.up.clone();
    const baseInfo = this.cameraInfo();
    const names = [];
    try {
      for (let f = 0; f < n; f++) {
        if (n > 1) {
          const a = (sign * 2 * Math.PI * f) / n;
          const offset = base.clone().sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
          this.camera.position.copy(target).add(offset);
          this.camera.up.copy(up);
          this.camera.lookAt(target);
          this.camera.updateMatrixWorld(true);
        }
        this.renderer.render(this.scene, this.camera);
        const blob = await new Promise((res) => this.renderer.domElement.toBlob(res, "image/png"));
        names.push(await this.uploadFrame(blob, f));
      }
    } finally {
      this.camera.position.copy(base);
      this.camera.up.copy(up);
      this.renderer.setPixelRatio(dpr);
      this.layout();
      this.controls.update();
      this.renderer.setAnimationLoop(() => this.frame());
    }
    return { images: names, camera_info: baseInfo };
  }

  installCapture() {
    const vw = widget(this.node, "viewport");
    if (!vw) return;
    vw.hidden = true;
    vw.computeSize = () => [0, -4];
    vw.serializeValue = async () => {
      if (!this.splatMesh) return "";
      try {
        return JSON.stringify(await this.capture());
      } catch (e) {
        console.error("[splat-loader] capture failed", e);
        return "";
      }
    };
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.splatMesh?.dispose?.();
    this.renderer.dispose();
  }
}

app.registerExtension({
  name: "comfyui.splat.loader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      this._splatViewport = new SplatViewport(this);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._splatViewport?.dispose();
      onRemoved?.apply(this, arguments);
    };
  },
});
