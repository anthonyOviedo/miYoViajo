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

// ── State ──
let map = null;
let offlineLayer = null;
let saveTilesControl = null;
let userLatLng = null;
let userMarker = null;
let activeRouteIdx = 0;
let stopMarkers = [];      // { marker, routeIdx }
let routePolylines = [];  // { casing, line }

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

  L.control.zoom({ position: 'topright' }).addTo(map);

  setupOfflineControl();
  drawRoutePolylines();
  addAllStopMarkers();
  fitRoute(activeRouteIdx);
}

// ── Route polylines (Waze style: shadow + casing + line) ──
function drawRoutePolylines() {
  ROUTES.forEach((route, routeIdx) => {
    const sorted = [...route.stops].sort((a, b) => a.time.localeCompare(b.time));
    const coords = sorted.map(s => [s.lat, s.lng]);

    const shadow = L.polyline(coords, {
      pane: 'routeShadow',
      color: 'rgba(0,0,0,0.18)', weight: 14,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    const casing = L.polyline(coords, {
      pane: 'routeCasing',
      color: '#fff', weight: 9, opacity: 1,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    const line = L.polyline(coords, {
      pane: 'routeLine',
      color: route.color, weight: 5, opacity: 1,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    routePolylines.push({ shadow, casing, line, routeIdx });
  });
  updatePolylinesVisibility();
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
  const size = isTerminal ? 11 : 5;
  const bg   = isTerminal ? color : '#fff';
  const bw   = isTerminal ? 2.5 : 1.5;
  const bc   = isTerminal ? '#fff' : color;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${bg};border:${bw}px solid ${bc};
      box-shadow:0 1px 3px rgba(0,0,0,0.22);
      pointer-events:none;
    "></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function addAllStopMarkers() {
  ROUTES.forEach((route, routeIdx) => {
    route.stops.forEach((stop) => {
      const isTerminal = stop.starts || stop.ends;
      const icon = makeStopIcon(route.color, isTerminal);
      const marker = L.marker([stop.lat, stop.lng], { icon, pane: 'stopDots' })
        .addTo(map)
        .bindPopup(`
          <div class="popup-route" style="background:${route.color}20;border-left:3px solid ${route.color};padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:0.72rem;font-weight:600;color:${route.color}">${route.short}</div>
          <div class="popup-title">${stop.title}</div>
          <div class="popup-sub">${stop.address}</div>
          <div class="popup-time">+${stop.time} desde ${stop.starts ? 'inicio' : route.stops.find(s => s.starts)?.title || 'inicio'}</div>
        `, { maxWidth: 230 })
        .on('click', () => {
          setActiveRoute(routeIdx);
          highlightStop(stop.id);
        });

      stopMarkers.push({ marker, routeIdx, stop });
    });
  });

  updateMarkersVisibility();
}

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
  const route = ROUTES[routeIdx];
  const bounds = L.latLngBounds(route.stops.map(s => [s.lat, s.lng]));
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
  const sorted = [...route.stops].sort((a, b) => a.time.localeCompare(b.time));

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
  const route = ROUTES[activeRouteIdx];
  let nearest = null, minDist = Infinity;
  route.stops.forEach((s) => {
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

// ── Boot ──
initMap();
renderRouteDropdown();
renderStopsList();
renderScheduleChips();
startGeolocation();
setupCenterButton();
setupDraggablePanel();
setupDownloadButton();
