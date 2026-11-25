// Dotquill viewer: read-only gallery with live updates, playback and export.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^{|}~";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

const state = {
  assets: [],
  name: null,
  doc: null,
  rgb: [],
  frames: [], // Int16Array composites
  bitmaps: [], // 1× canvases
  frame: 0,
  zoom: 8,
  fit: true,
  playing: false,
  timer: 0,
  hidden: new Set(),
  hot: -1,
};

// ---------- utils ----------

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer = 0;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 5000 : 1800);
}

// ---------- decoding ----------

function buildFrames() {
  const d = state.doc;
  const W = d.width;
  const H = d.height;
  state.rgb = d.palette.map(hexToRgb);
  state.frames = d.frames.map((fr) => {
    const out = new Int16Array(W * H).fill(-1);
    for (const layer of d.layers) {
      if (!layer.visible || state.hidden.has(layer.name)) continue;
      const rows = fr.cels[layer.name];
      if (!rows) continue;
      for (let y = 0; y < H; y++) {
        const row = rows[y] || "";
        for (let x = 0; x < W; x++) {
          const c = row[x];
          if (c && c !== ".") {
            const v = LOOKUP.get(c);
            if (v !== undefined) out[y * W + x] = v;
          }
        }
      }
    }
    return out;
  });
  state.bitmaps = state.frames.map((idx) => {
    const c = el("canvas", { width: W, height: H });
    const g = c.getContext("2d");
    const img = g.createImageData(W, H);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      if (v < 0) continue;
      const [r, gg, b] = state.rgb[v];
      img.data.set([r, gg, b, 255], i * 4);
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// ---------- rendering ----------

function reps() {
  return $("tile").checked ? 3 : 1;
}

function fitZoom() {
  const d = state.doc;
  const wrap = $("canvasWrap");
  const avail = Math.min((wrap.clientWidth - 56) / (d.width * reps()), (wrap.clientHeight - 56) / (d.height * reps()));
  return Math.max(1, Math.min(48, Math.floor(avail)));
}

function render() {
  const d = state.doc;
  $("empty").hidden = !!d;
  canvas.hidden = !d;
  if (!d || state.bitmaps.length !== d.frames.length) return;
  if (state.fit) state.zoom = fitZoom();
  const z = state.zoom;
  const R = reps();
  const W = d.width;
  const H = d.height;
  const cw = W * R * z;
  const ch = H * R * z;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  ctx.imageSmoothingEnabled = false;
  const bg = $("bg").value;
  if (bg === "checker") {
    const s = Math.max(4, Math.min(16, Math.floor(z / 2) || 4));
    ctx.fillStyle = "#3a3a44";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#464652";
    for (let y = 0; y < ch; y += s) for (let x = (y / s) % 2 ? 0 : s; x < cw; x += s * 2) ctx.fillRect(x, y, s, s);
  } else {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
  }
  const n = d.frames.length;
  const drawFrame = (f) => {
    for (let ry = 0; ry < R; ry++) for (let rx = 0; rx < R; rx++) ctx.drawImage(state.bitmaps[f], rx * W * z, ry * H * z, W * z, H * z);
  };
  if ($("onion").checked && n > 1 && !state.playing) {
    ctx.globalAlpha = 0.3;
    drawFrame((state.frame - 1 + n) % n);
    ctx.globalAlpha = 1;
  }
  drawFrame(state.frame);
  if (state.hot >= 0) {
    // Highlight pixels of the hovered palette color.
    ctx.strokeStyle = "rgba(255,138,76,0.95)";
    ctx.lineWidth = Math.max(1, Math.floor(z / 8));
    const idx = state.frames[state.frame];
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] !== state.hot) continue;
      const x = (i % W) * z;
      const y = Math.floor(i / W) * z;
      ctx.strokeRect(x + 0.5, y + 0.5, z - 1, z - 1);
    }
  }
  if ($("grid").checked && z >= 6) {
    ctx.lineWidth = 1;
    for (let x = 1; x < W * R; x++) {
      ctx.strokeStyle = x % 8 === 0 ? "rgba(110,200,255,0.35)" : "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(x * z + 0.5, 0);
      ctx.lineTo(x * z + 0.5, ch);
      ctx.stroke();
    }
    for (let y = 1; y < H * R; y++) {
      ctx.strokeStyle = y % 8 === 0 ? "rgba(110,200,255,0.35)" : "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(0, y * z + 0.5);
      ctx.lineTo(cw, y * z + 0.5);
      ctx.stroke();
    }
  }
  if (R === 3) {
    ctx.strokeStyle = "rgba(255,138,76,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(W * z + 0.5, H * z + 0.5, W * z - 1, H * z - 1);
  }
  $("zoomLabel").textContent = `${z}×`;
  for (const b of $("frames").children) b.classList.toggle("active", Number(b.dataset.f) === state.frame);
}

// ---------- panels ----------

function renderAssetList() {
  const q = $("search").value.trim().toLowerCase();
  const items = state.assets.filter((a) => a.name.toLowerCase().includes(q));
  $("noAssets").hidden = state.assets.length > 0;
  $("assets").replaceChildren(
    ...items.map((a) => {
      const slash = a.name.lastIndexOf("/");
      const nameEl = el("div", { className: "name", title: a.name }, [
        slash >= 0 ? el("span", { className: "dir", textContent: a.name.slice(0, slash + 1) }) : null,
        a.name.slice(slash + 1),
      ]);
      const sub = a.error
        ? "unreadable"
        : `${a.width}×${a.height} · ${a.frames} frame${a.frames > 1 ? "s" : ""}${a.updated ? ` · ${relTime(a.updated)}` : ""}`;
      const li = el("li", { className: a.name === state.name ? "active" : "" }, [
        el("img", { src: `/api/thumb?name=${encodeURIComponent(a.name)}&v=${encodeURIComponent(a.updated || "")}`, alt: "", loading: "lazy" }),
        el("div", {}, [nameEl, el("div", { className: "sub", textContent: sub })]),
      ]);
      li.dataset.name = a.name;
      li.onclick = () => select(a.name);
      return li;
    }),
  );
}

function buildTimeline() {
  const d = state.doc;
  const sel = $("tagSel");
  const prev = sel.value;
  sel.replaceChildren(
    el("option", { value: "", textContent: "All frames" }),
    ...d.tags.map((t) => el("option", { value: t.name, textContent: `${t.name} (${t.from}–${t.to})` })),
  );
  sel.value = d.tags.some((t) => t.name === prev) ? prev : "";
  $("frames").replaceChildren(
    ...state.bitmaps.map((bmp, i) => {
      const c = el("canvas", { width: d.width, height: d.height });
      c.getContext("2d").drawImage(bmp, 0, 0);
      const b = el("button", { title: `Frame ${i}` }, [c, el("span", { textContent: `${i} · ${d.frames[i].duration}ms` })]);
      b.dataset.f = i;
      b.onclick = () => {
        play(false);
        state.frame = i;
        render();
      };
      return b;
    }),
  );
  $("play").disabled = d.frames.length < 2;
}

function renderInspector() {
  const d = state.doc;
  if (!d) return;
  const used = new Map();
  for (const fr of state.frames) for (const v of fr) if (v >= 0) used.set(v, (used.get(v) || 0) + 1);
  const total = d.frames.reduce((s, f) => s + f.duration, 0);
  const rows = [
    ["Name", state.name],
    ["Size", `${d.width} × ${d.height}`],
    ["Frames", d.frames.length > 1 ? `${d.frames.length} · ${(total / 1000).toFixed(2)}s loop` : "1"],
    ["Colors", `${used.size} used of ${d.palette.length}`],
    ["Updated", relTime(d.updated)],
  ];
  if (d.notes) rows.push(["Notes", d.notes]);
  $("meta").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));

  $("layers").replaceChildren(
    ...[...d.layers].reverse().map((l) => {
      const cb = el("input", { type: "checkbox", checked: l.visible && !state.hidden.has(l.name), disabled: !l.visible });
      cb.onchange = () => {
        if (cb.checked) state.hidden.delete(l.name);
        else state.hidden.add(l.name);
        buildFrames();
        buildTimeline();
        renderInspector();
        render();
      };
      return el("li", {}, [el("label", { className: "check" }, [cb, l.visible ? l.name : `${l.name} (hidden in file)`])]);
    }),
  );

  $("paletteName").textContent = d.paletteName || "custom";
  $("palette").replaceChildren(
    ...d.palette.map((hex, i) => {
      const [r, g, b] = hexToRgb(hex);
      const light = 0.299 * r + 0.587 * g + 0.114 * b > 140;
      const count = used.get(i) || 0;
      const sw = el("div", {
        className: `swatch${count ? "" : " unused"}`,
        textContent: ALPHABET[i],
        title: `"${ALPHABET[i]}" ${hex} · ${count} px`,
      });
      sw.style.background = hex;
      sw.style.setProperty("--sw-ink", light ? "rgba(0,0,0,.6)" : "rgba(255,255,255,.75)");
      sw.onmouseenter = () => {
        state.hot = i;
        render();
      };
      sw.onmouseleave = () => {
        state.hot = -1;
        render();
      };
      return sw;
    }),
  );
}

// ---------- actions ----------

async function loadAssets() {
  const r = await getJSON("/api/assets");
  state.assets = r.assets;
  $("ws").textContent = r.workspace;
  renderAssetList();
  return r;
}

async function select(name, { refresh = false } = {}) {
  try {
    const doc = await getJSON(`/api/asset?name=${encodeURIComponent(name)}`);
    const switched = state.name !== name;
    if (switched) play(false); // stop before swapping docs: play() redraws with the current bitmaps
    state.name = name;
    state.doc = doc;
    if (switched) {
      state.frame = 0;
      state.hidden.clear();
      state.fit = true;
      history.replaceState(null, "", `#${encodeURIComponent(name)}`);
    } else {
      state.frame = Math.min(state.frame, doc.frames.length - 1);
    }
    buildFrames();
    buildTimeline();
    renderInspector();
    renderAssetList();
    render();
    if (refresh) {
      const wrap = $("canvasWrap");
      wrap.classList.add("updated");
      setTimeout(() => wrap.classList.remove("updated"), 600);
    }
  } catch (e) {
    if (!refresh) return toast(e.message, "error");
    // The open asset disappeared (deleted or renamed).
    await loadAssets().catch(() => {});
    if (state.name === name && !state.assets.some((a) => a.name === name)) clearSelection();
  }
}

function clearSelection() {
  play(false);
  Object.assign(state, { name: null, doc: null, frames: [], bitmaps: [], frame: 0 });
  for (const id of ["meta", "layers", "palette", "frames", "tagSel"]) $(id).replaceChildren();
  $("paletteName").textContent = "";
  history.replaceState(null, "", location.pathname);
  renderAssetList();
  render();
}

function range() {
  const t = state.doc.tags.find((x) => x.name === $("tagSel").value);
  return t ? [t.from, t.to] : [0, state.doc.frames.length - 1];
}

function play(on) {
  state.playing = on && !!state.doc && state.doc.frames.length > 1;
  $("play").textContent = state.playing ? "❚❚" : "▶";
  clearTimeout(state.timer);
  if (state.playing) tick();
  else if (state.doc) render();
}

function tick() {
  const [a, b] = range();
  if (state.frame < a || state.frame > b) state.frame = a;
  render();
  state.timer = setTimeout(() => {
    if (!state.playing) return;
    const [a2, b2] = range();
    state.frame = state.frame >= b2 ? a2 : state.frame + 1;
    tick();
  }, state.doc.frames[state.frame].duration);
}

function setZoom(z) {
  if (!state.doc) return;
  state.fit = false;
  state.zoom = Math.max(1, Math.min(48, z));
  render();
}

async function doExport(mode) {
  if (!state.name) return;
  const body = {
    name: state.name,
    format: $("expFormat").value,
    scale: Number($("expScale").value),
    frame: state.frame,
    tag: $("tagSel").value || undefined,
    mode,
  };
  try {
    const r = await getJSON("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (mode === "save") {
      $("expResult").textContent = `Saved: ${r.paths.join(", ")}`;
      return;
    }
    for (const f of r.files) {
      const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bin], { type: f.mime }));
      const a = el("a", { href: url, download: f.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    $("expResult").textContent = `Downloaded: ${r.files.map((f) => f.name).join(", ")}`;
  } catch (e) {
    toast(e.message, "error");
  }
}

// ---------- live updates ----------

let listTimer = 0;
function connect() {
  const es = new EventSource("/api/events");
  const status = $("status");
  es.onopen = () => {
    status.classList.add("on");
    status.title = "Live updates: connected";
  };
  es.onerror = () => {
    status.classList.remove("on");
    status.title = "Live updates: disconnected (retrying)";
  };
  es.addEventListener("change", (e) => {
    const { name } = JSON.parse(e.data);
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => {
      await loadAssets().catch(() => {});
      const li = [...$("assets").children].find((x) => x.dataset.name === name);
      li?.classList.add("flash");
    }, 80);
    if (name === state.name) select(name, { refresh: true });
  });
  es.addEventListener("focus", (e) => {
    const { name } = JSON.parse(e.data);
    if ($("follow").checked && name && name !== state.name) select(name);
  });
}

// ---------- wiring ----------

$("search").oninput = renderAssetList;
$("zoomIn").onclick = () => setZoom(state.zoom + (state.zoom >= 8 ? 2 : 1));
$("zoomOut").onclick = () => setZoom(state.zoom - (state.zoom > 8 ? 2 : 1));
$("zoomLabel").onclick = () => {
  state.fit = true;
  render();
};
for (const id of ["grid", "onion", "bg", "tile"]) $(id).onchange = render;
window.addEventListener("hashchange", () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name && name !== state.name) select(name);
});
$("play").onclick = () => play(!state.playing);
$("tagSel").onchange = () => {
  const [a] = range();
  state.frame = a;
  render();
};
$("expDownload").onclick = () => doExport("download");
$("expSave").onclick = () => doExport("save");
window.addEventListener("resize", () => state.fit && render());

canvas.addEventListener("mousemove", (e) => {
  const d = state.doc;
  if (!d) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * d.width * reps()) % d.width;
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * d.height * reps()) % d.height;
  const v = state.frames[state.frame][y * d.width + x];
  const swatch = v >= 0 ? el("i", {}) : null;
  if (swatch) swatch.style.background = d.palette[v];
  $("hover").replaceChildren(`x ${x}  y ${y}  `, swatch ?? "", v >= 0 ? ` "${ALPHABET[v]}" ${d.palette[v]}` : " empty");
});
canvas.addEventListener("mouseleave", () => $("hover").replaceChildren());
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? 1 : -1));
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const d = state.doc;
  if (!d) return;
  const n = d.frames.length;
  const toggle = (id) => {
    $(id).checked = !$(id).checked;
    $(id).dispatchEvent(new Event("change"));
  };
  switch (e.key) {
    case "ArrowRight":
      play(false);
      state.frame = (state.frame + 1) % n;
      render();
      break;
    case "ArrowLeft":
      play(false);
      state.frame = (state.frame - 1 + n) % n;
      render();
      break;
    case " ":
      e.preventDefault();
      play(!state.playing);
      break;
    case "+":
    case "=":
      $("zoomIn").click();
      break;
    case "-":
      $("zoomOut").click();
      break;
    case "0":
      $("zoomLabel").click();
      break;
    case "g":
      toggle("grid");
      break;
    case "o":
      toggle("onion");
      break;
    case "t":
      toggle("tile");
      break;
    default:
      return;
  }
});

(async () => {
  try {
    const r = await loadAssets();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const first = [fromHash, r.focus, state.assets[0]?.name].find((n) => n && state.assets.some((a) => a.name === n));
    if (first) await select(first);
    else render();
  } catch (e) {
    toast(e.message, "error");
  }
  connect();
  setInterval(() => state.assets.length && renderAssetList(), 30000);
})();
