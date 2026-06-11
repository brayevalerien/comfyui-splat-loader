import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, dyno } from "@sparkjsdev/spark";

// A Spark object modifier that multiplies each gaussian's scales by a live uniform,
// scaling the splat footprint without moving centers (like RenderSplat's splat_scale).
function makeScaleModifier(scaleUniform) {
  const { dynoBlock, Gsplat, splitGsplat, combineGsplat, mul } = dyno;
  return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    let { scales } = splitGsplat(gsplat).outputs;
    scales = mul(scales, scaleUniform);
    return { gsplat: combineGsplat({ gsplat, scales }) };
  });
}

const NODE_ID = "LoadSplatViewport";
const VIEW_HEIGHT = 360;
const FRAME_MARGIN = 1.2;
// Spark's SplatFileType is a const enum (no runtime value when imported), so pass
// the literal type strings. spz/ply are content-sniffed, but splat/ksplat need this.
const EXT_TO_TYPE = { spz: "spz", ply: "ply", splat: "splat", ksplat: "ksplat" };
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

function ensureStyles() {
  if (document.getElementById("splatvp-styles")) return;
  const s = document.createElement("style");
  s.id = "splatvp-styles";
  s.textContent = `
    .splatvp-toolbar{position:absolute;top:8px;left:8px;z-index:10;display:flex;flex-direction:column;
      gap:2px;padding:4px;border-radius:10px;background:rgba(20,20,22,.72);backdrop-filter:blur(10px);
      -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.09);}
    .splatvp-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;appearance:none;
      border:0;background:transparent;color:#e6e6e6;border-radius:9999px;cursor:pointer;transition:background .12s ease;}
    .splatvp-btn:hover{background:rgba(255,255,255,.14);}
    .splatvp-btn:active{background:rgba(255,255,255,.22);}
    .splatvp-btn.active{background:rgba(255,255,255,.2);}
    .splatvp-btn .pi{font-size:15px;}
    .splatvp-sep{height:1px;background:rgba(255,255,255,.08);margin:3px 4px;}
    .splatvp-popup{position:absolute;left:54px;top:8px;z-index:11;display:grid;grid-template-columns:repeat(2,1fr);
      gap:2px;padding:6px;border-radius:10px;background:rgba(20,20,22,.72);backdrop-filter:blur(10px);
      -webkit-backdrop-filter:blur(10px);box-shadow:0 6px 20px rgba(0,0,0,.4);
      border:1px solid rgba(255,255,255,.09);font:11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
    .splatvp-popup button{appearance:none;border:0;background:transparent;color:#e6e6e6;padding:6px 12px;
      border-radius:6px;cursor:pointer;transition:background .12s ease;white-space:nowrap;}
    .splatvp-popup button:hover{background:rgba(255,255,255,.14);}
    .splatvp-bm{display:flex;flex-direction:column;gap:1px;min-width:178px;max-height:280px;overflow:auto;padding:6px;}
    .splatvp-bm-save{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;font-weight:600;
      background:rgba(255,255,255,.08)!important;border-radius:7px!important;padding:7px 10px!important;margin-bottom:5px;}
    .splatvp-bm-save:hover{background:rgba(255,255,255,.16)!important;}
    .splatvp-bm-row{display:flex;align-items:center;gap:2px;border-radius:7px;padding:1px;}
    .splatvp-bm-row:hover{background:rgba(255,255,255,.10);}
    .splatvp-bm-name{flex:1;padding:6px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;
      text-overflow:ellipsis;}
    .splatvp-bm-name input{width:100%;background:rgba(0,0,0,.45);color:#fff;border:1px solid rgba(255,255,255,.25);
      border-radius:5px;font:inherit;padding:3px 5px;outline:none;}
    .splatvp-bm-act{width:24px;height:24px;flex:0 0 auto;padding:0!important;display:flex;align-items:center;
      justify-content:center;color:#bbb;opacity:0;transition:opacity .12s ease,background .12s ease,color .12s ease;}
    .splatvp-bm-row:hover .splatvp-bm-act{opacity:1;}
    .splatvp-bm-act .pi{font-size:12px;}
    .splatvp-bm-edit:hover{background:rgba(255,255,255,.18)!important;color:#fff;}
    .splatvp-bm-del:hover{background:rgba(220,70,70,.28)!important;color:#f99;}
    .splatvp-bm-empty{color:#888;padding:6px 8px;font-style:italic;}`;
  document.head.appendChild(s);
}

class SplatViewport {
  constructor(node) {
    this.node = node;
    this.splatMesh = null;
    this.disposed = false;
    this.flipped = true; // 3DGS files are usually Y-down -> default 180 about X
    this.center = new THREE.Vector3();
    this.radius = 1;
    this.scaleUniform = dyno.dynoFloat(widget(node, "splat_scale")?.value ?? 1.0);

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
    this.controls.addEventListener("end", () => this.saveState());
    if (target) this.controls.target.copy(target);
  }

  // Persist the camera pose + flip into node.properties so the framing is restored
  // when the workflow is reloaded or the browser refreshed.
  saveState() {
    if (!this.node.properties) this.node.properties = {};
    this.node.properties.splatCamera = this.currentCameraState();
  }

  applyState(s) {
    try {
      if (s.flipped !== undefined) {
        this.flipped = s.flipped;
        if (this.splatMesh) this.splatMesh.rotation.x = this.flipped ? Math.PI : 0;
      }
      if (s.radius) this.radius = s.radius;
      if (s.up) this.camera.up.set(...s.up);
      if (s.target) this.controls.target.set(...s.target);
      if (s.position) this.camera.position.set(...s.position);
      this.camera.zoom = s.zoom ?? this.camera.zoom;
      this.camera.updateProjectionMatrix();
      this.layout();
      this.controls.update();
    } catch (e) {
      this.showError(`Failed to restore view: ${e.message || e}`);
    }
  }

  // Restored widget values (fov, camera_type, splat_scale) are not auto-applied to
  // the viewport on load; push them in after a workflow load.
  syncFromWidgets() {
    const fov = widget(this.node, "fov")?.value;
    if (fov) {
      this.perspCam.fov = fov;
      this.perspCam.updateProjectionMatrix();
    }
    const scale = widget(this.node, "splat_scale")?.value;
    if (scale) this.scaleUniform.value = scale;
    if (widget(this.node, "camera_type")?.value === "orthographic") this.setCameraType("orthographic");
    this.layout();
  }

  // Called after a saved workflow loads this node.
  onLoaded() {
    const mf = widget(this.node, "model_file")?.value;
    // Capture the saved pose before syncing widgets (which can move the camera).
    this.pendingState = mf && mf !== "none" ? this.node.properties?.splatCamera || null : null;
    this.syncFromWidgets();
    this.renderBookmarks();
    if (mf && mf !== "none") this.loadSplat(mf);
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
    // Right-drag pans the camera; stop the event before it bubbles to the global
    // contextmenu handler so the graph's context menu does not also open.
    this.container.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
  }

  buildToolbar() {
    ensureStyles();
    const bar = document.createElement("div");
    bar.className = "splatvp-toolbar";

    const iconBtn = (icon, title, onclick) => {
      const b = document.createElement("button");
      b.className = "splatvp-btn";
      b.title = title;
      b.innerHTML = `<i class="pi ${icon}"></i>`;
      b.onclick = onclick;
      return b;
    };
    const sep = () => {
      const d = document.createElement("div");
      d.className = "splatvp-sep";
      return d;
    };

    bar.appendChild(iconBtn("pi-upload", "Load file", () => { this.closeAllPopups(); this.pickFile(); }));
    bar.appendChild(iconBtn("pi-sort-alt", "Flip up/down", () => { this.closeAllPopups(); this.toggleFlip(); }));
    bar.appendChild(iconBtn("pi-refresh", "Reset view", () => {
      this.closeAllPopups();
      if (this.splatMesh) this.frameCamera(this.splatMesh);
    }));
    bar.appendChild(sep());

    this.viewsBtn = iconBtn("pi-compass", "Views", () => this.toggleViews());
    bar.appendChild(this.viewsBtn);
    this.bookmarksBtn = iconBtn("pi-bookmark", "Camera bookmarks", () => this.toggleBookmarks());
    bar.appendChild(this.bookmarksBtn);
    this.container.appendChild(bar);

    this.viewsPopup = document.createElement("div");
    this.viewsPopup.className = "splatvp-popup";
    this.viewsPopup.style.display = "none";
    for (const [name] of PRESETS) {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = () => {
        this.setPreset(name);
        this.toggleViews(false);
      };
      this.viewsPopup.appendChild(b);
    }
    this.container.appendChild(this.viewsPopup);

    this.bookmarksPopup = document.createElement("div");
    this.bookmarksPopup.className = "splatvp-popup splatvp-bm";
    this.bookmarksPopup.style.display = "none";
    this.bookmarksPopup.style.top = "40px";
    const save = document.createElement("button");
    save.className = "splatvp-bm-save";
    save.innerHTML = `<i class="pi pi-plus"></i> Save current view`;
    save.onclick = () => this.addBookmark();
    this.bookmarksPopup.appendChild(save);
    this.bookmarksList = document.createElement("div");
    this.bookmarksPopup.appendChild(this.bookmarksList);
    this.container.appendChild(this.bookmarksPopup);
    this.renderBookmarks();

    this.onDocClick = (e) => {
      if (!this.viewsPopup.contains(e.target) && !this.viewsBtn.contains(e.target)) this.toggleViews(false);
      if (!this.bookmarksPopup.contains(e.target) && !this.bookmarksBtn.contains(e.target)) this.toggleBookmarks(false);
    };
    document.addEventListener("pointerdown", this.onDocClick);
  }

  toggleViews(force) {
    const open = force ?? this.viewsPopup.style.display === "none";
    if (open) this.toggleBookmarks(false); // only one popup open at a time
    this.viewsPopup.style.display = open ? "grid" : "none";
    this.viewsBtn.classList.toggle("active", open);
  }

  toggleBookmarks(force) {
    const open = force ?? this.bookmarksPopup.style.display === "none";
    if (open) {
      this.toggleViews(false);
      this.renderBookmarks();
    }
    this.bookmarksPopup.style.display = open ? "flex" : "none";
    this.bookmarksBtn.classList.toggle("active", open);
  }

  closeAllPopups() {
    this.toggleViews(false);
    this.toggleBookmarks(false);
  }

  getBookmarks() {
    return this.node.properties?.splatBookmarks ?? [];
  }

  setBookmarks(bookmarks) {
    if (!this.node.properties) this.node.properties = {};
    this.node.properties.splatBookmarks = bookmarks;
  }

  currentCameraState() {
    const p = this.camera.position;
    const t = this.controls.target;
    const u = this.camera.up;
    return {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      up: [u.x, u.y, u.z],
      zoom: this.camera.zoom,
      radius: this.radius,
      flipped: this.flipped,
    };
  }

  addBookmark() {
    const bookmarks = this.getBookmarks();
    const used = new Set(bookmarks.map((b) => b.name));
    let n = 1;
    while (used.has(`View ${n}`)) n++; // smallest unused number, so no duplicates after deletes
    bookmarks.push({
      name: `View ${n}`,
      fov: widget(this.node, "fov")?.value,
      camera_type: widget(this.node, "camera_type")?.value,
      ...this.currentCameraState(),
    });
    this.setBookmarks(bookmarks);
    this.renderBookmarks();
  }

  applyBookmark(i) {
    const bm = this.getBookmarks()[i];
    if (!bm) return;
    const fovW = widget(this.node, "fov");
    if (fovW && bm.fov != null) {
      fovW.value = bm.fov;
      this.perspCam.fov = bm.fov;
      this.perspCam.updateProjectionMatrix();
    }
    const ctW = widget(this.node, "camera_type");
    if (ctW && bm.camera_type) {
      ctW.value = bm.camera_type;
      this.setCameraType(bm.camera_type);
    }
    this.applyState(bm);
    this.saveState();
    this.toggleBookmarks(false); // close after going to a view
  }

  deleteBookmark(i) {
    const bookmarks = this.getBookmarks();
    bookmarks.splice(i, 1);
    this.setBookmarks(bookmarks);
    this.renderBookmarks();
  }

  renameBookmark(i, name) {
    const bookmarks = this.getBookmarks();
    if (!bookmarks[i]) return;
    bookmarks[i].name = name || bookmarks[i].name;
    this.setBookmarks(bookmarks);
    this.renderBookmarks();
  }

  renderBookmarks() {
    if (!this.bookmarksList) return;
    const bookmarks = this.getBookmarks();
    this.bookmarksList.replaceChildren();
    if (!bookmarks.length) {
      const empty = document.createElement("div");
      empty.className = "splatvp-bm-empty";
      empty.textContent = "No saved views yet.";
      this.bookmarksList.appendChild(empty);
      return;
    }
    bookmarks.forEach((bm, i) => {
      const row = document.createElement("div");
      row.className = "splatvp-bm-row";
      const name = document.createElement("span");
      name.className = "splatvp-bm-name";
      name.textContent = bm.name;
      name.title = "Click to go to this view";
      name.onclick = () => this.applyBookmark(i);
      const edit = document.createElement("button");
      edit.className = "splatvp-btn splatvp-bm-act splatvp-bm-edit";
      edit.innerHTML = `<i class="pi pi-pencil"></i>`;
      edit.title = "Rename";
      edit.onclick = (e) => {
        e.stopPropagation();
        this.startRename(name, i);
      };
      const del = document.createElement("button");
      del.className = "splatvp-btn splatvp-bm-act splatvp-bm-del";
      del.innerHTML = `<i class="pi pi-times"></i>`;
      del.title = "Delete";
      del.onclick = (e) => {
        e.stopPropagation();
        this.deleteBookmark(i);
      };
      row.appendChild(name);
      row.appendChild(edit);
      row.appendChild(del);
      this.bookmarksList.appendChild(row);
    });
  }

  startRename(nameEl, i) {
    const input = document.createElement("input");
    input.value = this.getBookmarks()[i]?.name ?? "";
    const commit = () => this.renameBookmark(i, input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") this.renderBookmarks();
      e.stopPropagation();
    };
    input.onclick = (e) => e.stopPropagation(); // don't trigger "go to view" on the parent
    input.onblur = commit;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
  }

  toggleFlip() {
    this.flipped = !this.flipped;
    if (!this.splatMesh) return;
    // Flip in place: keep the camera's angle/distance/zoom, just re-point at the
    // splat's new center (the 180 about X moves it) so the view does not reset.
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.splatMesh.rotation.x = this.flipped ? Math.PI : 0;
    this.splatMesh.updateMatrixWorld(true);
    if (this.localCenter) {
      const center = this.splatMesh.localToWorld(this.localCenter.clone());
      this.center.copy(center);
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(offset);
    }
    this.controls.update();
    this.saveState();
  }

  setPreset(name) {
    const [, dir, up] = PRESETS.find(([n]) => n === name);
    const dist = this.camera.position.distanceTo(this.controls.target) || this.radius * 3 || 3;
    this.camera.up.set(...up);
    this.camera.position.copy(this.controls.target).addScaledVector(new THREE.Vector3(...dir), dist);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.saveState();
  }

  setCameraType(type) {
    const next = type === "orthographic" ? this.orthoCam : this.perspCam;
    if (next === this.camera) return;
    const pos = this.camera.position.clone();
    const up = this.camera.up.clone();
    const target = this.controls.target.clone();
    // Match the apparent scale across projections (via zoom, no camera move) so only
    // the projection type changes, not the framing.
    const dist = Math.max(pos.distanceTo(target), 1e-6);
    const halfFov = ((this.perspCam.fov * Math.PI) / 180) / 2;
    const orthoTop = this.radius * FRAME_MARGIN;
    if (next === this.orthoCam) {
      const perspHalfH = (dist * Math.tan(halfFov)) / (this.perspCam.zoom || 1);
      next.zoom = orthoTop / Math.max(perspHalfH, 1e-6);
    } else {
      const orthoHalfH = orthoTop / (this.orthoCam.zoom || 1);
      next.zoom = (dist * Math.tan(halfFov)) / Math.max(orthoHalfH, 1e-6);
    }
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
        this.showError(e.message || "Upload failed");
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
    if (!resp.ok) {
      const why = resp.status === 413
        ? "file exceeds the server upload limit (raise it with --max-upload-size, in MB)"
        : `server returned ${resp.status} ${resp.statusText}`;
      throw new Error(`Upload of ${file.name} failed: ${why}`);
    }
    const data = await resp.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  showError(message) {
    console.error("[splat-loader]", message);
    clearTimeout(this._errorTimer);
    if (!this.errorBanner) {
      this.errorBanner = document.createElement("div");
      Object.assign(this.errorBanner.style, {
        position: "absolute", bottom: "8px", left: "8px", right: "8px", zIndex: "12",
        padding: "8px 10px", borderRadius: "6px", background: "rgba(150,30,30,.92)", color: "#fff",
        font: "12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", textAlign: "center",
      });
      this.container.appendChild(this.errorBanner);
    }
    this.errorBanner.textContent = message;
    this.errorBanner.style.display = "block";
    this._errorTimer = setTimeout(() => { if (this.errorBanner) this.errorBanner.style.display = "none"; }, 6000);
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
        this.saveState();
      };
    }
    const ss = widget(this.node, "splat_scale");
    if (ss) {
      const prev = ss.callback;
      ss.callback = (value) => {
        prev?.call(ss, value);
        this.scaleUniform.value = value;
        // The modifier bakes the splats during generation, so re-run it.
        this.splatMesh?.updateVersion();
      };
    }
  }

  async loadSplat(modelFile) {
    if (modelFile === this.activeFile) return; // avoid a redundant reload wiping a restored view
    this.activeFile = modelFile;
    if (this.splatMesh) {
      this.scene.remove(this.splatMesh);
      this.splatMesh.dispose?.();
      this.splatMesh = null;
    }
    try {
      const ext = modelFile.split(".").pop().toLowerCase();
      // Fetch the bytes ourselves: Spark ignores fileType on the url path and can't
      // sniff .splat/.ksplat from our extension-less /view URL. fileBytes honors fileType.
      const resp = await fetch(splatFileURL(modelFile));
      if (!resp.ok) throw new Error(`server returned ${resp.status} ${resp.statusText}`);
      const fileBytes = new Uint8Array(await resp.arrayBuffer());
      const mesh = new SplatMesh({ fileBytes, fileType: EXT_TO_TYPE[ext], fileName: modelFile });
      mesh.rotation.x = this.flipped ? Math.PI : 0;
      mesh.objectModifier = makeScaleModifier(this.scaleUniform);
      this.splatMesh = mesh;
      this.scene.add(mesh);
      await mesh.initialized;
      mesh.updateGenerator();
      if (this.pendingState) {
        this.frameCamera(mesh, true); // compute center/radius without moving the camera
        this.applyState(this.pendingState);
        this.pendingState = null;
      } else {
        this.frameCamera(mesh);
      }
    } catch (e) {
      this.activeFile = null;
      this.showError(`Failed to load ${modelFile}: ${e.message || e}`);
    }
  }

  // Frame on the dense core. Scene splats often have ~1% floater splats far from
  // the subject that blow up the true bounding box; a percentile radius ignores them.
  frameCamera(mesh, computeOnly = false) {
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

    this.localCenter = localCenter.clone();
    this.center.copy(mesh.localToWorld(localCenter.clone()));
    this.radius = radius;
    const fov = (this.perspCam.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * FRAME_MARGIN;
    for (const cam of [this.perspCam, this.orthoCam]) {
      cam.near = Math.max(dist / 1000, 1e-3);
      cam.far = dist * 1000 + radius * 10;
    }
    // computeOnly: keep center/radius/near/far but leave the camera where it is
    // (used when restoring a saved pose).
    if (computeOnly) {
      this.layout();
      return;
    }
    this.controls.target.copy(this.center);
    const dir = new THREE.Vector3(0.6, 0.4, 1).normalize();
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.zoom = 1;
    this.layout();
    this.controls.update();
    this.saveState();
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
    if (this.onDocClick) document.removeEventListener("pointerdown", this.onDocClick);
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

  async loadedGraphNode(node) {
    if (node.type === NODE_ID || node.comfyClass === NODE_ID) node._splatViewport?.onLoaded();
  },
});
