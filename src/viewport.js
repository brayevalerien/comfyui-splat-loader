import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark";

const NODE_ID = "LoadSplatViewport";
const VIEW_HEIGHT = 360;
const EXT_TO_TYPE = {
  spz: SplatFileType.SPZ,
  ply: SplatFileType.PLY,
  splat: SplatFileType.SPLAT,
  ksplat: SplatFileType.KSPLAT,
};

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

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.camera.position.set(2, 1.5, 3);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;

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
    this.installCapture();
    this.layout();

    const initial = widget(node, "model_file")?.value;
    if (initial && initial !== "none") this.loadSplat(initial);
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
      gap: "6px",
      zIndex: "10",
    });

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load file";
    styleButton(loadBtn);
    loadBtn.onclick = () => this.pickFile();

    const flipBtn = document.createElement("button");
    flipBtn.textContent = "Flip up/down";
    styleButton(flipBtn);
    flipBtn.onclick = () => this.toggleFlip();

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset view";
    styleButton(resetBtn);
    resetBtn.onclick = () => {
      if (this.splatMesh) this.frameCamera(this.splatMesh);
    };

    bar.appendChild(loadBtn);
    bar.appendChild(flipBtn);
    bar.appendChild(resetBtn);
    this.container.appendChild(bar);
  }

  toggleFlip() {
    this.flipped = !this.flipped;
    if (this.splatMesh) {
      this.splatMesh.rotation.x = this.flipped ? Math.PI : 0;
      this.frameCamera(this.splatMesh);
    }
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
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
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

    const worldCenter = mesh.localToWorld(localCenter.clone());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.3;
    this.controls.target.copy(worldCenter);
    const dir = new THREE.Vector3(0.6, 0.4, 1).normalize();
    this.camera.position.copy(worldCenter).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 1e-3);
    this.camera.far = dist * 1000 + radius * 10;
    this.camera.updateProjectionMatrix();
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
      fov: this.camera.fov,
      aspect: this.camera.aspect,
      zoom: this.camera.zoom,
      cameraType: "perspective",
    };
  }

  // Render the current view at the node's width/height and upload as a PNG.
  // camera.aspect already equals width/height (see layout), so the capture
  // matches the framed preview.
  async capture() {
    const width = Math.max(1, Math.round(widget(this.node, "width")?.value ?? 1024));
    const height = Math.max(1, Math.round(widget(this.node, "height")?.value ?? 1024));

    this.renderer.setAnimationLoop(null);
    const dpr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    const blob = await new Promise((res) => this.renderer.domElement.toBlob(res, "image/png"));

    this.renderer.setPixelRatio(dpr);
    this.layout();
    this.renderer.setAnimationLoop(() => this.frame());

    const form = new FormData();
    form.append("image", blob, `capture_${Date.now()}.png`);
    form.append("type", "temp");
    form.append("subfolder", "splat_viewport");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    const data = await resp.json();
    const name = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
    return { image: `${name} [${data.type || "temp"}]`, camera_info: this.cameraInfo() };
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
