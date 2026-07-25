/* RandoCarte — carte de randonnée 100 % hors ligne (GPX + tuiles pré-téléchargées) */
"use strict";

/* ================= IndexedDB ================= */
const DB_NAME = "randocarte", DB_VER = 1;
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tiles")) db.createObjectStore("tiles");
      if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks", { keyPath: "id" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
}
async function idb(store, mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
const tileKey = (l, z, x, y) => `${l}|${z}|${x}|${y}`;
const getTile = (k) => idb("tiles", "readonly", s => s.get(k));
const putTile = (k, blob) => idb("tiles", "readwrite", s => s.put(blob, k));

/* ================= Fonds de carte ================= */
const geopf = (layer, fmt, style) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
  `&STYLE=${style || "normal"}&TILEMATRIXSET=PM&FORMAT=${encodeURIComponent(fmt)}` +
  `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

const LAYERS = {
  ignplan:  { name: "Plan IGN (topo)", url: geopf("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png"),
              maxZoom: 18, kb: 25, attr: "© IGN Géoplateforme" },
  ignsat:   { name: "Satellite IGN (France)", url: geopf("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"),
              maxZoom: 19, kb: 35, attr: "© IGN Géoplateforme" },
  esrisat:  { name: "Satellite Esri (monde)",
              url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
              maxZoom: 19, kb: 35, attr: "© Esri, Maxar" },
  opentopo: { name: "OpenTopoMap", url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
              maxZoom: 17, kb: 30, attr: "© OSM, OpenTopoMap (CC-BY-SA)" },
};

/* Couche Leaflet : IndexedDB d'abord, réseau ensuite (avec mise en cache) */
const OfflineTileLayer = L.TileLayer.extend({
  initialize(layerId, options) {
    this._layerId = layerId;
    L.TileLayer.prototype.initialize.call(this, LAYERS[layerId].url, options);
  },
  createTile(coords, done) {
    const img = document.createElement("img");
    img.alt = "";
    const key = tileKey(this._layerId, coords.z, coords.x, coords.y);
    getTile(key).then(blob => {
      if (blob) {
        img.src = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(img.src); done(null, img); };
        img.onerror = () => done(new Error("blob"), img);
      } else if (navigator.onLine) {
        const url = this.getTileUrl(coords);
        fetch(url).then(r => { if (!r.ok) throw 0; return r.blob(); }).then(b => {
          if (state.autocache) putTile(key, b).catch(() => {});
          img.src = URL.createObjectURL(b);
          img.onload = () => { URL.revokeObjectURL(img.src); done(null, img); };
          img.onerror = () => done(new Error("img"), img);
        }).catch(() => done(new Error("net"), img));
      } else {
        done(new Error("offline"), img);
      }
    }).catch(() => done(new Error("idb"), img));
    return img;
  },
});

/* ================= État ================= */
const state = {
  layerId: localStorage.getItem("rc.layer") || "ignplan",
  tracks: [],                 // {id,name,color,pts:[[lat,lon,ele],...],wpts,dist,dplus,dminus,cum:[],visible}
  activeTrackId: localStorage.getItem("rc.active") || null,
  polylines: new Map(),       // id -> L.LayerGroup
  follow: true,
  autocache: localStorage.getItem("rc.autocache") !== "0",
  watching: false,
  pos: null,                  // dernière position {lat,lon,acc,alt,speed,heading}
  compassHeading: null,
  wakeLock: null,
  dlAbort: null,
  profCursor: -1,
};
const COLORS = ["#ff4d6d", "#4dabf7", "#ffd43b", "#51cf66", "#cc5de8", "#ff922b"];
const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 2600) => {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
};

/* ================= Carte ================= */
const saved = JSON.parse(localStorage.getItem("rc.view") || "null");
const map = L.map("map", { zoomControl: false, attributionControl: true })
  .setView(saved ? saved.c : [45.5, 2.5], saved ? saved.z : 6);
map.on("moveend", () => {
  localStorage.setItem("rc.view", JSON.stringify({ c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }));
  updateEstimate();
});
let baseLayer = null;
function setLayer(id) {
  if (baseLayer) map.removeLayer(baseLayer);
  state.layerId = id;
  localStorage.setItem("rc.layer", id);
  baseLayer = new OfflineTileLayer(id, { maxZoom: LAYERS[id].maxZoom, attribution: LAYERS[id].attr });
  baseLayer.addTo(map);
  updateEstimate();
}
setLayer(state.layerId);

/* ================= Géométrie ================= */
const R = 6371000;
function haversine(a, b) {
  const dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/* distance point→segment en mètres (projection équirectangulaire locale) */
function distToSegment(p, a, b) {
  const k = Math.cos(p[0] * Math.PI / 180) * 111320, ky = 110540;
  const px = (p[1] - a[1]) * k, py = (p[0] - a[0]) * ky;
  const bx = (b[1] - a[1]) * k, by = (b[0] - a[0]) * ky;
  const len2 = bx * bx + by * by;
  let t = len2 ? (px * bx + py * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}
const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m";

/* ================= GPX ================= */
function parseGPX(text, name) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("GPX invalide");
  const pts = [];
  doc.querySelectorAll("trkpt, rtept").forEach(el => {
    const lat = parseFloat(el.getAttribute("lat")), lon = parseFloat(el.getAttribute("lon"));
    if (isNaN(lat) || isNaN(lon)) return;
    const eleEl = el.querySelector("ele");
    pts.push([lat, lon, eleEl ? parseFloat(eleEl.textContent) : null]);
  });
  const wpts = [];
  doc.querySelectorAll("wpt").forEach(el => {
    const nm = el.querySelector("name");
    wpts.push({ lat: +el.getAttribute("lat"), lon: +el.getAttribute("lon"), name: nm ? nm.textContent : "" });
  });
  if (pts.length < 2 && !wpts.length) throw new Error("Aucun point dans ce GPX");
  const nameTag = doc.querySelector("trk > name, metadata > name");
  return makeTrack((nameTag && nameTag.textContent.trim()) || name.replace(/\.gpx$/i, ""), pts, wpts);
}

/* (re)calcule distance, dénivelés et cumuls d'une trace.
   Méthode D+/D− : rééchantillonnage des altitudes à pas constant (ELE_STEP m, par
   interpolation linéaire), puis hystérésis à ancre mobile avec seuil ELE_THRESHOLD m
   (réglage type Visorando). Le pas constant rend les résultats comparables quelle que
   soit la densité de points du GPX d'origine. D+ et D− ne sont volontairement pas
   égalisés sur les boucles (résidu sous le seuil jamais soldé : comportement attendu). */
const ELE_STEP = 20, ELE_THRESHOLD = 10;
function computeStats(t) {
  let dist = 0;
  const cum = [0];
  for (let i = 1; i < t.pts.length; i++) {
    dist += haversine(t.pts[i - 1], t.pts[i]);
    cum.push(dist);
  }
  t.dist = dist; t.cum = cum;
  t.loop = t.pts.length > 1 && haversine(t.pts[0], t.pts[t.pts.length - 1]) < 300;

  /* nœuds altimétriques connus : [distance, altitude] */
  const knots = [];
  for (let i = 0; i < t.pts.length; i++)
    if (t.pts[i][2] != null) knots.push([cum[i], t.pts[i][2]]);
  const n = t.pts.length;
  t.hi = knots.length ? Math.round(knots.reduce((m, k) => Math.max(m, k[1]), -Infinity)) : null;
  t.lo = knots.length ? Math.round(knots.reduce((m, k) => Math.min(m, k[1]), Infinity)) : null;
  if (knots.length < 2 || dist <= 0) {
    t.dplus = 0; t.dminus = 0;
    t.cumDplus = new Array(n).fill(0);
    t.cumDminus = new Array(n).fill(0);
    return;
  }

  /* altitude interpolée à une distance donnée (curseur ki monotone) */
  let ki = 0;
  const eleAtDist = (d) => {
    while (ki < knots.length - 2 && knots[ki + 1][0] < d) ki++;
    const [d0, e0] = knots[ki], [d1, e1] = knots[ki + 1];
    if (d <= d0) return e0;
    if (d >= d1) return e1;
    return e0 + (e1 - e0) * (d - d0) / (d1 - d0);
  };

  /* hystérésis à ancre sur la série rééchantillonnée */
  const ds = [], gains = [], losses = [];
  let gain = 0, loss = 0, anchor = eleAtDist(0);
  for (let d = 0; ; d += ELE_STEP) {
    if (d > dist) d = dist;
    const delta = eleAtDist(d) - anchor;
    if (delta >= ELE_THRESHOLD) { gain += delta; anchor += delta; }
    else if (delta <= -ELE_THRESHOLD) { loss -= delta; anchor += delta; }
    ds.push(d); gains.push(gain); losses.push(loss);
    if (d >= dist) break;
  }
  t.dplus = Math.round(gain); t.dminus = Math.round(loss);

  /* report des cumuls sur chaque point de la trace (pour le temps réel et le curseur) */
  const cumDplus = [], cumDminus = [];
  let si = 0;
  for (let i = 0; i < n; i++) {
    while (si < ds.length - 1 && ds[si + 1] <= cum[i]) si++;
    cumDplus.push(Math.round(gains[si]));
    cumDminus.push(Math.round(losses[si]));
  }
  t.cumDplus = cumDplus; t.cumDminus = cumDminus;
}
/* durée estimée (méthode du randonneur : 4 km/h + 300 m D+/h + 500 m D−/h) */
function estimateDuration(t) {
  const h = t.dist / 4000 + t.dplus / 300 + t.dminus / 500;
  const H = Math.floor(h), M = Math.round((h - H) * 60 / 5) * 5;
  return M === 60 ? `${H + 1}h` : `${H}h${M ? String(M).padStart(2, "0") : ""}`;
}
/* difficulté estimée sur l'indice d'effort (km + D+/100) */
function difficulty(t) {
  const e = t.dist / 1000 + t.dplus / 100;
  return e < 5 ? "Très facile" : e < 10 ? "Facile" : e < 15 ? "Moyenne" : e < 19 ? "Difficile" : "Très difficile";
}
/* construit l'objet trace à partir de points [lat,lon,ele] */
function makeTrack(name, pts, wpts) {
  const t = {
    id: "t" + Date.now() + Math.floor(Math.random() * 1e4),
    name, pts, wpts: wpts || [], visible: true,
  };
  computeStats(t);
  return t;
}
/* complète les altitudes manquantes via l'IGN (≤ 500 points échantillonnés) puis recalcule les stats */
async function fillElevations(t) {
  const n = t.pts.length;
  const step = Math.max(1, Math.ceil(n / 500));
  const idxs = [];
  for (let i = 0; i < n; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
  const eles = await fetchElevations(idxs.map(i => t.pts[i]));
  idxs.forEach((pi, k) => { t.pts[pi][2] = eles[k]; });
  computeStats(t);
}

/* index du point de la trace le plus proche d'un lat/lng */
function nearestIdx(t, lat, lon) {
  let best = Infinity, idx = 0;
  for (let i = 0; i < t.pts.length; i++) {
    const d = haversine([lat, lon], t.pts[i]);
    if (d < best) { best = d; idx = i; }
  }
  return idx;
}

function drawTrack(t) {
  if (state.polylines.has(t.id)) map.removeLayer(state.polylines.get(t.id));
  if (!t.visible) { state.polylines.delete(t.id); return; }
  const g = L.layerGroup();
  if (t.pts.length > 1) {
    L.polyline(t.pts.map(p => [p[0], p[1]]), { color: "#fff", weight: 8, opacity: .6 }).addTo(g);
    const line = L.polyline(t.pts.map(p => [p[0], p[1]]), { color: t.color, weight: 4, bubblingMouseEvents: false });
    /* toucher la trace → montre l'endroit sur le profil de dénivelé */
    line.on("click", (e) => {
      if (drawState.on) return;
      if (t.id !== state.activeTrackId) setActiveTrack(t.id);
      $("profile-wrap").classList.add("on");
      setCursor(nearestIdx(t, e.latlng.lat, e.latlng.lng), false);
    });
    line.addTo(g);
    L.circleMarker([t.pts[0][0], t.pts[0][1]], { radius: 7, color: "#fff", weight: 2, fillColor: "#51cf66", fillOpacity: 1 }).addTo(g);
    const e = t.pts[t.pts.length - 1];
    L.circleMarker([e[0], e[1]], { radius: 7, color: "#fff", weight: 2, fillColor: "#ff6b6b", fillOpacity: 1 }).addTo(g);
  }
  (t.wpts || []).forEach(w => {
    L.marker([w.lat, w.lon], { icon: L.divIcon({ className: "wpt-icon", html: "📌", iconSize: [20, 20] }) })
      .bindPopup(w.name || "Point").addTo(g);
  });
  g.addTo(map);
  state.polylines.set(t.id, g);
}

function renderTrackList() {
  const el = $("track-list");
  el.innerHTML = state.tracks.length ? "" :
    '<small class="hint">Aucune trace pour l\'instant.</small>';
  for (const t of state.tracks) {
    const div = document.createElement("div");
    div.className = "track" + (t.id === state.activeTrackId ? " activeTrack" : "");
    div.innerHTML = `
      <div class="track-head">
        <div class="track-dot" style="background:${t.color}"></div>
        <div class="track-name">${t.name}</div>
        <button data-a="eye" title="Afficher/masquer">${t.visible ? "👁" : "🚫"}</button>
        <button data-a="zoom" title="Zoomer">🔍</button>
        <button data-a="exp" title="Exporter en GPX">⤓</button>
        <button data-a="del" title="Supprimer">🗑</button>
      </div>
      <div class="track-stats">${fmtDist(t.dist)}${t.pts.some(p => p[2] != null)
        ? ` · D+ ${t.dplus} m · D− ${t.dminus} m`
        : " · altitude en attente de connexion"}</div>
      ${t.id === state.activeTrackId && t.pts.length > 1 ? `
      <div class="track-fiche">
        <div>↔ Distance<b>${fmtDist(t.dist)}</b></div>
        <div>◔ Durée estimée<b>≈ ${estimateDuration(t)}</b></div>
        <div>▲ Difficulté estimée<b>${difficulty(t)}</b></div>
        <div>⚐ Retour au départ<b>${t.loop ? "Oui (boucle)" : "Non"}</b></div>
        <div>↗ Dénivelé positif<b>${t.dplus ? "+ " + t.dplus + " m" : "–"}</b></div>
        <div>↘ Dénivelé négatif<b>${t.dminus ? "− " + t.dminus + " m" : "–"}</b></div>
        <div>▲ Point haut<b>${t.hi != null ? t.hi.toLocaleString("fr-FR") + " m" : "–"}</b></div>
        <div>▼ Point bas<b>${t.lo != null ? t.lo.toLocaleString("fr-FR") + " m" : "–"}</b></div>
      </div>` : ""}`;
    div.querySelector(".track-head").addEventListener("click", (e) => {
      const a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "eye") { t.visible = !t.visible; saveTrack(t); drawTrack(t); renderTrackList(); }
      else if (a === "zoom") { zoomToTrack(t); }
      else if (a === "exp") { exportGPX(t); }
      else if (a === "del") {
        if (!confirm(`Supprimer « ${t.name} » ?`)) return;
        idb("tracks", "readwrite", s => s.delete(t.id));
        if (state.polylines.has(t.id)) map.removeLayer(state.polylines.get(t.id));
        state.polylines.delete(t.id);
        state.tracks = state.tracks.filter(x => x.id !== t.id);
        if (state.activeTrackId === t.id) setActiveTrack(null);
        renderTrackList();
      } else {
        setActiveTrack(t.id === state.activeTrackId ? null : t.id);
      }
    });
    el.appendChild(div);
  }
}
const saveTrack = (t) => idb("tracks", "readwrite", s => s.put(t)).catch(() => toast("Erreur d'enregistrement"));
function zoomToTrack(t) {
  if (t.pts.length > 1) map.fitBounds(L.latLngBounds(t.pts.map(p => [p[0], p[1]])), { padding: [30, 30] });
  else if (t.wpts.length) map.setView([t.wpts[0].lat, t.wpts[0].lon], 14);
  closePanel();
}
function setActiveTrack(id) {
  state.activeTrackId = id;
  if (id) localStorage.setItem("rc.active", id); else localStorage.removeItem("rc.active");
  $("fab-profile").style.display = id ? "" : "none";
  if (!id) { $("profile-wrap").classList.remove("on"); }
  clearCursor(false);
  renderTrackList(); drawProfile(); updateNavHUD();
}
const activeTrack = () => state.tracks.find(t => t.id === state.activeTrackId) || null;

$("btn-import").addEventListener("click", () => $("gpx-file").click());
$("gpx-file").addEventListener("change", async (e) => {
  let colorIdx = state.tracks.length;
  for (const f of e.target.files) {
    try {
      const t = parseGPX(await f.text(), f.name);
      t.color = COLORS[colorIdx++ % COLORS.length];
      if (!t.pts.some(p => p[2] != null) && t.pts.length > 1 && navigator.onLine) {
        toast("Altitudes absentes du GPX — récupération auprès de l'IGN…", 5000);
        try { await fillElevations(t); } catch (err) { toast("Altitudes IGN indisponibles"); }
      }
      state.tracks.push(t);
      await saveTrack(t);
      drawTrack(t);
      if (!state.activeTrackId) setActiveTrack(t.id);
      zoomToTrack(t);
      toast(`Trace « ${t.name} » importée ✔`);
    } catch (err) { toast(`${f.name} : ${err.message}`); }
  }
  e.target.value = "";
  renderTrackList();
});

async function loadTracks() {
  const all = await idb("tracks", "readonly", s => s.getAll()).catch(() => []);
  state.tracks = all || [];
  if (state.activeTrackId && !state.tracks.some(t => t.id === state.activeTrackId)) state.activeTrackId = null;
  /* recalcul systématique à l'ouverture : bénéficie des évolutions de la méthode D+/D− */
  state.tracks.forEach(computeStats);
  state.tracks.forEach(drawTrack);
  renderTrackList();
  $("fab-profile").style.display = state.activeTrackId ? "" : "none";
  /* complète après coup les traces enregistrées sans altitude */
  for (const t of state.tracks) {
    if (navigator.onLine && t.pts.length > 1 && !t.pts.some(p => p[2] != null)) {
      try {
        await fillElevations(t);
        await saveTrack(t);
        drawTrack(t);
        toast(`Altitudes IGN ajoutées à « ${t.name} » ✔`);
      } catch (err) { /* hors ligne ou service indisponible : on réessaiera à la prochaine ouverture */ }
    }
  }
  renderTrackList();
  drawProfile();
}

/* ================= Export GPX ================= */
const escapeXml = (s) => s.replace(/[<>&"']/g, c =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
function exportGPX(t) {
  const seg = t.pts.map(p =>
    `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${p[2] != null ? `<ele>${Math.round(p[2] * 10) / 10}</ele>` : ""}</trkpt>`
  ).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RandoCarte" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${escapeXml(t.name)}</name><trkseg>\n${seg}\n</trkseg></trk>\n</gpx>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml" }));
  a.download = (t.name.replace(/[\\/:*?"<>|]/g, "").trim() || "trace") + ".gpx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ================= Création de tracé à la main ================= */
const drawState = { on: false, pts: [], line: null, dots: null };
function updateDrawInfo() {
  let d = 0;
  for (let i = 1; i < drawState.pts.length; i++) d += haversine(drawState.pts[i - 1], drawState.pts[i]);
  $("draw-info").textContent = `${drawState.pts.length} point${drawState.pts.length > 1 ? "s" : ""} · ${fmtDist(d)}`;
}
function redrawDraft() {
  if (drawState.line) map.removeLayer(drawState.line);
  if (drawState.dots) map.removeLayer(drawState.dots);
  drawState.line = L.polyline(drawState.pts.map(p => [p[0], p[1]]),
    { color: "#ffd43b", weight: 4, dashArray: "8 6" }).addTo(map);
  drawState.dots = L.layerGroup(drawState.pts.map(p =>
    L.circleMarker([p[0], p[1]], { radius: 5, color: "#1a1d21", weight: 2, fillColor: "#ffd43b", fillOpacity: 1 }))).addTo(map);
  updateDrawInfo();
}
function endDraw() {
  drawState.on = false;
  $("draw-bar").classList.remove("on");
  $("hud").style.display = "";
  if (drawState.line) { map.removeLayer(drawState.line); drawState.line = null; }
  if (drawState.dots) { map.removeLayer(drawState.dots); drawState.dots = null; }
}
$("btn-draw").addEventListener("click", () => {
  drawState.on = true; drawState.pts = [];
  closePanel();
  $("draw-bar").classList.add("on");
  $("hud").style.display = "none";
  redrawDraft();
  toast("Touchez la carte point par point pour dessiner l'itinéraire");
});
$("draw-undo").addEventListener("click", () => { drawState.pts.pop(); redrawDraft(); });
$("draw-cancel").addEventListener("click", endDraw);
map.on("click", (e) => {
  if (drawState.on) { drawState.pts.push([e.latlng.lat, e.latlng.lng]); redrawDraft(); }
});

/* densifie le tracé (~1 point tous les 40 m) pour un profil de dénivelé précis */
function densify(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
  const step = Math.max(40, total / 500);
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length; i++) {
    const len = haversine(pts[i - 1], pts[i]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++)
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / n,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / n]);
  }
  return out;
}
/* altitudes via le service d'altimétrie de l'IGN (gratuit, connexion nécessaire) */
async function fetchElevations(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 80) {
    const c = pts.slice(i, i + 80);
    const url = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json" +
      `?lon=${c.map(p => p[1].toFixed(6)).join("|")}&lat=${c.map(p => p[0].toFixed(6)).join("|")}` +
      "&resource=ign_rge_alti_wld&delimiter=|&zonly=true";
    const r = await fetch(url);
    if (!r.ok) throw new Error("service altimétrie indisponible");
    const j = await r.json();
    out.push(...j.elevations.map(v => {
      const z = typeof v === "number" ? v : v && v.z;
      return (z == null || z < -1000) ? null : z;
    }));
  }
  return out;
}
$("draw-done").addEventListener("click", async () => {
  if (drawState.pts.length < 2) { toast("Posez au moins 2 points sur la carte"); return; }
  const name = prompt("Nom du tracé :", "Mon itinéraire") || "Mon itinéraire";
  const dense = densify(drawState.pts);
  endDraw();
  let eles = null;
  if (navigator.onLine) {
    toast("Récupération des altitudes IGN…", 6000);
    try { eles = await fetchElevations(dense); }
    catch (err) { toast("Altitudes indisponibles — tracé créé sans profil"); }
  } else toast("Hors ligne : tracé créé sans altitudes");
  const pts = dense.map((p, i) => [p[0], p[1], eles ? eles[i] : null]);
  const t = makeTrack(name, pts, []);
  t.color = COLORS[state.tracks.length % COLORS.length];
  state.tracks.push(t);
  await saveTrack(t);
  drawTrack(t);
  setActiveTrack(t.id);
  toast(`Tracé « ${t.name} » créé ✔ ${fmtDist(t.dist)}${t.dplus ? " · D+ " + t.dplus + " m" : ""}`, 4000);
});

/* ================= Profil altimétrique ================= */
const PROF = { L: 38, R: 10, T: 8, B: 18 }; // marges en px CSS
function niceStep(range, target, steps) {
  for (const s of steps) if (range / s <= target) return s;
  return steps[steps.length - 1];
}
/* altitude au point idx (cherche le point renseigné le plus proche) */
function eleAt(t, idx) {
  if (t.pts[idx] && t.pts[idx][2] != null) return t.pts[idx][2];
  for (let d = 1; d < t.pts.length; d++) {
    if (t.pts[idx - d] && t.pts[idx - d][2] != null) return t.pts[idx - d][2];
    if (t.pts[idx + d] && t.pts[idx + d][2] != null) return t.pts[idx + d][2];
  }
  return null;
}
function drawProfile() {
  if (!$("profile-wrap").classList.contains("on")) return;
  const t = activeTrack(), cv = $("profile");
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth || 320, chh = cv.clientHeight || 120;
  cv.width = cw * dpr; cv.height = chh * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, chh);
  if (!t || !t.pts.some(p => p[2] != null)) {
    ctx.fillStyle = "#9aa0a6"; ctx.font = "12px -apple-system, sans-serif";
    ctx.fillText(t ? "Pas de données d'altitude dans cette trace" : "Aucune trace active", 12, 34);
    return;
  }
  const x0 = PROF.L, x1 = cw - PROF.R, y0 = PROF.T, y1 = chh - PROF.B;
  const eles = t.pts.map(p => p[2]).filter(e => e != null);
  let min = Math.min(...eles), max = Math.max(...eles);
  if (max - min < 20) { const c = (max + min) / 2; min = c - 10; max = c + 10; }
  const span = max - min;
  const X = (d) => x0 + (d / t.dist) * (x1 - x0);
  const Y = (e) => y1 - ((e - min) / span) * (y1 - y0);

  ctx.font = "10px -apple-system, sans-serif";
  ctx.lineWidth = 1;
  /* grille altitude (m) */
  const aStep = niceStep(span, 5, [10, 20, 50, 100, 200, 500, 1000, 2000]);
  ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.fillStyle = "#9aa0a6";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let a2 = Math.ceil(min / aStep) * aStep; a2 <= max; a2 += aStep) {
    ctx.beginPath(); ctx.moveTo(x0, Y(a2)); ctx.lineTo(x1, Y(a2)); ctx.stroke();
    ctx.fillText(a2, x0 - 4, Y(a2));
  }
  /* grille distance (km) */
  const kmTotal = t.dist / 1000;
  const kStep = niceStep(kmTotal, 7, [0.2, 0.5, 1, 2, 5, 10, 20, 50]);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let k = kStep; k < kmTotal; k += kStep) {
    ctx.beginPath(); ctx.moveTo(X(k * 1000), y0); ctx.lineTo(X(k * 1000), y1); ctx.stroke();
    ctx.fillText(String(Math.round(k * 10) / 10).replace(".", ","), X(k * 1000), y1 + 4);
  }
  ctx.textAlign = "left";
  ctx.fillText("km", x1 - 16, y1 + 4);

  /* courbe */
  ctx.beginPath();
  let started = false, firstX = x0;
  for (let i = 0; i < t.pts.length; i++) {
    if (t.pts[i][2] == null) continue;
    const x = X(t.cum[i]), y = Y(t.pts[i][2]);
    if (!started) firstX = x;
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  ctx.strokeStyle = t.color; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(x1, y1); ctx.lineTo(firstX, y1); ctx.closePath();
  ctx.fillStyle = t.color + "2e"; ctx.fill();

  /* ma position en temps réel sur le profil */
  if (state.pos && nearestOnTrack.idx >= 0) {
    const e = eleAt(t, nearestOnTrack.idx);
    if (e != null) {
      const x = X(t.cum[nearestOnTrack.idx]), y = Y(e);
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7);
      ctx.fillStyle = "#2b7de9"; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  /* curseur (doigt sur le profil ou touché sur la trace) */
  if (state.profCursor >= 0 && state.profCursor < t.pts.length) {
    const i = state.profCursor, e = eleAt(t, i), x = X(t.cum[i]);
    ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.setLineDash([]);
    if (e != null) {
      ctx.beginPath(); ctx.arc(x, Y(e), 4, 0, 7);
      ctx.fillStyle = "#fff"; ctx.fill();
    }
    const label = `${(t.cum[i] / 1000).toFixed(1).replace(".", ",")} km · ${e != null ? Math.round(e) + " m" : "?"}` +
      (t.cumDplus && t.dplus > 0 ? ` · D+ ${t.cumDplus[i]}` : "") +
      (t.cumDminus && t.dminus > 0 ? ` · D− ${t.cumDminus[i]}` : "");
    ctx.font = "11px -apple-system, sans-serif";
    const w = ctx.measureText(label).width + 10;
    const lx = Math.min(Math.max(x - w / 2, x0), x1 - w);
    ctx.fillStyle = "rgba(15,17,20,.92)";
    ctx.fillRect(lx, 0, w, 15);
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 5, 8);
  }
}

/* curseur partagé carte ↔ profil */
let cursorMarker = null;
function setCursor(idx, pan = true) {
  state.profCursor = idx;
  const t = activeTrack();
  if (t && t.pts[idx]) {
    const ll = [t.pts[idx][0], t.pts[idx][1]];
    if (!cursorMarker)
      cursorMarker = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 3, fillColor: "#1a1d21", fillOpacity: 1, bubblingMouseEvents: false }).addTo(map);
    else cursorMarker.setLatLng(ll);
    if (pan && !map.getBounds().contains(ll)) map.panTo(ll);
  }
  drawProfile();
}
function clearCursor(redraw = true) {
  state.profCursor = -1;
  if (cursorMarker) { map.removeLayer(cursorMarker); cursorMarker = null; }
  if (redraw) drawProfile();
}

/* glisser le doigt sur le profil → curseur + point sur la carte */
const profCv = $("profile");
let profDrag = false;
function profPoint(ev) {
  const t = activeTrack();
  if (!t || t.dist <= 0) return;
  const r = profCv.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (ev.clientX - r.left - PROF.L) / (r.width - PROF.L - PROF.R)));
  const d = frac * t.dist;
  let i = 0;
  while (i < t.cum.length - 1 && t.cum[i] < d) i++;
  setCursor(i);
}
profCv.addEventListener("pointerdown", (e) => { profDrag = true; profPoint(e); e.preventDefault(); });
window.addEventListener("pointermove", (e) => { if (profDrag) profPoint(e); });
window.addEventListener("pointerup", () => { profDrag = false; });

$("fab-profile").addEventListener("click", () => {
  $("profile-wrap").classList.toggle("on");
  if ($("profile-wrap").classList.contains("on")) drawProfile(); else clearCursor(false);
});
$("profile-close").addEventListener("click", () => {
  $("profile-wrap").classList.remove("on");
  clearCursor(false);
});

/* ================= Position GPS ================= */
let locMarker = null, accCircle = null;
function ensureMarker() {
  if (locMarker) return;
  const icon = L.divIcon({
    className: "loc-icon", iconSize: [0, 0],
    html: '<div class="loc-beam" id="loc-beam"></div><div class="loc-dot"></div>',
  });
  locMarker = L.marker([0, 0], { icon, zIndexOffset: 1000 }).addTo(map);
  accCircle = L.circle([0, 0], { radius: 0, color: "#2b7de9", weight: 1, fillOpacity: .12 }).addTo(map);
}
function updateHeadingVisual() {
  const beam = document.getElementById("loc-beam");
  if (!beam) return;
  let h = null;
  if (state.pos && state.pos.heading != null && !isNaN(state.pos.heading) && state.pos.speed > 0.7)
    h = state.pos.heading;
  else if (state.compassHeading != null) h = state.compassHeading;
  if (h == null) { beam.style.display = "none"; return; }
  beam.style.display = "block";
  beam.style.transform = `rotate(${h}deg) translate(-17px, -34px)`;
}

const nearestOnTrack = { idx: -1, gap: null };
function updateNavHUD() {
  const t = activeTrack();
  const show = (id, on) => $(id).classList.toggle("off", !on);
  if (!state.pos) { ["hud-speed","hud-alt","hud-acc","hud-gap","hud-dplus","hud-dminus","hud-rest"].forEach(i => show(i, false)); return; }
  const p = state.pos;
  show("hud-speed", true); show("hud-alt", p.alt != null); show("hud-acc", true);
  $("hud-speed").querySelector("b").textContent = p.speed != null ? (p.speed * 3.6).toFixed(1) : "0.0";
  if (p.alt != null) $("hud-alt").querySelector("b").textContent = Math.round(p.alt);
  $("hud-acc").querySelector("b").textContent = "±" + Math.round(p.acc) + "m";
  if (t && t.pts.length > 1) {
    let best = Infinity, bestIdx = 0;
    const pt = [p.lat, p.lon];
    for (let i = 0; i < t.pts.length - 1; i++) {
      const d = distToSegment(pt, t.pts[i], t.pts[i + 1]);
      if (d < best) { best = d; bestIdx = i; }
    }
    nearestOnTrack.idx = bestIdx; nearestOnTrack.gap = best;
    show("hud-gap", true); show("hud-rest", true);
    const gapEl = $("hud-gap").querySelector("b");
    gapEl.textContent = fmtDist(best);
    gapEl.style.color = best > 100 ? "var(--err)" : best > 40 ? "var(--warn)" : "var(--ok)";
    $("hud-rest").querySelector("b").textContent = fmtDist(Math.max(0, t.dist - t.cum[bestIdx]));
    const hasD = t.cumDplus && t.dplus > 0;
    show("hud-dplus", hasD); show("hud-dminus", hasD && !!t.cumDminus);
    if (hasD) $("hud-dplus").querySelector("b").textContent = t.cumDplus[bestIdx] + " m";
    if (hasD && t.cumDminus) $("hud-dminus").querySelector("b").textContent = t.cumDminus[bestIdx] + " m";
  } else { show("hud-gap", false); show("hud-dplus", false); show("hud-dminus", false); show("hud-rest", false); }
  if ($("profile-wrap").classList.contains("on")) drawProfile();
}

let watchId = null;
function startWatch() {
  if (state.watching) { // déjà actif → recentrer
    if (state.pos) map.setView([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 15));
    state.follow = true; $("fab-follow").classList.add("active");
    return;
  }
  if (!("geolocation" in navigator)) { toast("Géolocalisation non disponible"); return; }
  requestCompass();
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  state.watching = true;
  $("fab-locate").classList.add("active");
  $("fab-follow").style.display = "";
  state.follow = $("opt-follow").checked;
  $("fab-follow").classList.toggle("active", state.follow);
  toast("Recherche du signal GPS…");
}
let firstFix = true;
function onPos(e) {
  const c = e.coords;
  state.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy,
    alt: c.altitude, speed: c.speed, heading: c.heading };
  ensureMarker();
  locMarker.setLatLng([c.latitude, c.longitude]);
  accCircle.setLatLng([c.latitude, c.longitude]).setRadius(c.accuracy);
  if (state.follow || firstFix) {
    map.setView([c.latitude, c.longitude], firstFix ? Math.max(map.getZoom(), 15) : map.getZoom(),
      { animate: !firstFix });
  }
  firstFix = false;
  updateHeadingVisual();
  updateNavHUD();
}
function onPosErr(err) {
  toast(err.code === 1 ? "Autorisez la localisation dans les réglages du navigateur"
    : "Position indisponible (" + err.message + ")");
}
$("fab-locate").addEventListener("click", startWatch);
$("fab-follow").addEventListener("click", () => {
  state.follow = !state.follow;
  $("fab-follow").classList.toggle("active", state.follow);
  if (state.follow && state.pos) map.panTo([state.pos.lat, state.pos.lon]);
});
map.on("dragstart", () => { state.follow = false; $("fab-follow").classList.remove("active"); });

/* Boussole (cap de l'appareil) */
let compassStarted = false;
function requestCompass() {
  if (compassStarted) return;
  const attach = () => {
    compassStarted = true;
    const handler = (ev) => {
      if (ev.webkitCompassHeading != null) state.compassHeading = ev.webkitCompassHeading; // iOS
      else if (ev.absolute && ev.alpha != null) state.compassHeading = (360 - ev.alpha) % 360; // Android
      updateHeadingVisual();
    };
    if ("ondeviceorientationabsolute" in window)
      window.addEventListener("deviceorientationabsolute", handler);
    else window.addEventListener("deviceorientation", handler);
  };
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(s => { if (s === "granted") attach(); }).catch(() => {});
  } else attach();
}

/* ================= Téléchargement de zones ================= */
function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function lat2y(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}
function tilesForView(zMax) {
  const b = map.getBounds();
  const zMin = Math.min(Math.max(map.getZoom(), 6), zMax);
  const list = [];
  for (let z = zMin; z <= zMax; z++) {
    const x1 = lon2x(b.getWest(), z), x2 = lon2x(b.getEast(), z);
    const y1 = lat2y(b.getNorth(), z), y2 = lat2y(b.getSouth(), z);
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) list.push([z, x, y]);
  }
  return list;
}
function updateEstimate() {
  const zMax = +$("zmax").value;
  $("zmax-val").textContent = zMax;
  const n = tilesForView(zMax).length;
  const mb = (n * LAYERS[state.layerId].kb / 1024).toFixed(1);
  $("dl-estimate").textContent =
    `≈ ${n.toLocaleString("fr-FR")} tuiles (${mb} Mo) — zoom ${Math.min(map.getZoom(), zMax)} → ${zMax}, fond « ${LAYERS[state.layerId].name} »`;
  $("btn-download").disabled = n > 40000;
  if (n > 40000) $("dl-status").textContent = "Zone trop grande : zoomez davantage ou réduisez le détail.";
}
$("zmax").addEventListener("input", updateEstimate);

async function downloadArea() {
  if (!navigator.onLine) { toast("Connexion nécessaire pour télécharger"); return; }
  const zMax = +$("zmax").value;
  const tiles = tilesForView(zMax);
  const layerId = state.layerId, tpl = LAYERS[layerId].url;
  const ctrl = new AbortController();
  state.dlAbort = ctrl;
  $("btn-download").style.display = "none";
  $("btn-cancel").style.display = "";
  $("dl-progress").style.display = "";
  let done = 0, failed = 0, skipped = 0;
  const urlFor = ([z, x, y]) => tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const queue = tiles.slice();
  const worker = async () => {
    while (queue.length && !ctrl.signal.aborted) {
      const t = queue.shift();
      const key = tileKey(layerId, t[0], t[1], t[2]);
      try {
        if (await getTile(key)) { skipped++; }
        else {
          const r = await fetch(urlFor(t), { signal: ctrl.signal });
          if (!r.ok) throw 0;
          await putTile(key, await r.blob());
        }
      } catch (e) { if (!ctrl.signal.aborted) failed++; }
      done++;
      if (done % 20 === 0 || done === tiles.length) {
        $("dl-progress").value = (done / tiles.length) * 100;
        $("dl-status").textContent = `${done}/${tiles.length} tuiles… ${failed ? failed + " échecs" : ""}`;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  $("btn-download").style.display = "";
  $("btn-cancel").style.display = "none";
  $("dl-progress").style.display = "none";
  state.dlAbort = null;
  $("dl-status").textContent = ctrl.signal.aborted
    ? `Annulé (${done - failed} tuiles conservées).`
    : `Terminé ✔ ${done - failed} tuiles disponibles hors ligne${failed ? `, ${failed} échecs` : ""}.`;
  if (!ctrl.signal.aborted) toast("Zone téléchargée — utilisable sans réseau ✔");
  refreshStorage();
}
$("btn-download").addEventListener("click", downloadArea);
$("btn-cancel").addEventListener("click", () => state.dlAbort && state.dlAbort.abort());

async function refreshStorage() {
  let count = 0;
  await idb("tiles", "readonly", s => { const r = s.count(); r.onsuccess = () => count = r.result; });
  let quota = "";
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    quota = ` · ${(est.usage / 1048576).toFixed(0)} Mo utilisés sur ${(est.quota / 1048576 / 1024).toFixed(1)} Go dispo`;
  }
  $("storage-info").textContent = `${count.toLocaleString("fr-FR")} tuiles en mémoire${quota}`;
}
$("btn-clear-tiles").addEventListener("click", async () => {
  if (!confirm("Supprimer toutes les cartes téléchargées ?")) return;
  await idb("tiles", "readwrite", s => s.clear());
  refreshStorage();
  toast("Cartes supprimées");
});

/* ================= Panneau / onglets ================= */
const panel = $("panel");
const closePanel = () => panel.classList.remove("open");
$("fab-menu").addEventListener("click", () => {
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) { updateEstimate(); refreshStorage(); }
});
$("panel-grip").addEventListener("click", closePanel);
map.on("click", closePanel);
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("sel", x === b));
  document.querySelectorAll(".tab-page").forEach(p =>
    p.classList.toggle("sel", p.id === "page-" + b.dataset.tab));
}));

/* liste des fonds */
(function buildLayerList() {
  const el = $("layer-list");
  for (const [id, l] of Object.entries(LAYERS)) {
    const lab = document.createElement("label");
    lab.className = "layer-opt";
    lab.innerHTML = `<input type="radio" name="layer" value="${id}" ${id === state.layerId ? "checked" : ""}>
      <span>${l.name}</span>`;
    lab.querySelector("input").addEventListener("change", () => { setLayer(id); toast(l.name); });
    el.appendChild(lab);
  }
})();

/* ================= Options ================= */
$("opt-follow").addEventListener("change", (e) => { state.follow = e.target.checked; });
$("opt-autocache").addEventListener("change", (e) => {
  state.autocache = e.target.checked;
  localStorage.setItem("rc.autocache", e.target.checked ? "1" : "0");
});
$("opt-autocache").checked = state.autocache;

async function setWake(on) {
  try {
    if (on) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { if ($("opt-wake").checked) setWake(true).catch(()=>{}); });
    } else if (state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch (e) { toast("Écran allumé : non supporté ici"); $("opt-wake").checked = false; }
}
$("opt-wake").addEventListener("change", (e) => setWake(e.target.checked));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("opt-wake").checked) setWake(true);
});

/* ================= Réseau / SW / init ================= */
function netStatus() {
  const el = $("netdot");
  el.classList.toggle("offline", !navigator.onLine);
  el.textContent = navigator.onLine ? "En ligne" : "Hors ligne — cartes locales";
}
window.addEventListener("online", netStatus);
window.addEventListener("offline", netStatus);
netStatus();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

loadTracks();
updateEstimate();
refreshStorage();
