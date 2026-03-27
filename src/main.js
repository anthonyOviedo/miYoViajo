import L from 'leaflet';
import { STOPS } from './stops.js';

// ── Leaflet icon fix for Vite ──
import markerIconUrl from 'leaflet/dist/images/marker-icon.png?url';
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png?url';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIconUrl, iconRetinaUrl: markerIcon2xUrl, shadowUrl: markerShadowUrl });

// ── State ──
let userLatLng = null;
let userMarker = null;
let map = null;

// ── Map ──
function initMap() {
  const topbarH = document.getElementById('topbar').offsetHeight;

  map = L.map('map', {
    center: [9.938381, -84.0864747],
    zoom: 12,
    zoomControl: false,
    attributionControl: true,
    paddingTopLeft: [0, topbarH],
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  addStopMarkers();
}

function addStopMarkers() {
  STOPS.forEach((stop) => {
    const isTerminal = stop.starts || stop.ends;
    const icon = L.divIcon({
      className: 'bus-marker',
      html: `<div class="stop-marker-dot ${isTerminal ? 'terminal-dot' : ''}"></div>`,
      iconSize: isTerminal ? [14, 14] : [10, 10],
      iconAnchor: isTerminal ? [7, 7] : [5, 5],
    });

    L.marker([stop.lat, stop.lng], { icon })
      .addTo(map)
      .bindPopup(`
        <div class="popup-title">${stop.title}</div>
        <div class="popup-sub">${stop.address}</div>
        <div class="popup-time">+${stop.time} desde San José</div>
      `, { maxWidth: 220 })
      .on('click', () => highlightStop(stop.id));
  });
}

// ── Geolocation ──
function createUserMarker(latlng) {
  const icon = L.divIcon({
    className: 'bus-marker',
    html: `<div class="user-marker-inner"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
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
  if (!navigator.geolocation) {
    document.getElementById('location-text').textContent = 'GPS no disponible';
    return;
  }
  navigator.geolocation.watchPosition(updateLocation, () => {
    document.getElementById('location-text').textContent = 'No se pudo obtener ubicación';
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
}

// ── Nearest stop ──
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
  STOPS.forEach((s) => {
    const d = haversine(userLatLng.lat, userLatLng.lng, s.lat, s.lng);
    if (d < minDist) { minDist = d; nearest = s; }
  });
  if (!nearest) return;
  const distText = minDist < 1000 ? `${Math.round(minDist)} m` : `${(minDist / 1000).toFixed(1)} km`;
  document.getElementById('next-stop-name').textContent = nearest.title;
  document.getElementById('next-stop-dist').textContent = distText + ' de distancia';
  highlightStop(nearest.id);
}

// ── Stops list ──
function renderStopsList() {
  const container = document.getElementById('stops-items');
  const sorted = [...STOPS].sort((a, b) => a.time.localeCompare(b.time));
  sorted.forEach((stop, idx) => {
    const isTerminal = stop.starts || stop.ends;
    const isLast = idx === sorted.length - 1;
    const item = document.createElement('div');
    item.className = 'stop-item';
    item.dataset.id = stop.id;
    item.innerHTML = `
      <div class="stop-timeline">
        <div class="stop-dot ${isTerminal ? 'terminal' : ''}"></div>
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
  document.querySelectorAll('.stop-item').forEach((el) => el.classList.remove('highlighted'));
  document.querySelectorAll('.stop-dot').forEach((el) => el.classList.remove('nearest'));
  const item = document.querySelector(`.stop-item[data-id="${id}"]`);
  if (item) {
    item.classList.add('highlighted');
    item.querySelector('.stop-dot')?.classList.add('nearest');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Center button ──
function setupCenterButton() {
  document.getElementById('center-btn').addEventListener('click', () => {
    if (userLatLng) map.setView(userLatLng, 15, { animate: true });
    else map.setView([9.938381, -84.0864747], 12, { animate: true });
  });
}

// ── Draggable panel ──
const STATES = { collapsed: 80, half: null, expanded: null };

function getPanelStates() {
  const vh = window.innerHeight;
  return {
    collapsed: 80,
    half: Math.round(vh * 0.45),
    expanded: Math.round(vh * 0.88),
  };
}

function expandPanel(state) {
  const panel = document.getElementById('bottom-panel');
  const states = getPanelStates();
  panel.classList.remove('collapsed', 'expanded');
  if (state === 'collapsed') panel.classList.add('collapsed');
  else if (state === 'expanded') panel.classList.add('expanded');
  panel.style.height = states[state] + 'px';
  updateMapPadding(states[state]);
}

function updateMapPadding(panelH) {
  if (map) map.invalidateSize();
}

function setupDraggablePanel() {
  const panel = document.getElementById('bottom-panel');
  const handle = document.getElementById('panel-handle-area');
  let startY = 0, startH = 0, dragging = false;

  function onStart(y) {
    startY = y;
    startH = panel.offsetHeight;
    dragging = true;
    panel.style.transition = 'none';
  }

  function onMove(y) {
    if (!dragging) return;
    const delta = startY - y;
    const states = getPanelStates();
    const newH = Math.min(states.expanded, Math.max(states.collapsed, startH + delta));
    panel.style.height = newH + 'px';
  }

  function onEnd(y) {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const states = getPanelStates();
    const currentH = panel.offsetHeight;
    const delta = startY - y;

    let target;
    if (currentH < (states.collapsed + states.half) / 2) target = 'collapsed';
    else if (currentH > (states.half + states.expanded) / 2) target = 'expanded';
    else target = 'half';

    // also snap by velocity
    if (Math.abs(delta) > 60) {
      if (delta > 0) {
        target = currentH > states.half ? 'expanded' : 'half';
      } else {
        target = currentH < states.half ? 'collapsed' : 'half';
      }
    }

    expandPanel(target);
  }

  // Touch
  handle.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove',  (e) => onMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener('touchend',   (e) => onEnd(e.changedTouches[0].clientY));

  // Mouse (desktop)
  handle.addEventListener('mousedown', (e) => { onStart(e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => onMove(e.clientY));
  window.addEventListener('mouseup',   (e) => onEnd(e.clientY));

  // Tap handle to toggle
  handle.addEventListener('click', () => {
    const states = getPanelStates();
    const currentH = panel.offsetHeight;
    if (currentH <= states.collapsed + 10) expandPanel('half');
    else if (currentH >= states.expanded - 10) expandPanel('half');
    else if (currentH < states.half) expandPanel('half');
    else expandPanel('collapsed');
  });

  // Set initial height
  expandPanel('half');
}

// ── Boot ──
initMap();
renderStopsList();
startGeolocation();
setupCenterButton();
setupDraggablePanel();
