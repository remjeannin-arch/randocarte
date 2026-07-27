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

/* cherche une tuile parente stockée (zoom inférieur) pour servir de fond de secours */
async function ancestorTile(layerId, z, x, y) {
  for (let k = 1; k <= 6 && z - k >= 3; k++) {
    const blob = await getTile(tileKey(layerId, z - k, x >> k, y >> k)).catch(() => null);
    if (blob) return { blob, k, sx: x - ((x >> k) << k), sy: y - ((y >> k) << k) };
  }
  return null;
}

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
    const layerId = this._layerId;
    const key = tileKey(layerId, coords.z, coords.x, coords.y);
    const show = (src) => {
      img.onload = () => { if (src.startsWith("blob:")) URL.revokeObjectURL(src); done(null, img); };
      img.onerror = () => done(new Error("img"), img);
      img.src = src;
    };
    /* fond de secours : agrandit la tuile du niveau inférieur le plus proche,
       pour que les zooms non téléchargés restent lisibles hors ligne */
    const fallback = () => {
      ancestorTile(layerId, coords.z, coords.x, coords.y).then(anc => {
        if (!anc) { done(new Error("offline"), img); return; }
        const im = new Image();
        im.onload = () => {
          URL.revokeObjectURL(im.src);
          const cv = document.createElement("canvas");
          cv.width = 256; cv.height = 256;
          const cx = cv.getContext("2d");
          const size = 256 / (1 << anc.k);
          cx.imageSmoothingEnabled = true;
          cx.drawImage(im, anc.sx * size, anc.sy * size, size, size, 0, 0, 256, 256);
          show(cv.toDataURL());
        };
        im.onerror = () => done(new Error("anc"), img);
        im.src = URL.createObjectURL(anc.blob);
      }).catch(() => done(new Error("idb"), img));
    };
    getTile(key).then(blob => {
      if (blob) show(URL.createObjectURL(blob));
      else if (navigator.onLine) {
        fetch(this.getTileUrl(coords)).then(r => { if (!r.ok) throw 0; return r.blob(); }).then(b => {
          if (state.autocache) putTile(key, b).catch(() => {});
          show(URL.createObjectURL(b));
        }).catch(fallback);
      } else fallback();
    }).catch(() => done(new Error("idb"), img));
    return img;
  },
});

/* ================= Mode sans échec =================
   Si le démarrage précédent ne s'est pas terminé (plantage), on repart d'une vue
   neutre ; deux échecs de suite → les traces ne sont plus dessinées. Le compteur
   est remis à zéro après 5 s de fonctionnement ou à la fermeture normale. */
const APP_VERSION = "v21";
const bootFails = +(localStorage.getItem("rc.bootfail") || 0);
localStorage.setItem("rc.bootfail", String(bootFails + 1));
const SAFE_VIEW = bootFails >= 1, SAFE_TRACKS = bootFails >= 2;
if (SAFE_VIEW) { localStorage.removeItem("rc.view"); localStorage.removeItem("rc.active"); }
const bootOk = () => localStorage.setItem("rc.bootfail", "0");
setTimeout(bootOk, 5000);
window.addEventListener("pagehide", bootOk);
window.addEventListener("error", (e) => toast("Erreur : " + e.message, 7000));
window.addEventListener("unhandledrejection", (e) =>
  toast("Erreur : " + ((e.reason && e.reason.message) || e.reason), 7000));

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
/* preferCanvas : rendu des tracés sur canvas, bien plus léger que le SVG pour les
   GPX de plusieurs milliers de points (le SVG faisait planter Safari iOS) */
const map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true,
  renderer: L.canvas({ tolerance: 14 }) }) /* tolérance : zone de toucher élargie au doigt */
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
  /* beaucoup de tuiles en échec → expliquer pourquoi la carte est noire */
  let errs = 0;
  baseLayer.on("tileerror", () => {
    errs++;
    if (errs !== 8) return;
    if (!navigator.onLine)
      toast("Cette zone n'est pas téléchargée pour ce fond de carte (☰ → Cartes pour la télécharger avec du réseau).", 8000);
    else if (id.startsWith("ign"))
      toast("Les fonds IGN ne couvrent que la France. Pour l'étranger, choisissez « Satellite Esri (monde) » ou « OpenTopoMap » dans ☰ → Cartes.", 9000);
  });
  baseLayer.on("load", () => { errs = 0; });
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
const fmtDur = (ms) => {
  const m = Math.round(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.max(m, 1)} min`;
};

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
  if (knots.length < 2 || !(dist > 0) || !isFinite(dist)) {
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
      if (drawState.on || editState.id) return;
      if (t.id !== state.activeTrackId) setActiveTrack(t.id);
      $("profile-wrap").classList.add("on");
      setCursor(nearestIdx(t, e.latlng.lat, e.latlng.lng), false);
    });
    line.addTo(g);
    /* départ : cliquable → itinéraire en voiture vers le point de départ */
    /* marqueur DOM (pas canvas) : toucher fiable sur iOS */
    const s = t.pts[0];
    L.marker([s[0], s[1]], {
      icon: L.divIcon({ className: "start-icon", iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 500,
    }).bindPopup(`<b>🚩 Départ — ${escapeXml(t.name)}</b>` + coordLinks(s[0], s[1])).addTo(g);
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
        <button data-a="edit" title="Modifier le tracé">✏️</button>
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
        <div class="fiche-nav">📍 Départ&nbsp;:
          <a href="#" onclick="rcCopy('${t.pts[0][0].toFixed(6)},${t.pts[0][1].toFixed(6)}');return false;">${t.pts[0][0].toFixed(5)}, ${t.pts[0][1].toFixed(5)} 📋</a></div>
        <div class="fiche-nav">🚗 Itinéraire voiture vers le départ&nbsp;:
          <a href="${appleMapsUrl(`${t.pts[0][0].toFixed(6)},${t.pts[0][1].toFixed(6)}`)}" rel="noopener">Plans</a> ·
          <a href="${googleMapsUrl(`${t.pts[0][0].toFixed(6)},${t.pts[0][1].toFixed(6)}`)}" rel="noopener">Google&nbsp;Maps</a></div>
      </div>` : ""}`;
    div.querySelector(".track-head").addEventListener("click", (e) => {
      const a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "eye") { t.visible = !t.visible; saveTrack(t); drawTrack(t); renderTrackList(); }
      else if (a === "zoom") { zoomToTrack(t); }
      else if (a === "exp") { exportGPX(t); }
      else if (a === "edit") { if (!t.visible) { t.visible = true; saveTrack(t); } startEdit(t); }
      else if (a === "del") {
        if (!confirm(`Supprimer « ${t.name} » ?`)) return;
        idb("tracks", "readwrite", s => s.delete(t.id));
        if (state.polylines.has(t.id)) map.removeLayer(state.polylines.get(t.id));
        state.polylines.delete(t.id);
        state.tracks = state.tracks.filter(x => x.id !== t.id);
        if (state.activeTrackId === t.id) setActiveTrack(null);
        renderTrackList();
      } else {
        /* « ouvrir » la rando : activer, zoomer dessus, montrer le profil */
        setActiveTrack(t.id);
        zoomToTrack(t);
        if (t.pts.some(p => p[2] != null)) {
          $("profile-wrap").classList.add("on");
          drawProfile();
        }
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
  nearestOnTrack.idx = -1;
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
  if (!SAFE_TRACKS) state.tracks.forEach(drawTrack);
  renderTrackList();
  $("fab-profile").style.display = state.activeTrackId ? "" : "none";
  if (SAFE_TRACKS) {
    toast("Mode sans échec : traces non affichées après plantages répétés. Essayez de supprimer la trace (☰ → Traces → 🗑).", 9000);
    return;
  }
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
  const seg = t.pts.map((p, i) =>
    `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${p[2] != null ? `<ele>${Math.round(p[2] * 10) / 10}</ele>` : ""}${t.times && t.times[i] ? `<time>${t.times[i]}</time>` : ""}</trkpt>`
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
function startDrawMode() {
  if (editState.id) { toast("Terminez d'abord l'édition en cours"); return; }
  if (drawState.on) return;
  drawState.on = true; drawState.pts = [];
  closePanel();
  $("draw-bar").classList.add("on");
  $("hud").style.display = "none";
  redrawDraft();
  toast("Touchez la carte point par point pour dessiner l'itinéraire");
}
$("btn-draw").addEventListener("click", startDrawMode);
$("fab-draw").addEventListener("click", startDrawMode);
$("draw-undo").addEventListener("click", () => { drawState.pts.pop(); redrawDraft(); });
$("draw-cancel").addEventListener("click", endDraw);
map.on("click", (e) => {
  if (drawState.on) { drawState.pts.push([e.latlng.lat, e.latlng.lng]); redrawDraft(); }
  else if (editState.id) { editState.pts.push([e.latlng.lat, e.latlng.lng]); redrawEdit(); }
});

/* ================= Édition de tracé ================= */
const editState = { id: null, pts: [], group: null, line: null };
function douglasPeucker(pts, tolM) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push([pts[i][0], pts[i][1]]);
  return out;
}
function simplifyPts(pts, maxPts) {
  let out = pts.map(p => [p[0], p[1]]);
  let tol = 5;
  while (out.length > maxPts && tol <= 320) { out = douglasPeucker(pts, tol); tol *= 2; }
  return out;
}
function updateEditInfo() {
  let d = 0;
  for (let i = 1; i < editState.pts.length; i++) d += haversine(editState.pts[i - 1], editState.pts[i]);
  $("edit-info").textContent = `✏️ ${editState.pts.length} pts · ${fmtDist(d)}`;
}
function redrawEdit() {
  if (editState.group) map.removeLayer(editState.group);
  const g = L.layerGroup();
  editState.line = L.polyline(editState.pts, { color: "#ffd43b", weight: 4, dashArray: "8 6" }).addTo(g);
  editState.pts.forEach((p, i) => {
    const m = L.marker(p, { draggable: true, zIndexOffset: 600,
      icon: L.divIcon({ className: "edit-vtx", iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(g);
    m.on("drag", () => {
      const ll = m.getLatLng();
      editState.pts[i] = [ll.lat, ll.lng];
      editState.line.setLatLngs(editState.pts);
    });
    m.on("dragend", redrawEdit);
    m.on("click", () => {
      if (editState.pts.length <= 2) { toast("Un tracé garde au moins 2 points"); return; }
      if (confirm("Supprimer ce point ?")) { editState.pts.splice(i, 1); redrawEdit(); }
    });
  });
  /* ronds creux entre deux points : toucher pour insérer un point intermédiaire */
  for (let i = 0; i < editState.pts.length - 1; i++) {
    const a = editState.pts[i], b = editState.pts[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m = L.marker(mid, { zIndexOffset: 550,
      icon: L.divIcon({ className: "edit-mid", iconSize: [15, 15], iconAnchor: [8, 8] }) }).addTo(g);
    m.on("click", () => { editState.pts.splice(i + 1, 0, mid); redrawEdit(); });
  }
  g.addTo(map);
  editState.group = g;
  updateEditInfo();
}
function startEdit(t) {
  if (drawState.on || editState.id) return;
  closePanel();
  editState.id = t.id;
  const before = t.pts.length;
  editState.pts = simplifyPts(t.pts, 120);
  if (state.polylines.has(t.id)) { map.removeLayer(state.polylines.get(t.id)); state.polylines.delete(t.id); }
  $("edit-bar").classList.add("on");
  $("hud").style.display = "none";
  redrawEdit();
  if (editState.pts.length > 1)
    map.fitBounds(L.latLngBounds(editState.pts), { padding: [40, 40] });
  toast((before > editState.pts.length ? `Tracé simplifié en ${editState.pts.length} points pour l'édition. ` : "") +
    "Glissez les points jaunes ; point = supprimer ; rond creux = insérer ; carte = prolonger.", 8000);
}
function endEditUI() {
  if (editState.group) { map.removeLayer(editState.group); editState.group = null; }
  editState.id = null;
  editState.pts = [];
  $("edit-bar").classList.remove("on");
  $("hud").style.display = "";
}
$("edit-cancel").addEventListener("click", () => {
  const t = state.tracks.find(x => x.id === editState.id);
  endEditUI();
  if (t) drawTrack(t);
});
$("edit-save").addEventListener("click", async () => {
  const t = state.tracks.find(x => x.id === editState.id);
  const newPts = editState.pts.slice();
  endEditUI();
  if (!t || newPts.length < 2) { if (t) drawTrack(t); return; }
  const dense = densify(newPts);
  let eles = null;
  if (navigator.onLine) {
    toast("Recalcul des altitudes IGN…", 5000);
    try { eles = await fetchElevations(dense); }
    catch (err) { toast("Altitudes indisponibles — tracé enregistré sans profil"); }
  }
  t.pts = dense.map((p, i) => [p[0], p[1], eles ? eles[i] : null]);
  delete t.times;
  computeStats(t);
  await saveTrack(t);
  drawTrack(t);
  renderTrackList();
  drawProfile();
  toast(`Tracé « ${t.name} » modifié ✔ ${fmtDist(t.dist)} · D+ ${t.dplus} m`, 4000);
});

/* ================= Coordonnées d'un point ================= */
window.rcCopy = (txt) => {
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
    .then(() => toast("Coordonnées copiées ✔"))
    .catch(() => prompt("Copiez les coordonnées :", txt));
};
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/* sur iPhone/iPad, le schéma maps:// ouvre l'app Plans à coup sûr (le lien web
   maps.apple.com n'est pas toujours intercepté par Safari) */
const appleMapsUrl = (q) => IS_IOS ? `maps://?daddr=${q}&dirflg=d` : `https://maps.apple.com/?daddr=${q}&dirflg=d`;
const googleMapsUrl = (q) => `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
function coordLinks(lat, lon) {
  const q = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  /* pas de target="_blank" : échoue en silence dans les PWA iOS */
  return `<b>📍 ${lat.toFixed(5)}, ${lon.toFixed(5)}</b>` +
    `<a href="#" onclick="rcCopy('${q}');return false;">📋 Copier les coordonnées</a>` +
    `<a href="${appleMapsUrl(q)}" rel="noopener">🚗 Itinéraire avec Plans</a>` +
    `<a href="${googleMapsUrl(q)}" rel="noopener">🚗 Itinéraire avec Google Maps</a>`;
}
let lastCoordPopup = 0;
function openCoordPopup(ll) {
  lastCoordPopup = Date.now();
  L.popup().setLatLng(ll).setContent(coordLinks(ll.lat, ll.lng)).openOn(map);
}
/* clic droit (ordinateur) ou appui long natif (Chrome Android) */
map.on("contextmenu", (e) => {
  if (drawState.on || editState.id) return;
  if (Date.now() - lastCoordPopup < 1200) return; // déjà ouvert par l'appui long manuel
  openCoordPopup(e.latlng);
});
/* appui long manuel : Safari iOS ne déclenche jamais contextmenu sur la carte */
(() => {
  const el = map.getContainer();
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("touchstart", (ev) => {
    if (ev.touches.length !== 1 || drawState.on || editState.id) { cancel(); return; }
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const ll = map.containerPointToLatLng(
        map.mouseEventToContainerPoint({ clientX: sx, clientY: sy }));
      openCoordPopup(ll);
    }, 550);
  }, { passive: true });
  el.addEventListener("touchmove", (ev) => {
    if (timer && Math.hypot(ev.touches[0].clientX - sx, ev.touches[0].clientY - sy) > 12) cancel();
  }, { passive: true });
  el.addEventListener("touchend", cancel, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
})();

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
let snapMarker = null, snapLine = null;
function clearSnap() {
  if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
  if (snapLine) { map.removeLayer(snapLine); snapLine = null; }
}
/* index du segment de trace le plus proche ; privilégie la continuité de progression
   (évite de sauter sur la branche du retour dans un aller-retour) */
function snapToTrack(t, pt) {
  const seek = (from, to) => {
    let best = Infinity, idx = from;
    for (let i = from; i < to; i++) {
      const d = distToSegment(pt, t.pts[i], t.pts[i + 1]);
      if (d < best) { best = d; idx = i; }
    }
    return { idx, d: best };
  };
  const global = seek(0, t.pts.length - 1);
  const prev = nearestOnTrack.idx;
  if (prev >= 0 && prev < t.pts.length - 1) {
    const local = seek(Math.max(0, prev - 40), Math.min(t.pts.length - 1, prev + 200));
    if (local.d <= global.d + 15) return local;
  }
  return global;
}
function updateNavHUD() {
  const t = activeTrack();
  const show = (id, on) => $(id).classList.toggle("off", !on);
  if (!state.pos) {
    ["hud-speed","hud-alt","hud-acc","hud-gap","hud-nav"].forEach(i => show(i, false));
    clearSnap();
    return;
  }
  const p = state.pos;
  show("hud-speed", true); show("hud-alt", p.alt != null); show("hud-acc", true);
  $("hud-speed").querySelector("b").textContent = p.speed != null ? (p.speed * 3.6).toFixed(1) : "0.0";
  if (p.alt != null) $("hud-alt").querySelector("b").textContent = Math.round(p.alt);
  $("hud-acc").querySelector("b").textContent = "±" + Math.round(p.acc) + "m";
  if (t && t.pts.length > 1) {
    const snap = snapToTrack(t, [p.lat, p.lon]);
    nearestOnTrack.idx = snap.idx; nearestOnTrack.gap = snap.d;
    show("hud-gap", true);
    const gapEl = $("hud-gap").querySelector("b");
    gapEl.textContent = fmtDist(snap.d);
    gapEl.style.color = snap.d > 100 ? "var(--err)" : snap.d > 40 ? "var(--warn)" : "var(--ok)";

    /* bilan parcouru / restant */
    const done = t.cum[snap.idx], rest = Math.max(0, t.dist - done);
    const hasD = t.cumDplus && t.dplus > 0;
    const dpDone = hasD ? t.cumDplus[snap.idx] : 0;
    const dmDone = hasD ? t.cumDminus[snap.idx] : 0;
    const dpRest = hasD ? Math.max(0, t.dplus - dpDone) : 0;
    const dmRest = hasD ? Math.max(0, t.dminus - dmDone) : 0;
    const restMs = (rest / 4000 + dpRest / 300 + dmRest / 500) * 3600000;
    show("hud-nav", true);
    $("nav-done").innerHTML = `▶ Parcouru <b>${fmtDist(done)}</b>` +
      (hasD ? ` · D+ <b>${dpDone}</b> · D− <b>${dmDone} m</b>` : "");
    $("nav-rest").innerHTML = `⏳ Restant <b>${fmtDist(rest)}</b>` +
      (hasD ? ` · D+ <b>${dpRest}</b> · D− <b>${dmRest} m</b>` : "") +
      ` · ≈ <b>${fmtDur(restMs)}</b>`;

    /* projection de la position sur la trace */
    const sp = [t.pts[snap.idx][0], t.pts[snap.idx][1]];
    const here = [p.lat, p.lon];
    if (!snapMarker) {
      snapMarker = L.circleMarker(sp, { radius: 5, color: "#fff", weight: 2, fillColor: "#2b7de9",
        fillOpacity: 1, bubblingMouseEvents: false }).addTo(map);
      snapLine = L.polyline([here, sp], { color: "#fff", weight: 2, dashArray: "4 5", opacity: .7,
        interactive: false }).addTo(map);
    } else {
      snapMarker.setLatLng(sp);
      snapLine.setLatLngs([here, sp]);
    }
  } else {
    show("hud-gap", false); show("hud-nav", false);
    clearSnap();
  }
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
/* les tuiles sont comptées SANS matérialiser la liste : à faible zoom la liste
   ferait des millions d'entrées et Safari iOS tue la page (plantage récurrent) */
function tileRanges(zooms) {
  const b = map.getBounds();
  return zooms.map(z => ({ z, x1: lon2x(b.getWest(), z), x2: lon2x(b.getEast(), z),
                           y1: lat2y(b.getNorth(), z), y2: lat2y(b.getSouth(), z) }));
}
const countForRange = (r) => (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
const countTiles = (zooms) => tileRanges(zooms).reduce((n, r) => n + countForRange(r), 0);
function listTiles(zooms) {
  const list = [];
  for (const r of tileRanges(zooms))
    for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) list.push([r.z, x, y]);
  return list;
}

/* ---- choix des niveaux de zoom à télécharger ---- */
const ZOOM_LEVELS = [
  [10, "vue d'une région"],
  [11, "grand massif"],
  [12, "massif, vallées"],
  [13, "vallée en détail"],
  [14, "approche, sentiers visibles"],
  [15, "rando, bon détail"],
  [16, "détail fin (recommandé)"],
  [17, "très fin (très lourd)"],
];
const ZOOM_PRESETS = { rando: [12, 14, 16], leger: [12, 15], complet: [12, 13, 14, 15, 16] };
let selZooms = JSON.parse(localStorage.getItem("rc.zooms") || "null") || ZOOM_PRESETS.rando.slice();

function buildZoomRows() {
  const el = $("zoom-levels");
  el.innerHTML = "";
  for (const [z, label] of ZOOM_LEVELS) {
    const row = document.createElement("label");
    row.className = "zoom-row";
    row.innerHTML = `<input type="checkbox" data-z="${z}" ${selZooms.includes(z) ? "checked" : ""}>
      <span class="zoom-z">z${z}</span><span class="zoom-label">${label}</span>
      <span class="zoom-count" id="zc-${z}"></span>`;
    row.querySelector("input").addEventListener("change", () => {
      selZooms = [...el.querySelectorAll("input:checked")].map(i => +i.dataset.z);
      localStorage.setItem("rc.zooms", JSON.stringify(selZooms));
      updateEstimate();
    });
    el.appendChild(row);
  }
}
document.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => {
  selZooms = ZOOM_PRESETS[b.dataset.preset].slice();
  localStorage.setItem("rc.zooms", JSON.stringify(selZooms));
  buildZoomRows();
  updateEstimate();
}));

function updateEstimate() {
  if (!$("zoom-levels").children.length) return;
  const kb = LAYERS[state.layerId].kb;
  let total = 0;
  for (const [z] of ZOOM_LEVELS) {
    const el = $("zc-" + z);
    if (!el) continue;
    const n = countForRange(tileRanges([z])[0]);
    const mo = n * kb / 1024;
    el.textContent = `${n.toLocaleString("fr-FR")} tuiles · ${mo >= 10 ? mo.toFixed(0) : mo.toFixed(1)} Mo`;
    el.parentElement.classList.toggle("zsel", selZooms.includes(z));
    if (selZooms.includes(z)) total += n;
  }
  const mb = total * kb / 1024;
  $("dl-estimate").textContent = selZooms.length
    ? `Total : ${total.toLocaleString("fr-FR")} tuiles ≈ ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} Mo — fond « ${LAYERS[state.layerId].name} », zone affichée`
    : "Cochez au moins un niveau de zoom.";
  $("btn-download").disabled = !selZooms.length || total > 40000;
  $("dl-status").textContent = total > 40000 ? "Zone trop grande : réduisez la zone ou décochez des niveaux." : "";
}

async function downloadArea() {
  if (!navigator.onLine) { toast("Connexion nécessaire pour télécharger"); return; }
  const zooms = selZooms.filter(z => z <= LAYERS[state.layerId].maxZoom);
  if (!zooms.length) { toast("Cochez au moins un niveau de zoom"); return; }
  if (countTiles(zooms) > 40000) { toast("Zone trop grande : réduisez la zone ou les niveaux"); return; }
  const tiles = listTiles(zooms);
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

/* ================= Sauvegarde fichier (cartes + traces « en dur ») =================
   Format .rcz : "RCZ1" (4 o) + longueur JSON (4 o) + index JSON + données des tuiles
   concaténées. Le Blob assemble des références (pas de copie mémoire), et l'import lit
   le fichier par tranches — compatible avec les gros fichiers sur iPhone. */
const RCZ_MAGIC = 0x52435a31;
async function exportBackup() {
  toast("Préparation de la sauvegarde…", 8000);
  const tiles = [];
  await idb("tiles", "readonly", s => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { tiles.push([String(c.key), c.value]); c.continue(); }
    };
  });
  if (!tiles.length && !state.tracks.length) { toast("Rien à sauvegarder pour l'instant"); return; }
  const index = [], parts = [];
  let off = 0;
  for (const [k, blob] of tiles) {
    index.push({ k, o: off, n: blob.size });
    parts.push(blob);
    off += blob.size;
  }
  const tracks = state.tracks.map(t =>
    ({ id: t.id, name: t.name, color: t.color, visible: t.visible, pts: t.pts, wpts: t.wpts, times: t.times }));
  const metaBytes = new TextEncoder().encode(JSON.stringify({ v: 1, tracks, tiles: index }));
  const head = new ArrayBuffer(8);
  const dv = new DataView(head);
  dv.setUint32(0, RCZ_MAGIC);
  dv.setUint32(4, metaBytes.length);
  const blob = new Blob([head, metaBytes, ...parts], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `randocarte-${new Date().toISOString().slice(0, 10)}.rcz`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`Sauvegarde créée : ${(blob.size / 1048576).toFixed(0)} Mo (${tiles.length.toLocaleString("fr-FR")} tuiles, ${tracks.length} trace(s)) — cherchez-la dans Fichiers/Téléchargements`, 8000);
}
async function importBackup(file) {
  try {
    const dv = new DataView(await file.slice(0, 8).arrayBuffer());
    if (dv.getUint32(0) !== RCZ_MAGIC) { toast("Ce fichier n'est pas une sauvegarde RandoCarte (.rcz)"); return; }
    const metaLen = dv.getUint32(4);
    const meta = JSON.parse(new TextDecoder().decode(await file.slice(8, 8 + metaLen).arrayBuffer()));
    const base = 8 + metaLen;
    for (let i = 0; i < meta.tiles.length; i += 400) {
      const batch = meta.tiles.slice(i, i + 400);
      await idb("tiles", "readwrite", s => {
        for (const t of batch) s.put(file.slice(base + t.o, base + t.o + t.n), t.k);
      });
      $("dl-status").textContent = `Import : ${Math.min(i + 400, meta.tiles.length)}/${meta.tiles.length} tuiles…`;
      await new Promise(r => setTimeout(r));
    }
    let newTracks = 0;
    for (const tr of meta.tracks || []) {
      if (state.tracks.some(x => x.id === tr.id)) continue;
      computeStats(tr);
      if (!tr.color) tr.color = COLORS[state.tracks.length % COLORS.length];
      if (tr.visible == null) tr.visible = true;
      state.tracks.push(tr);
      await saveTrack(tr);
      drawTrack(tr);
      newTracks++;
    }
    renderTrackList();
    refreshStorage();
    $("dl-status").textContent = "";
    toast(`Sauvegarde importée ✔ ${meta.tiles.length.toLocaleString("fr-FR")} tuiles, ${newTracks} nouvelle(s) trace(s)`, 6000);
  } catch (err) {
    toast("Échec de l'import : " + (err.message || err), 6000);
  }
}
$("btn-backup").addEventListener("click", exportBackup);
$("btn-restore").addEventListener("click", () => $("backup-file").click());
$("backup-file").addEventListener("change", (e) => {
  if (e.target.files[0]) importBackup(e.target.files[0]);
  e.target.value = "";
});

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
const closePanel = () => { panel.classList.remove("open"); $("layer-quick").classList.remove("open"); };

/* sélecteur rapide de fond de carte (bouton 🗺️) */
function buildQuickLayers() {
  const el = $("layer-quick");
  el.innerHTML = "";
  for (const [id, l] of Object.entries(LAYERS)) {
    const b = document.createElement("button");
    b.textContent = l.name;
    if (id === state.layerId) b.className = "sel";
    b.addEventListener("click", () => {
      setLayer(id);
      document.querySelectorAll('input[name="layer"]').forEach(r => { r.checked = r.value === id; });
      el.classList.remove("open");
      toast(l.name);
    });
    el.appendChild(b);
  }
}
$("fab-layers").addEventListener("click", () => {
  buildQuickLayers();
  $("layer-quick").classList.toggle("open");
});
const openPanel = () => {
  panel.classList.add("open");
  updateEstimate(); refreshStorage();
};
$("fab-menu").addEventListener("click", () => {
  panel.classList.contains("open") ? closePanel() : openPanel();
});
$("panel-grip").addEventListener("click", closePanel);
map.on("click", closePanel);
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("sel", x === b));
  document.querySelectorAll(".tab-page").forEach(p =>
    p.classList.toggle("sel", p.id === "page-" + b.dataset.tab));
}));
/* glisser vers le bas sur la poignée ou les onglets pour fermer */
let panDragY = null;
[$("panel-grip"), $("tabs")].forEach(el => {
  el.addEventListener("touchstart", (e) => { panDragY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (panDragY != null && e.touches[0].clientY - panDragY > 30) { closePanel(); panDragY = null; }
  }, { passive: true });
  el.addEventListener("touchend", () => { panDragY = null; }, { passive: true });
});

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
  el.textContent = (navigator.onLine ? "En ligne" : "Hors ligne — cartes locales") +
    " · zoom " + map.getZoom();
}
window.addEventListener("online", netStatus);
window.addEventListener("offline", netStatus);
map.on("zoomend", netStatus);
netStatus();

/* mise à jour : on force la vérification du SW à chaque ouverture, et quand une
   nouvelle version prend la main, la page se recharge une fois pour que interface
   et code restent toujours synchronisés */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(reg => reg.update()).catch(() => {});
  let swReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloaded) return;
    swReloaded = true;
    location.reload();
  });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const verEl = document.getElementById("app-ver");
if (verEl) verEl.textContent = " Version " + APP_VERSION + ".";
if (SAFE_VIEW && !SAFE_TRACKS) toast("Redémarrage après incident : vue réinitialisée", 5000);

buildZoomRows();
loadTracks();
updateEstimate();
refreshStorage();

