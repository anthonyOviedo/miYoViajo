import L from 'leaflet';
import { ROUTES } from './stops.js';
import cachedGeometries from './route-geometries.json';

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

const DISCORD_SUMMARY_ENDPOINT = '/api/discord-summary';

// ── State ──
let map = null;
let tileLayer = null;
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
let boardedBus = null;       // { routeIdx, dep, depMin } — bus que sigue al usuario
let lastMovementSample = null; // { lat, lng, t } para calcular velocidad
let movementPromptShown = false;
let lastSession = null;      // kept for summary after stopping
let wakeLock = null;
let recordingTracePoints = [];  // puntos del trazo en tiempo real
let recordingTracePolyline = null;  // polyline verde del trazo

// ── Map ──
function initMap() {
  map = L.map('map', {
    center: [10.0, -84.2],
    zoom: 11,
    zoomControl: false,
    attributionControl: true,
  });

  tileLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19 }
  ).addTo(map);

  // Custom panes for proper z-ordering (shadow → casing → route → stops)
  map.createPane('routeShadow').style.zIndex = 390;
  map.createPane('routeCasing').style.zIndex = 395;
  map.createPane('routeLine').style.zIndex  = 400;
  map.createPane('stopDots').style.zIndex   = 410;
  map.createPane('busDots').style.zIndex    = 420;

  L.control.zoom({ position: 'topright' }).addTo(map);

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const data = await resp.json();
    if (data.routes?.[0]) {
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function drawRoutePolylines() {
  for (let routeIdx = 0; routeIdx < ROUTES.length; routeIdx++) {
    const slug = ROUTES[routeIdx].slug;
    const cached = cachedGeometries[slug];
    if (cached) {
      drawPolylineForRoute(routeIdx, cached);
    } else {
      const fallback = [...routeStops[routeIdx]]
        .sort((a, b) => a.time.localeCompare(b.time))
        .map(s => [s.lat, s.lng]);
      drawPolylineForRoute(routeIdx, fallback);
    }
  }
  updateBuses();
}

function updatePolylinesVisibility() {
  routePolylines.forEach(({ shadow, casing, line, routeIdx }) => {
    const active = routeIdx === activeRouteIdx;
    const recording = trackingSession && routeIdx === trackingSession.routeIdx;

    shadow.setStyle({ opacity: active ? 1 : 0 });
    casing.setStyle({ opacity: active ? 1 : 0.15 });

    // Si se está grabando, usa color especial (amarillo/naranja)
    const lineColor = recording ? '#f59e0b' : ROUTES[routeIdx].color;
    const lineOpacity = active ? 1 : 0.15;
    const lineWeight = recording ? 12 : 8;  // más grueso cuando se graba

    line.setStyle({
      color: lineColor,
      opacity: lineOpacity,
      weight: lineWeight,
    });

    // Agregar clase CSS para animación si se está grabando
    if (recording) {
      line.getElement()?.classList.add('recording-route');
    } else {
      line.getElement()?.classList.remove('recording-route');
    }
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

window._abordarBus = (routeIdx, depStr, depMin) => {
  if (readBoardedCookie()) return; // ya hay un bus abordado en esta sesión
  boardedBus = { routeIdx, dep: depStr, depMin };
  writeBoardedCookie(boardedBus);
  syncBoardedBusToUser();
  updateBuses();
  renderBoardedPanel();
  const nearestToUser = nearestStopToUser(routeIdx);
  const infoEl = document.getElementById(`abordar-info-${depMin}`);
  if (!nearestToUser) {
    if (infoEl) infoEl.innerHTML = `<div style="font-size:0.75rem;color:#ef4444">Sin ubicación GPS disponible</div>`;
    return;
  }
  const route = ROUTES[routeIdx];
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const elapsed = curMin - depMin;
  const etaMin = Math.round(toMin(nearestToUser.time) - elapsed);
  if (infoEl) {
    infoEl.innerHTML = `
      <div style="background:#f3f4f8;border-radius:8px;padding:6px 8px">
        <div style="font-size:0.65rem;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:2px">Tu parada más cercana</div>
        <div style="font-size:0.82rem;font-weight:700;color:#1a1a2e">${nearestToUser.title}</div>
        <div style="font-size:0.78rem;color:${route.color};font-weight:600;margin-top:2px">${etaMin <= 0 ? 'Ya pasó' : `Llega en ${etaMin} min`}</div>
      </div>`;
  }

  // Auto-iniciar grabación de ruta para esta salida
  if (!trackingSession) {
    const [h, m] = depStr.split(':').map(Number);
    const depMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
    trackingSession = {
      routeIdx,
      departureTime: depStr,
      departureMs: depMs,
      visited: new Map(),
    };
    document.getElementById('record-btn').classList.add('active');
    document.getElementById('record-bar')?.classList.remove('hidden');
    updateRecordBar();
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(wl => { wakeLock = wl; }).catch(() => {});
    }
    checkStopProximity();
  }
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

function fitRoute(routeIdx, zoom = false) {
  const stops = routeStops[routeIdx];
  const bounds = L.latLngBounds(stops.map(s => [s.lat, s.lng]));
  // Si zoom=true, acerca más (padding más pequeño)
  const padding = zoom ? [0, 0] : [40, 40];
  map.fitBounds(bounds, { padding });
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
  updatePolylinesVisibility();
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
  const container = document.getElementById('stops-items');
  if (!container) return;
  container.innerHTML = '';
  const route = ROUTES[activeRouteIdx];
  const sorted = [...routeStops[activeRouteIdx]].sort((a, b) => a.time.localeCompare(b.time));

  sorted.forEach((stop, idx) => {
    const isTerminal = stop.starts || stop.ends;
    const isLast = idx === sorted.length - 1;
    const item = document.createElement('div');
    item.className = 'stop-item';
    item.dataset.id = stop.id;
    item.innerHTML = `
      <div class="stop-timeline">
        <div class="stop-dot ${isTerminal ? 'terminal' : ''}" style="${isTerminal ? `--dot-color:${route.color}` : ''}"></div>
        ${!isLast ? '<div class="stop-line"></div>' : ''}
      </div>
      <div class="stop-info">
        <div class="stop-name">${stop.title}</div>
        <div class="stop-meta">${stop.address}</div>
      </div>
      <div class="stop-time-badge">+${stop.time}</div>
    `;
    item.addEventListener('click', () => {
      map.setView([stop.lat, stop.lng], 16, { animate: true });
      expandPanel('half');
    });
    container.appendChild(item);
  });
}

function highlightStop(id) {
  document.querySelectorAll('.stop-item').forEach(el => el.classList.remove('highlighted'));
  document.querySelectorAll('.stop-dot').forEach(el => el.classList.remove('nearest'));
  const item = document.querySelector(`.stop-item[data-id="${id}"]`);
  if (item) {
    item.classList.add('highlighted');
    item.querySelector('.stop-dot')?.classList.add('nearest');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
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
  updateRecordingTrace();  // Actualizar trazo si está grabando
  syncBoardedBusToUser();
  detectMovement();
}

function detectMovement() {
  if (!userLatLng) return;
  const now = Date.now();
  if (!lastMovementSample) {
    lastMovementSample = { lat: userLatLng.lat, lng: userLatLng.lng, t: now };
    return;
  }
  const dt = (now - lastMovementSample.t) / 1000;
  if (dt < 5) return;
  const dist = haversine(lastMovementSample.lat, lastMovementSample.lng, userLatLng.lat, userLatLng.lng);
  const speed = dist / dt; // m/s
  lastMovementSample = { lat: userLatLng.lat, lng: userLatLng.lng, t: now };

  if (boardedBus) { movementPromptShown = false; return; }
  if (speed < 2) { movementPromptShown = false; return; }
  if (movementPromptShown) return;
  promptBoardBus();
}

function getActiveBusesOnRoute(routeIdx) {
  const route = ROUTES[routeIdx];
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const dayKey = now.getDay() === 0 ? 'domingo' : now.getDay() === 6 ? 'sabado' : 'semana';
  const times = route.schedule[dayKey] || route.schedule.semana;
  const durationMin = parseDurationMin(route.duration);
  return times.filter(dep => {
    const elapsed = curMin - toMin(dep);
    return elapsed >= 0 && elapsed <= durationMin;
  });
}

function promptBoardBus() {
  const active = getActiveBusesOnRoute(activeRouteIdx);
  if (!active.length) return;
  movementPromptShown = true;
  const route = ROUTES[activeRouteIdx];
  const existing = document.getElementById('movement-prompt');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'movement-prompt';
  el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:12px 14px;z-index:9999;max-width:90vw;width:320px';
  el.innerHTML = `
    <div style="font-size:0.78rem;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:4px">Detectamos movimiento</div>
    <div style="font-size:0.92rem;font-weight:700;color:#1a1a2e;margin-bottom:8px">¿Cuál bus abordaste?</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${active.map(dep => `<button data-dep="${dep}" style="background:${route.color};color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.8rem;font-weight:600">${dep}</button>`).join('')}
    </div>
    <button id="movement-prompt-dismiss" style="width:100%;background:#f3f4f8;color:#6b7280;border:none;padding:6px;border-radius:6px;cursor:pointer;font-size:0.75rem">Ninguno</button>
  `;
  document.body.appendChild(el);
  el.querySelectorAll('button[data-dep]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dep = btn.dataset.dep;
      window._abordarBus(activeRouteIdx, dep, toMin(dep));
      el.remove();
    });
  });
  el.querySelector('#movement-prompt-dismiss').addEventListener('click', () => el.remove());
}

function syncBoardedBusToUser() {
  if (!boardedBus || !userLatLng) return;
  const m = busMarkers.find(mk => mk._routeIdx === boardedBus.routeIdx && mk._depMin === boardedBus.depMin);
  if (m) m.setLatLng(userLatLng);
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

function nearestStopToUser(routeIdx) {
  if (!userLatLng) return null;
  const stops = routeStops[routeIdx];
  if (!stops || !stops.length) return null;
  let best = null, bestDist = Infinity;
  for (const s of stops) {
    const d = haversine(userLatLng.lat, userLatLng.lng, s.lat, s.lng);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
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
  // SVG drawn facing right (east=90°), so offset bearing by -90 to align with map
  const rot = bearing - 90;
  return L.divIcon({
    className: '',
    html: `<div class="bus-live" style="transform:rotate(${rot}deg)">
      <svg viewBox="0 0 32 18" xmlns="http://www.w3.org/2000/svg" width="32" height="18">
        <!-- Body -->
        <rect x="1" y="2" width="30" height="12" rx="2.5" fill="white"/>
        <rect x="2" y="3" width="28" height="10" rx="1.5" fill="${BUS_YELLOW}"/>
        <!-- Windows -->
        <rect x="3"  y="4" width="4" height="4" rx="0.8" fill="rgba(255,255,255,0.85)"/>
        <rect x="9"  y="4" width="4" height="4" rx="0.8" fill="rgba(255,255,255,0.85)"/>
        <rect x="15" y="4" width="4" height="4" rx="0.8" fill="rgba(255,255,255,0.85)"/>
        <!-- Front windshield -->
        <rect x="23" y="4" width="5" height="5" rx="0.8" fill="rgba(255,255,255,0.95)"/>
        <!-- Front bumper -->
        <rect x="29" y="7" width="2" height="2" rx="1" fill="#ccc"/>
        <!-- Wheels -->
        <circle cx="8"  cy="15.5" r="2.5" fill="#222"/>
        <circle cx="8"  cy="15.5" r="1"   fill="#555"/>
        <circle cx="23" cy="15.5" r="2.5" fill="#222"/>
        <circle cx="23" cy="15.5" r="1"   fill="#555"/>
      </svg>
    </div>`,
    iconSize: [32, 18],
    iconAnchor: [16, 9],
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

  const durationMin = parseDurationMin(route.duration);

  times.forEach(dep => {
    const depMin = toMin(dep);
    const elapsed = curMin - depMin;
    if (elapsed < 0 || elapsed > durationMin) return;

    const fraction = elapsed / durationMin;
    let pt = getPointAlongRoute(geometry, fraction);
    if (!pt) return;

    const isBoarded = boardedBus && boardedBus.routeIdx === activeRouteIdx && boardedBus.depMin === depMin;
    if (isBoarded && userLatLng) {
      pt = { lat: userLatLng.lat, lng: userLatLng.lng, bearing: pt.bearing };
    }

    const icon = makeBusIcon(pt.bearing);
    const arrivalStr = minToHHMM(depMin + durationMin);
    const remaining = Math.round(durationMin - elapsed);
    const nearest = nearestStopAtElapsed(activeRouteIdx, elapsed);
    const origin = routeStops[activeRouteIdx].find(s => s.starts);
    const dest   = routeStops[activeRouteIdx].find(s => s.ends);

    const marker = L.marker([pt.lat, pt.lng], { icon, pane: 'busDots', zIndexOffset: 500 })
      .addTo(map);
    marker._routeIdx = activeRouteIdx;
    marker._depMin = depMin;
    marker
      .bindPopup(`
        <div class="popup-route" style="background:${route.color}20;border-left:3px solid ${route.color};padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:0.72rem;font-weight:600;color:${route.color}">${route.short}</div>
        <div class="popup-title" style="margin-bottom:8px">${route.name}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
          <div style="background:#f3f4f8;border-radius:8px;padding:6px 8px">
            <div style="font-size:0.65rem;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:2px">Salida</div>
            <div style="font-size:0.95rem;font-weight:700;color:#1a1a2e">${dep}</div>
            <div style="font-size:0.68rem;color:#6b7280">${origin?.title || ''}</div>
          </div>
          <div style="background:#f3f4f8;border-radius:8px;padding:6px 8px">
            <div style="font-size:0.65rem;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:2px">Llegada</div>
            <div style="font-size:0.95rem;font-weight:700;color:#1a1a2e">${arrivalStr}</div>
            <div style="font-size:0.68rem;color:#6b7280">${dest?.title || ''}</div>
          </div>
        </div>
        ${isBoarded ? '' : `<div style="font-size:0.78rem;color:#6b7280">Cerca de <strong style="color:#1a1a2e">${nearest.title}</strong></div>`}
        <div style="font-size:0.78rem;color:${route.color};font-weight:600;margin-top:2px">${remaining} min restantes</div>
        <div id="abordar-info-${depMin}" style="margin-top:6px"></div>
        ${isBoarded
          ? `<div style="margin-top:8px;width:100%;background:${route.color};color:#fff;padding:8px 12px;border-radius:8px;font-size:0.82rem;font-weight:700;text-align:center;letter-spacing:0.5px">✓ ABORDADO</div>`
          : `<button onclick="window._abordarBus(${activeRouteIdx},'${dep}',${depMin})" style="margin-top:8px;width:100%;background:${route.color};color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:0.82rem;font-weight:600">Abordar</button>`}
      `, { maxWidth: 240 });
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
  document.getElementById('record-stop-btn')?.addEventListener('click', stopTracking);
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

  // Limpiar trazo anterior
  recordingTracePoints = [];
  if (recordingTracePolyline) {
    map.removeLayer(recordingTracePolyline);
    recordingTracePolyline = null;
  }

  saveTrackingSession();
  document.getElementById('record-btn').classList.add('active');
  document.getElementById('record-bar')?.classList.remove('hidden');
  updateRecordBar();
  updatePolylinesVisibility();  // Actualizar color de ruta grabada

  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(wl => { wakeLock = wl; }).catch(() => {});
  }
}

function stopTracking() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
  lastSession = trackingSession;
  trackingSession = null;
  clearTrackingSession();  // Limpiar almacenamiento
  boardedBus = null;
  clearBoardedCookie();

  // Limpiar trazo de grabación
  if (recordingTracePolyline) {
    map.removeLayer(recordingTracePolyline);
    recordingTracePolyline = null;
    recordingTracePoints = [];
  }

  renderBoardedPanel();
  document.getElementById('record-btn').classList.remove('active');
  document.getElementById('record-bar')?.classList.add('hidden');
  updatePolylinesVisibility();  // Restaurar color de ruta
  if (lastSession && lastSession.visited.size > 0) showTrackingSummary();
}

function updateRecordBar() {
  if (!trackingSession) return;
  const count = trackingSession.visited.size;
  const total = routeStops[trackingSession.routeIdx].length;
  const el = document.getElementById('record-bar-count');
  if (el) el.textContent = `${count} / ${total} paradas`;
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
    saveStopHistory(routeIdx, stop.id, trackingSession.departureTime, elapsedMin);
    saveTrackingSession();  // Guardar sesión con parada detectada
    updateRecordBar();
    showRecordToast(stop.title);
  });
}

function updateRecordingTrace() {
  // Si no estamos grabando o abordados, limpiar el trazo
  if (!trackingSession || !boardedBus || !userLatLng) {
    if (recordingTracePolyline) {
      map.removeLayer(recordingTracePolyline);
      recordingTracePolyline = null;
      recordingTracePoints = [];
    }
    return;
  }

  // Agregar punto actual si está suficientemente lejos del último punto
  const lastPoint = recordingTracePoints[recordingTracePoints.length - 1];
  if (lastPoint) {
    const dist = haversine(lastPoint.lat, lastPoint.lng, userLatLng.lat, userLatLng.lng);
    if (dist < 10) return;  // No agregar puntos muy cercanos (ruido)
  }

  recordingTracePoints.push({ lat: userLatLng.lat, lng: userLatLng.lng });

  // Actualizar o crear la polyline
  if (recordingTracePolyline) {
    recordingTracePolyline.setLatLngs(recordingTracePoints);
  } else {
    recordingTracePolyline = L.polyline(recordingTracePoints, {
      color: '#22c55e',  // Verde
      weight: 4,
      opacity: 0.8,
      lineCap: 'round',
      lineJoin: 'round',
      pane: 'routeLine',
    }).addTo(map);
  }
}

// ── Persistencia de sesión de grabación ──
const TRACKING_SESSION_KEY = 'miyoviajo_tracking_session';

function saveTrackingSession() {
  if (!trackingSession) {
    localStorage.removeItem(TRACKING_SESSION_KEY);
    return;
  }
  const sessionData = {
    routeIdx: trackingSession.routeIdx,
    departureTime: trackingSession.departureTime,
    departureMs: trackingSession.departureMs,
    visited: Array.from(trackingSession.visited.entries()),
  };
  try {
    localStorage.setItem(TRACKING_SESSION_KEY, JSON.stringify(sessionData));
  } catch {}
}

function loadTrackingSession() {
  try {
    const data = JSON.parse(localStorage.getItem(TRACKING_SESSION_KEY));
    if (!data) return null;
    // Validar que la ruta exista y que no haya expirado
    const route = ROUTES[data.routeIdx];
    if (!route) return null;
    const now = new Date();
    const dur = parseDurationMin(route.duration);
    const elapsed = (now.getTime() - data.departureMs) / 60000;
    if (elapsed < 0 || elapsed > dur + 60) return null; // +60 min de tolerancia
    return {
      routeIdx: data.routeIdx,
      departureTime: data.departureTime,
      departureMs: data.departureMs,
      visited: new Map(data.visited),
    };
  } catch {
    return null;
  }
}

function clearTrackingSession() {
  localStorage.removeItem(TRACKING_SESSION_KEY);
}

// ── Cookie de bus abordado ──
const BOARDED_COOKIE = 'miyoviajo_boarded';

function writeBoardedCookie(bus) {
  // Expira al final del día (cuando termina cualquier ruta razonable)
  const exp = new Date();
  exp.setHours(23, 59, 59, 0);
  document.cookie = `${BOARDED_COOKIE}=${encodeURIComponent(JSON.stringify(bus))}; expires=${exp.toUTCString()}; path=/; SameSite=Lax`;
}

function readBoardedCookie() {
  const m = document.cookie.split('; ').find(c => c.startsWith(BOARDED_COOKIE + '='));
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m.split('=')[1])); }
  catch { return null; }
}

function clearBoardedCookie() {
  document.cookie = `${BOARDED_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

function restoreTrackingSession() {
  if (trackingSession) return;  // Ya hay una sesión activa
  const saved = loadTrackingSession();
  if (!saved) return;
  trackingSession = saved;

  // Cambiar a la ruta que se estaba grabando
  if (saved.routeIdx !== activeRouteIdx) {
    setActiveRoute(saved.routeIdx);
  }

  document.getElementById('record-btn')?.classList.add('active');
  document.getElementById('record-bar')?.classList.remove('hidden');
  updateRecordBar();
  updatePolylinesVisibility();  // Aplicar color de ruta grabada
}

function restoreBoardedFromCookie() {
  const saved = readBoardedCookie();
  if (!saved) return;
  // Verificar que el bus aún esté activo (no haya terminado su recorrido)
  const route = ROUTES[saved.routeIdx];
  if (!route) { clearBoardedCookie(); return; }
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  const elapsed = curMin - saved.depMin;
  const dur = parseDurationMin(route.duration);
  if (elapsed < 0 || elapsed > dur) { clearBoardedCookie(); return; }
  boardedBus = saved;
  // Restaurar también la sesión de grabación
  if (!trackingSession) {
    const [h, m] = saved.dep.split(':').map(Number);
    const depMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
    trackingSession = { routeIdx: saved.routeIdx, departureTime: saved.dep, departureMs: depMs, visited: new Map() };
    document.getElementById('record-btn')?.classList.add('active');
    document.getElementById('record-bar')?.classList.remove('hidden');
    updateRecordBar();
    updatePolylinesVisibility();  // Aplicar color de ruta grabada
  }
  renderBoardedPanel();
}

function renderBoardedPanel() {
  const nextStop = document.getElementById('next-stop-section');
  const sched = document.getElementById('schedule-section');
  const boarded = document.getElementById('boarded-section');
  if (!boarded) return;

  if (!boardedBus) {
    nextStop.classList.remove('hidden');
    sched.classList.remove('hidden');
    boarded.classList.add('hidden');
    return;
  }

  nextStop.classList.add('hidden');
  sched.classList.add('hidden');
  boarded.classList.remove('hidden');

  const route = ROUTES[boardedBus.routeIdx];
  const dest = routeStops[boardedBus.routeIdx].find(s => s.ends);
  document.getElementById('boarded-route').textContent = route.name;
  document.getElementById('boarded-dep').textContent = boardedBus.dep;

  // Llegada: usa promedio histórico de la parada destino para ese día/hora
  const dayKey = ['domingo','semana','semana','semana','semana','semana','sabado'][new Date().getDay()];
  const depHour = parseInt(boardedBus.dep.split(':')[0], 10);
  let arrText = '—', meta = 'sin historial';
  if (dest) {
    const avg = getStopAverage(route.id, dest.id, dayKey, depHour);
    if (avg) {
      const arrMin = boardedBus.depMin + avg.avgMin;
      arrText = minToHHMM(arrMin);
      meta = `promedio de ${avg.samples} viaje${avg.samples === 1 ? '' : 's'}`;
    } else {
      // Fallback: duración programada
      const dur = parseDurationMin(route.duration);
      arrText = minToHHMM(boardedBus.depMin + dur) + ' (est.)';
      meta = 'horario programado';
    }
  }
  document.getElementById('boarded-arr').textContent = arrText;
  document.getElementById('boarded-arr-meta').textContent = meta;

  // ETA OSRM (tráfico libre) desde la ubicación del usuario
  const osrmEl = document.getElementById('boarded-osrm');
  if (dest && userLatLng) {
    osrmEl.textContent = 'Calculando…';
    const url = `https://router.project-osrm.org/route/v1/driving/${userLatLng.lng},${userLatLng.lat};${dest.lng},${dest.lat}?overview=false`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (!data.routes || !data.routes[0]) { osrmEl.textContent = '—'; return; }
        const sec = data.routes[0].duration;
        const mins = Math.round(sec / 60);
        const arrAt = new Date(Date.now() + sec * 1000);
        const hh = String(arrAt.getHours()).padStart(2, '0');
        const mm = String(arrAt.getMinutes()).padStart(2, '0');
        osrmEl.textContent = `${hh}:${mm} · ${mins} min`;
      })
      .catch(() => { osrmEl.textContent = '—'; });
  } else {
    osrmEl.textContent = userLatLng ? '—' : 'sin GPS';
  }
}

// ── Histórico de tiempos por parada ──
const STOP_HISTORY_KEY = 'miyoviajo_stop_history';

function loadStopHistory() {
  try { return JSON.parse(localStorage.getItem(STOP_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveStopHistory(routeIdx, stopId, departureTime, elapsedMin) {
  const route = ROUTES[routeIdx];
  const now = new Date();
  const dayKey = now.getDay() === 0 ? 'domingo' : now.getDay() === 6 ? 'sabado' : 'semana';
  const depHour = parseInt(departureTime.split(':')[0], 10);
  const history = loadStopHistory();
  history.push({
    routeId: route.id,
    stopId,
    dayKey,
    depHour,
    departureTime,
    elapsedMin,
    timestamp: now.toISOString(),
  });
  // Cap a 5000 entradas para evitar crecer indefinidamente
  if (history.length > 5000) history.splice(0, history.length - 5000);
  try { localStorage.setItem(STOP_HISTORY_KEY, JSON.stringify(history)); } catch {}
}

// Promedio de elapsedMin para una parada en un día/hora dados
function getStopAverage(routeId, stopId, dayKey, depHour) {
  const matches = loadStopHistory().filter(r =>
    r.routeId === routeId && r.stopId === stopId &&
    r.dayKey === dayKey && r.depHour === depHour
  );
  if (!matches.length) return null;
  const sum = matches.reduce((a, r) => a + r.elapsedMin, 0);
  return { avgMin: sum / matches.length, samples: matches.length };
}

window._getStopAverage = getStopAverage;
window._dumpStopHistory = loadStopHistory;

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
  if (!lastSession) return;
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
    await fetch(DISCORD_SUMMARY_ENDPOINT, {
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
// Restaurar sesión de grabación si existe, antes de inicializar el mapa
const savedSession = loadTrackingSession();
if (savedSession) {
  activeRouteIdx = savedSession.routeIdx;
  trackingSession = savedSession;
}

initMap();
renderRouteDropdown();
renderStopsList();
renderScheduleChips();
startGeolocation();
setupCenterButton();
setupDraggablePanel();
setupEditBar();
setupEditModal();
setupRecordButton();

// Aplicar estilos de grabación si se restauró sesión
if (trackingSession) {
  document.getElementById('record-btn')?.classList.add('active');
  document.getElementById('record-bar')?.classList.remove('hidden');
  // Acercar más cuando se restaura grabación
  fitRoute(activeRouteIdx, true);
}

// buses start after route geometry loads (~1s)
setTimeout(() => { startBusSimulation(); restoreBoardedFromCookie(); }, 1500);

// ── PWA: Detectar actualizaciones del Service Worker ──
window.addEventListener('sw-update-ready', () => {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 20px;
    right: 20px;
    background: #0ea5e9;
    color: white;
    padding: 14px 16px;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 5000;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.9rem;
  `;
  notification.innerHTML = `
    <span>Actualización disponible</span>
    <button onclick="window.location.reload()" style="background:#fff;color:#0ea5e9;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600">Recargar</button>
  `;
  document.body.appendChild(notification);
});
