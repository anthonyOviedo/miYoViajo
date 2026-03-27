import L from 'leaflet';
import { tileLayerOffline, savetiles } from 'leaflet.offline';
import { ROUTES } from './stops.js';

// ── Leaflet icon fix ──
import markerIconUrl from 'leaflet/dist/images/marker-icon.png?url';
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png?url';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIconUrl, iconRetinaUrl: markerIcon2xUrl, shadowUrl: markerShadowUrl });

const CR_BOUNDS = L.latLngBounds([8.03, -85.95], [11.22, -82.56]);
const LS_KEY = (i) => `miyoviajo_stops_${i}`;

// ── Mutable stops (localStorage override or original) ──
const routeStops = ROUTES.map((route, i) => {
  try {
    const saved = localStorage.getItem(LS_KEY(i));
    return saved ? JSON.parse(saved) : [...route.stops];
  } catch { return [...route.stops]; }
});

const DISCORD_WEBHOOK = import.meta.env.VITE_DISCORD_WEBHOOK;

// ── State ──
let map = null;
let offlineLayer = null;
let saveTilesControl = null;
let userLatLng = null;
let userMarker = null;
let activeRouteIdx = 0;
let stopMarkers = [];      // { marker, routeIdx, stopId }
let routePolylines = [];   // { shadow, casing, line, routeIdx }
let routeGeometries = [];  // lat/lng arrays from OSRM per route
let busMarkers = [];       // live bus markers
let editMode = false;
let pendingLatLng = null;
let trackingSession = null;  // active recording session
let lastSession = null;      // kept for summary after stopping
let wakeLock = null;

// ── Map ──
function initMap() {
  map = L.map('map', {
    center: [10.0, -84.2],
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
  });

  offlineLayer = tileLayerOffline(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19, crossOrigin: true }
  ).addTo(map);

  // Custom panes for proper z-ordering (shadow → casing → route → stops)
  map.createPane('routeShadow').style.zIndex = 390;
  map.createPane('routeCasing').style.zIndex = 395;
  map.createPane('routeLine').style.zIndex  = 400;
  map.createPane('stopDots').style.zIndex   = 410;
  map.createPane('busDots').style.zIndex    = 420;

  L.control.zoom({ position: 'topright' }).addTo(map);

  setupOfflineControl();
  drawRoutePolylines();
  addAllStopMarkers();
  fitRoute(activeRouteIdx);
}

// ── Route polylines (Waze style: real road geometry via OSRM) ──
function drawPolylineForRoute(routeIdx, coords) {
  routeGeometries[routeIdx] = coords;
  const route = ROUTES[routeIdx];

  const shadow = L.polyline(coords, {
    pane: 'routeShadow',
    color: 'rgba(0,0,0,0.22)', weight: 18,
    lineCap: 'round', lineJoin: 'round',
  }).addTo(map);

  const casing = L.polyline(coords, {
    pane: 'routeCasing',
    color: '#fff', weight: 13, opacity: 1,
    lineCap: 'round', lineJoin: 'round',
  }).addTo(map);

  const line = L.polyline(coords, {
    pane: 'routeLine',
    color: route.color, weight: 8, opacity: 0.95,
    lineCap: 'round', lineJoin: 'round',
  }).addTo(map);

  routePolylines.push({ shadow, casing, line, routeIdx });
  updatePolylinesVisibility();
}

async function fetchOSRM(routeIdx) {
  const stops   = routeStops[routeIdx];
  const origin  = stops.find(s => s.starts);
  const dest    = stops.find(s => s.ends);
  if (!origin || !dest) return null;

  const coordStr = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.routes?.[0]) {
    return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  }
  return null;
}

async function drawRoutePolylines() {
  for (let routeIdx = 0; routeIdx < ROUTES.length; routeIdx++) {
    const fallback = [...routeStops[routeIdx]]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map(s => [s.lat, s.lng]);
    try {
      const coords = await fetchOSRM(routeIdx);
      drawPolylineForRoute(routeIdx, coords || fallback);
    } catch {
      drawPolylineForRoute(routeIdx, fallback);
    }
  }
}

function updatePolylinesVisibility() {
  routePolylines.forEach(({ shadow, casing, line, routeIdx }) => {
    const active = routeIdx === activeRouteIdx;
    shadow.setStyle({ opacity: active ? 1 : 0 });
    casing.setStyle({ opacity: active ? 1 : 0.15 });
    line.setStyle({ opacity: active ? 1 : 0.15 });
  });
}

// ── Stop markers ──
function makeStopIcon(color, isTerminal) {
  const size = isTerminal ? 14 : 8;
  const bg   = isTerminal ? color : '#fff';
  const bw   = isTerminal ? 3 : 2;
  const bc   = isTerminal ? '#fff' : color;
  const shadow = isTerminal
    ? `box-shadow:0 0 0 3px ${color}33, 0 2px 6px rgba(0,0,0,0.3);`
    : `box-shadow:0 1px 4px rgba(0,0,0,0.28);`;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${bg};border:${bw}px solid ${bc};
      ${shadow}
      pointer-events:none;
    "></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function addAllStopMarkers() {
  ROUTES.forEach((route, routeIdx) => {
    routeStops[routeIdx].forEach((stop) => {
      addStopMarker(stop, routeIdx);
    });
  });
  updateMarkersVisibility();
}

function addStopMarker(stop, routeIdx) {
  const route = ROUTES[routeIdx];
  const isTerminal = stop.starts || stop.ends;
  const icon = makeStopIcon(route.color, isTerminal);
  const marker = L.marker([stop.lat, stop.lng], { icon, pane: 'stopDots', draggable: false })
    .addTo(map)
    .bindPopup(buildPopup(stop, route, routeIdx), { maxWidth: 230 })
    .on('click', () => {
      if (editMode && routeIdx === activeRouteIdx) {
        showDeleteConfirm(stop.id, routeIdx, marker);
      } else {
        setActiveRoute(routeIdx);
        highlightStop(stop.id);
      }
    });
  stopMarkers.push({ marker, routeIdx, stopId: stop.id });
}

function buildPopup(stop, route, routeIdx) {
  const origin = routeStops[routeIdx].find(s => s.starts);
  return `
    <div class="popup-route" style="background:${route.color}20;border-left:3px solid ${route.color};padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:0.72rem;font-weight:600;color:${route.color}">${route.short}</div>
    <div class="popup-title">${stop.title}</div>
    <div class="popup-sub">${stop.address}</div>
    <div class="popup-time">+${stop.time} desde ${stop.starts ? 'inicio' : origin?.title || 'inicio'}</div>
  `;
}

function showDeleteConfirm(stopId, routeIdx, marker) {
  marker.bindPopup(`
    <div style="text-align:center;padding:4px 0">
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:10px">¿Eliminar parada?</div>
      <button onclick="window._deleteStop(${stopId},${routeIdx})" style="background:#ef4444;color:#fff;border:none;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:0.82rem">Eliminar</button>
    </div>
  `, { maxWidth: 180 }).openPopup();
}

window._deleteStop = (stopId, routeIdx) => {
  routeStops[routeIdx] = routeStops[routeIdx].filter(s => s.id !== stopId);
  map.closePopup();
  rebuildMarkersAndRoute(routeIdx);
};

function updateMarkersVisibility() {
  stopMarkers.forEach(({ marker, routeIdx }) => {
    const el = marker.getElement();
    if (!el) return;
    el.style.opacity = routeIdx === activeRouteIdx ? '1' : '0';
    el.style.pointerEvents = routeIdx === activeRouteIdx ? 'auto' : 'none';
  });
  updatePolylinesVisibility();
}

function fitRoute(routeIdx) {
  const stops = routeStops[routeIdx];
  const bounds = L.latLngBounds(stops.map(s => [s.lat, s.lng]));
  map.fitBounds(bounds, { padding: [40, 40] });
}

// ── Route dropdown ──
function renderRouteDropdown() {
  const select = document.getElementById('route-select');
  ROUTES.forEach((route, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = route.name;
    select.appendChild(opt);
  });
  select.value = activeRouteIdx;
  select.addEventListener('change', () => setActiveRoute(Number(select.value)));
  updateDropdownColor();
}

function updateDropdownColor() {
  const select = document.getElementById('route-select');
  const color = ROUTES[activeRouteIdx].color;
  select.style.color = color;
  select.style.borderColor = color;
}

function setActiveRoute(idx) {
  if (idx === activeRouteIdx) return;
  activeRouteIdx = idx;

  document.getElementById('route-select').value = idx;
  updateDropdownColor();
  updateMarkersVisibility();
  renderStopsList();
  renderScheduleChips();
  updateNearestStop();
  fitRoute(idx);
  updateBuses();
}

// ── Schedule chips ──
function renderScheduleChips() {
  const container = document.getElementById('schedule-chips');
  container.innerHTML = '';
  const route = ROUTES[activeRouteIdx];
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay(); // 0=sun,6=sat
  const key = day === 0 ? 'domingo' : day === 6 ? 'sabado' : 'semana';
  const times = route.schedule[key] || route.schedule.semana;

  // Convert HH:MM to minutes
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  // Find next 4 departures
  const upcoming = times.filter(t => toMin(t) >= currentMinutes).slice(0, 4);
  const past = times.filter(t => toMin(t) < currentMinutes).slice(-1);
  const show = [...past, ...upcoming].slice(0, 4);

  if (show.length === 0) {
    container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">No hay más salidas hoy</span>';
    return;
  }

  show.forEach((time, i) => {
    const chip = document.createElement('div');
    const isNext = i === (past.length > 0 ? 1 : 0);
    chip.className = 'schedule-chip' + (isNext ? ' next' : '');
    chip.style.setProperty('--chip-color', ROUTES[activeRouteIdx].color);
    chip.textContent = time;
    container.appendChild(chip);
  });
}

// ── Stops list ──
function renderStopsList() {
  const select = document.getElementById('stops-select');
  select.innerHTML = '';
  const route = ROUTES[activeRouteIdx];
  const sorted = [...routeStops[activeRouteIdx]].sort((a, b) => a.time.localeCompare(b.time));

  sorted.forEach((stop) => {
    const opt = document.createElement('option');
    opt.value = stop.id;
    opt.textContent = `${stop.title}  (+${stop.time})`;
    select.appendChild(opt);
  });

  select.style.borderColor = route.color;

  select.onchange = () => {
    const stop = route.stops.find(s => s.id === select.value);
    if (!stop) return;
    map.setView([stop.lat, stop.lng], 16, { animate: true });
    expandPanel('half');
  };
}

function highlightStop(id) {
  const select = document.getElementById('stops-select');
  if (select) select.value = id;
}

// ── Geolocation ──
function createUserMarker(latlng) {
  const icon = L.divIcon({
    className: 'bus-marker',
    html: `<div class="user-marker-inner"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  return L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
}

function updateLocation(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  userLatLng = L.latLng(lat, lng);
  if (!userMarker) userMarker = createUserMarker(userLatLng);
  else userMarker.setLatLng(userLatLng);
  document.getElementById('location-dot').classList.add('active');
  document.getElementById('location-text').textContent = `Precisión ±${Math.round(accuracy)}m`;
  updateNearestStop();
  checkStopProximity();
}

function startGeolocation() {
  if (!navigator.geolocation) { document.getElementById('location-text').textContent = 'GPS no disponible'; return; }
  navigator.geolocation.watchPosition(updateLocation, () => {
    document.getElementById('location-text').textContent = 'No se pudo obtener ubicación';
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateNearestStop() {
  if (!userLatLng) return;
  let nearest = null, minDist = Infinity;
  routeStops[activeRouteIdx].forEach((s) => {
    const d = haversine(userLatLng.lat, userLatLng.lng, s.lat, s.lng);
    if (d < minDist) { minDist = d; nearest = s; }
  });
  if (!nearest) return;
  const distText = minDist < 1000 ? `${Math.round(minDist)} m` : `${(minDist / 1000).toFixed(1)} km`;
  document.getElementById('next-stop-name').textContent = nearest.title;
  document.getElementById('next-stop-dist').textContent = distText + ' de distancia';
  highlightStop(nearest.id);
}

// ── Offline ──
function setupOfflineControl() {
  saveTilesControl = savetiles(offlineLayer, {
    zoomlevels: [6, 7, 8, 9, 10, 11, 12, 13, 14],
    maxZoom: 14,
    bounds: CR_BOUNDS,
    confirm(layer, cb) { cb(); },
    confirmRemoval(layer, cb) { if (confirm('¿Eliminar el mapa descargado?')) cb(); },
  });

  offlineLayer.on('savestart', (e) => updateDownloadUI('downloading', 0, e._tilesforSave?.length || 0));
  offlineLayer.on('savetileend', (e) => updateDownloadUI('downloading', e._tilestoSave - (e._tilesforSave?.length || 0), e._tilestoSave));
  offlineLayer.on('loadend', () => { updateDownloadUI('done'); });
  offlineLayer.on('tilesremoved', () => updateDownloadUI('idle'));
}

function updateDownloadUI(state, saved = 0, total = 0) {
  const btn = document.getElementById('download-btn');
  const progress = document.getElementById('download-progress');
  const fill = document.getElementById('download-fill');
  const label = document.getElementById('download-label');
  if (!btn) return;

  if (state === 'downloading') {
    btn.disabled = true;
    btn.innerHTML = '⬇ Descargando...';
    if (progress) { progress.style.display = 'block'; const pct = total > 0 ? Math.round((saved / total) * 100) : 0; if (fill) fill.style.width = pct + '%'; if (label) label.textContent = `${saved} / ${total} tiles (${pct}%)`; }
  } else if (state === 'done') {
    btn.disabled = false;
    btn.className = 'saved';
    btn.innerHTML = '✓ Mapa guardado';
    if (progress) progress.style.display = 'none';
  } else {
    btn.disabled = false;
    btn.className = '';
    btn.innerHTML = '⬇ Descargar mapa';
    if (progress) progress.style.display = 'none';
  }
}

function setupDownloadButton() {
  document.getElementById('download-btn').addEventListener('click', () => {
    const btn = document.getElementById('download-btn');
    if (btn.classList.contains('saved')) { saveTilesControl._rmTiles(); }
    else { map.fitBounds(CR_BOUNDS); setTimeout(() => saveTilesControl._saveTiles(), 400); }
  });
}

// ── Center button ──
function setupCenterButton() {
  document.getElementById('center-btn').addEventListener('click', () => {
    if (userLatLng) map.setView(userLatLng, 15, { animate: true });
    else fitRoute(activeRouteIdx);
  });
}

// ── Draggable panel ──
function getPanelStates() {
  const vh = window.innerHeight;
  return { collapsed: 80, half: Math.round(vh * 0.45), expanded: Math.round(vh * 0.88) };
}

function expandPanel(state) {
  const panel = document.getElementById('bottom-panel');
  const states = getPanelStates();
  panel.classList.remove('collapsed', 'expanded');
  if (state === 'collapsed') panel.classList.add('collapsed');
  else if (state === 'expanded') panel.classList.add('expanded');
  panel.style.height = states[state] + 'px';
  setTimeout(() => map?.invalidateSize(), 350);
}

function setupDraggablePanel() {
  const panel = document.getElementById('bottom-panel');
  const handle = document.getElementById('panel-handle-area');
  let startY = 0, startH = 0, dragging = false;

  const onStart = (y) => { startY = y; startH = panel.offsetHeight; dragging = true; panel.style.transition = 'none'; };
  const onMove  = (y) => { if (!dragging) return; const s = getPanelStates(); panel.style.height = Math.min(s.expanded, Math.max(s.collapsed, startH + (startY - y))) + 'px'; };
  const onEnd   = (y) => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const s = getPanelStates();
    const h = panel.offsetHeight;
    const delta = startY - y;
    let target = h < (s.collapsed + s.half) / 2 ? 'collapsed' : h > (s.half + s.expanded) / 2 ? 'expanded' : 'half';
    if (Math.abs(delta) > 60) target = delta > 0 ? (h > s.half ? 'expanded' : 'half') : (h < s.half ? 'collapsed' : 'half');
    expandPanel(target);
  };

  handle.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove',  (e) => onMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener('touchend',   (e) => onEnd(e.changedTouches[0].clientY));
  handle.addEventListener('mousedown',  (e) => { onStart(e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove',  (e) => onMove(e.clientY));
  window.addEventListener('mouseup',    (e) => onEnd(e.clientY));
  handle.addEventListener('click', () => {
    const s = getPanelStates(); const h = panel.offsetHeight;
    expandPanel(h <= s.collapsed + 10 ? 'half' : h >= s.expanded - 10 ? 'half' : h < s.half ? 'half' : 'collapsed');
  });

  expandPanel('half');
}

// ── Live buses ──
function parseDurationMin(dur) {
  const h = dur.match(/(\d+)h/);
  const m = dur.match(/(\d+)min/);
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
}

function minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function nearestStopAtElapsed(routeIdx, elapsedMin) {
  const stops = routeStops[routeIdx];
  return stops.reduce((best, s) => {
    const diff = Math.abs(toMin(s.time) - elapsedMin);
    return diff < best.diff ? { stop: s, diff } : best;
  }, { stop: stops[0], diff: Infinity }).stop;
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function calcBearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function getPointAlongRoute(geometry, fraction) {
  if (!geometry || geometry.length < 2) return null;
  fraction = Math.max(0, Math.min(1, fraction));

  let totalLen = 0;
  const segs = [];
  for (let i = 0; i < geometry.length - 1; i++) {
    const d = haversine(geometry[i][0], geometry[i][1], geometry[i + 1][0], geometry[i + 1][1]);
    segs.push(d);
    totalLen += d;
  }

  const target = fraction * totalLen;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i] >= target) {
      const t = segs[i] > 0 ? (target - acc) / segs[i] : 0;
      const lat = geometry[i][0] + t * (geometry[i + 1][0] - geometry[i][0]);
      const lng = geometry[i][1] + t * (geometry[i + 1][1] - geometry[i][1]);
      const bearing = calcBearing(geometry[i][0], geometry[i][1], geometry[i + 1][0], geometry[i + 1][1]);
      return { lat, lng, bearing };
    }
    acc += segs[i];
  }
  const last = geometry[geometry.length - 1];
  return { lat: last[0], lng: last[1], bearing: 0 };
}

const BUS_YELLOW = '#f59e0b';

function makeBusIcon(bearing) {
  return L.divIcon({
    className: '',
    html: `<div class="bus-live" style="--bus-color:${BUS_YELLOW};transform:rotate(${bearing}deg)">
      <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="4" width="16" height="11" rx="2" fill="white"/>
        <rect x="3" y="5" width="14" height="7" rx="1" fill="${BUS_YELLOW}"/>
        <rect x="3" y="13" width="14" height="1" fill="${BUS_YELLOW}"/>
        <circle cx="5.5" cy="15.5" r="1.5" fill="#333"/>
        <circle cx="14.5" cy="15.5" r="1.5" fill="#333"/>
        <rect x="4" y="6" width="5" height="3" rx="0.5" fill="rgba(255,255,255,0.75)"/>
        <rect x="11" y="6" width="5" height="3" rx="0.5" fill="rgba(255,255,255,0.75)"/>
      </svg>
    </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function updateBuses() {
  busMarkers.forEach(m => m.remove());
  busMarkers = [];

  const geometry = routeGeometries[activeRouteIdx];
  if (!geometry) return;

  const route = ROUTES[activeRouteIdx];
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const dayKey = now.getDay() === 0 ? 'domingo' : now.getDay() === 6 ? 'sabado' : 'semana';
  const times = route.schedule[dayKey] || route.schedule.semana;

  times.forEach(dep => {
    const depMin = toMin(dep);
    const elapsed = curMin - depMin;
    if (elapsed < 0 || elapsed > ROUTE_DURATION_MIN) return;

    const fraction = elapsed / ROUTE_DURATION_MIN;
    const pt = getPointAlongRoute(geometry, fraction);
    if (!pt) return;

    const icon = makeBusIcon(route.color, pt.bearing, dep);
    const remaining = Math.round(ROUTE_DURATION_MIN - elapsed);
    const marker = L.marker([pt.lat, pt.lng], { icon, pane: 'busDots', zIndexOffset: 500 })
      .addTo(map)
      .bindPopup(`
        <div class="popup-route" style="background:${route.color}20;border-left:3px solid ${route.color};padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:0.72rem;font-weight:600;color:${route.color}">${route.short}</div>
        <div class="popup-title">Salida ${dep}</div>
        <div class="popup-sub">En ruta · ${remaining} min restantes</div>
      `, { maxWidth: 200 });
    busMarkers.push(marker);
  });
}

function startBusSimulation() {
  updateBuses();
  setInterval(updateBuses, 30_000);
}

// ── Edit mode ──
function toggleEditMode() {
  editMode = !editMode;
  document.getElementById('edit-btn').classList.toggle('active', editMode);
  document.getElementById('edit-bar').classList.toggle('hidden', !editMode);
  map.getContainer().style.cursor = editMode ? 'crosshair' : '';

  if (editMode) {
    map.on('click', onEditMapClick);
    stopMarkers.forEach(({ marker, routeIdx }) => {
      if (routeIdx !== activeRouteIdx) return;
      marker.dragging.enable();
      marker.on('dragend', onMarkerDragEnd);
    });
  } else {
    map.off('click', onEditMapClick);
    map.closePopup();
    stopMarkers.forEach(({ marker }) => {
      marker.dragging.disable();
      marker.off('dragend', onMarkerDragEnd);
    });
  }
}

function onEditMapClick(e) {
  if (e.originalEvent.target.closest?.('.leaflet-marker-icon')) return;
  pendingLatLng = e.latlng;
  document.getElementById('edit-stop-name').value = '';
  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-stop-name').focus(), 50);
}

function onMarkerDragEnd(e) {
  const marker = e.target;
  const { lat, lng } = marker.getLatLng();
  const entry = stopMarkers.find(m => m.marker === marker);
  if (!entry) return;
  const stop = routeStops[entry.routeIdx].find(s => s.id === entry.stopId);
  if (stop) { stop.lat = lat; stop.lng = lng; }
  rebuildRoute(entry.routeIdx);
}

function setupEditModal() {
  document.getElementById('edit-modal-cancel').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
    pendingLatLng = null;
  });

  document.getElementById('edit-modal-confirm').addEventListener('click', confirmAddStop);
  document.getElementById('edit-stop-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAddStop();
    if (e.key === 'Escape') document.getElementById('edit-modal').classList.add('hidden');
  });
}

function confirmAddStop() {
  const name = document.getElementById('edit-stop-name').value.trim();
  if (!name || !pendingLatLng) return;
  document.getElementById('edit-modal').classList.add('hidden');

  const newStop = {
    id: Date.now(),
    title: name,
    address: `${pendingLatLng.lat.toFixed(5)}, ${pendingLatLng.lng.toFixed(5)}`,
    lat: pendingLatLng.lat,
    lng: pendingLatLng.lng,
    time: '00:00',
    starts: 0,
    ends: 0,
  };
  routeStops[activeRouteIdx].push(newStop);
  pendingLatLng = null;
  rebuildMarkersAndRoute(activeRouteIdx);
}

function rebuildMarkersAndRoute(routeIdx) {
  // Remove markers for this route
  stopMarkers = stopMarkers.filter(({ marker, routeIdx: ri }) => {
    if (ri !== routeIdx) return true;
    marker.remove();
    return false;
  });
  // Re-add markers
  routeStops[routeIdx].forEach(stop => addStopMarker(stop, routeIdx));
  updateMarkersVisibility();
  // Re-enable drag if in edit mode
  if (editMode) {
    stopMarkers.forEach(({ marker, routeIdx: ri }) => {
      if (ri !== activeRouteIdx) return;
      marker.dragging.enable();
      marker.on('dragend', onMarkerDragEnd);
    });
  }
  renderStopsList();
  rebuildRoute(routeIdx);
}

async function rebuildRoute(routeIdx) {
  // Remove old polylines for this route
  routePolylines = routePolylines.filter(({ shadow, casing, line, routeIdx: ri }) => {
    if (ri !== routeIdx) return true;
    shadow.remove(); casing.remove(); line.remove();
    return false;
  });
  const fallback = [...routeStops[routeIdx]]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(s => [s.lat, s.lng]);
  try {
    const coords = await fetchOSRM(routeIdx);
    drawPolylineForRoute(routeIdx, coords || fallback);
  } catch {
    drawPolylineForRoute(routeIdx, fallback);
  }
  updatePolylinesVisibility();
}

function setupEditBar() {
  document.getElementById('edit-btn').addEventListener('click', toggleEditMode);

  document.getElementById('edit-save-btn').addEventListener('click', () => {
    localStorage.setItem(LS_KEY(activeRouteIdx), JSON.stringify(routeStops[activeRouteIdx]));
    document.getElementById('edit-bar-label').textContent = '✅ Guardado';
    setTimeout(() => {
      document.getElementById('edit-bar-label').textContent = '✏️ Toca el mapa para agregar parada';
    }, 1500);
  });

  document.getElementById('edit-reset-btn').addEventListener('click', () => {
    if (!confirm('¿Restaurar paradas originales?')) return;
    localStorage.removeItem(LS_KEY(activeRouteIdx));
    routeStops[activeRouteIdx] = [...ROUTES[activeRouteIdx].stops];
    rebuildMarkersAndRoute(activeRouteIdx);
  });
}

// ── Tracking / Registrar horario ──
function setupRecordButton() {
  document.getElementById('record-btn').addEventListener('click', () => {
    if (trackingSession) stopTracking();
    else showTrackStartModal();
  });
  document.getElementById('record-stop-btn').addEventListener('click', stopTracking);
  document.getElementById('track-start-cancel').addEventListener('click', () => {
    document.getElementById('track-start-modal').classList.add('hidden');
  });
  document.getElementById('track-start-confirm').addEventListener('click', confirmStartTracking);
  document.getElementById('summary-close').addEventListener('click', () => {
    document.getElementById('track-summary-modal').classList.add('hidden');
  });
  document.getElementById('summary-send').addEventListener('click', sendSummaryToDiscord);
}

function showTrackStartModal() {
  const route = ROUTES[activeRouteIdx];
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  const dayKey = now.getDay() === 0 ? 'domingo' : now.getDay() === 6 ? 'sabado' : 'semana';
  const times = route.schedule[dayKey] || route.schedule.semana;
  const past = times.filter(t => toMin(t) <= curMin);
  const suggested = past.length > 0 ? past[past.length - 1] : times[0];

  document.getElementById('track-dep-select').innerHTML =
    times.map(t => `<option value="${t}"${t === suggested ? ' selected' : ''}>${t}</option>`).join('');
  document.getElementById('track-start-modal').classList.remove('hidden');
}

function confirmStartTracking() {
  const depStr = document.getElementById('track-dep-select').value;
  document.getElementById('track-start-modal').classList.add('hidden');

  const [h, m] = depStr.split(':').map(Number);
  const now = new Date();
  const depMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();

  trackingSession = {
    routeIdx: activeRouteIdx,
    departureTime: depStr,
    departureMs: depMs,
    visited: new Map(),  // stopId → { stop, actualTime, elapsedMin }
  };

  document.getElementById('record-btn').classList.add('active');
  document.getElementById('record-bar').classList.remove('hidden');
  updateRecordBar();

  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(wl => { wakeLock = wl; }).catch(() => {});
  }
}

function stopTracking() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
  lastSession = trackingSession;
  trackingSession = null;
  document.getElementById('record-btn').classList.remove('active');
  document.getElementById('record-bar').classList.add('hidden');
  if (lastSession && lastSession.visited.size > 0) showTrackingSummary();
}

function updateRecordBar() {
  if (!trackingSession) return;
  const count = trackingSession.visited.size;
  const total = routeStops[trackingSession.routeIdx].length;
  document.getElementById('record-bar-count').textContent = `${count} / ${total} paradas`;
}

function checkStopProximity() {
  if (!trackingSession || !userLatLng) return;
  const { routeIdx, departureMs, visited } = trackingSession;
  routeStops[routeIdx].forEach(stop => {
    if (visited.has(stop.id)) return;
    if (haversine(userLatLng.lat, userLatLng.lng, stop.lat, stop.lng) > 250) return;

    const elapsedMin = (Date.now() - departureMs) / 60000;
    const hh = String(Math.floor(elapsedMin / 60)).padStart(2, '0');
    const mm = String(Math.floor(elapsedMin % 60)).padStart(2, '0');
    visited.set(stop.id, { stop, actualTime: `${hh}:${mm}`, elapsedMin });
    updateRecordBar();
    showRecordToast(stop.title);
  });
}

function showRecordToast(title) {
  const toast = document.getElementById('record-toast');
  toast.textContent = `Parada: ${title}`;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
}

function showTrackingSummary() {
  const { routeIdx, departureTime, visited } = lastSession;
  const stops = [...routeStops[routeIdx]].sort((a, b) => a.time.localeCompare(b.time));

  let rows = '';
  stops.forEach(stop => {
    if (!visited.has(stop.id)) return;
    const { actualTime, elapsedMin } = visited.get(stop.id);
    const [sh, sm] = stop.time.split(':').map(Number);
    const schedMin = sh * 60 + sm;
    const diff = Math.round(elapsedMin - schedMin);
    const diffStr = diff === 0 ? '=' : diff > 0 ? `+${diff}m` : `${diff}m`;
    const cls = Math.abs(diff) <= 1 ? 'diff-ok' : diff > 0 ? 'diff-late' : 'diff-early';
    rows += `<tr><td>${stop.title}</td><td>${stop.time}</td><td>${actualTime}</td><td class="${cls}">${diffStr}</td></tr>`;
  });

  document.getElementById('summary-dep').textContent = departureTime;
  document.getElementById('summary-count').textContent = visited.size;
  document.getElementById('summary-rows').innerHTML = rows;
  document.getElementById('track-summary-modal').classList.remove('hidden');
}

async function sendSummaryToDiscord() {
  if (!lastSession || !DISCORD_WEBHOOK) return;
  const { routeIdx, departureTime, visited } = lastSession;
  const route = ROUTES[routeIdx];
  const stops = [...routeStops[routeIdx]].sort((a, b) => a.time.localeCompare(b.time));

  let lines = [`**🚌 ${route.name}** — Salida ${departureTime}`, '```'];
  stops.forEach(stop => {
    if (!visited.has(stop.id)) return;
    const { actualTime, elapsedMin } = visited.get(stop.id);
    const [sh, sm] = stop.time.split(':').map(Number);
    const diff = Math.round(elapsedMin - sh * 60 - sm);
    const diffStr = diff === 0 ? '  ok' : diff > 0 ? `+${diff}m` : `${diff}m`;
    lines.push(`${actualTime}  ${diffStr.padStart(4)}  ${stop.title}`);
  });
  lines.push('```');

  try {
    const btn = document.getElementById('summary-send');
    btn.textContent = 'Enviando...';
    btn.disabled = true;
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
    btn.textContent = '✓ Enviado';
    setTimeout(() => { btn.textContent = 'Enviar a Discord'; btn.disabled = false; }, 2000);
  } catch {
    document.getElementById('summary-send').textContent = 'Error — reintentar';
    document.getElementById('summary-send').disabled = false;
  }
}

// ── Boot ──
initMap();
renderRouteDropdown();
renderStopsList();
renderScheduleChips();
startGeolocation();
setupCenterButton();
setupDraggablePanel();
setupDownloadButton();
setupEditBar();
setupEditModal();
setupRecordButton();
// buses start after route geometry loads (~1s)
setTimeout(startBusSimulation, 1500);
