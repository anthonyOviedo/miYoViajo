import L from 'leaflet';
import { STOPS, ROUTE } from './stops.js';

// ── Leaflet default icon fix for Vite ──
import markerIconUrl from 'leaflet/dist/images/marker-icon.png?url';
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png?url';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
});

// ── State ──
let userLatLng = null;
let userMarker = null;
let map = null;

// ── Map init ──
function initMap() {
  const center = [9.938381, -84.0864747]; // Terminal San José
  map = L.map('map', {
    center,
    zoom: 12,
    zoomControl: false,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Zoom control top-right, away from topbar
  L.control.zoom({ position: 'topright' }).addTo(map);

  addStopMarkers();
}

// ── Stop markers ──
function addStopMarkers() {
  STOPS.forEach((stop) => {
    const isTerminal = stop.starts || stop.ends;

    const icon = L.divIcon({
      className: 'bus-marker',
      html: `<div class="stop-marker-dot ${isTerminal ? 'terminal-dot' : ''}"></div>`,
      iconSize: isTerminal ? [14, 14] : [10, 10],
      iconAnchor: isTerminal ? [7, 7] : [5, 5],
    });

    const marker = L.marker([stop.lat, stop.lng], { icon })
      .addTo(map)
      .bindPopup(`
        <div class="popup-title">${stop.title}</div>
        <div class="popup-sub">${stop.address}</div>
        <div class="popup-time">+${stop.time} desde San José</div>
      `, { maxWidth: 220 });

    marker.on('click', () => {
      highlightStop(stop.id);
    });
  });
}

// ── User location ──
function createUserMarker(latlng) {
  const icon = L.divIcon({
    className: 'bus-marker',
    html: `<div class="user-marker-inner"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  return L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
}

function updateLocation(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  userLatLng = L.latLng(lat, lng);

  if (!userMarker) {
    userMarker = createUserMarker(userLatLng);
  } else {
    userMarker.setLatLng(userLatLng);
  }

  // Update UI
  document.getElementById('location-dot').classList.add('active');
  document.getElementById('location-text').textContent = `Precisión ±${Math.round(accuracy)}m`;

  updateNearestStop();
}

function locationError(err) {
  document.getElementById('location-text').textContent = 'No se pudo obtener ubicación';
  console.warn('Geolocation error:', err.message);
}

function startGeolocation() {
  if (!navigator.geolocation) {
    document.getElementById('location-text').textContent = 'GPS no disponible';
    return;
  }
  navigator.geolocation.watchPosition(updateLocation, locationError, {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 5000,
  });
}

// ── Nearest stop ──
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateNearestStop() {
  if (!userLatLng) return;

  let nearest = null;
  let minDist = Infinity;

  STOPS.forEach((stop) => {
    const d = haversine(userLatLng.lat, userLatLng.lng, stop.lat, stop.lng);
    if (d < minDist) {
      minDist = d;
      nearest = stop;
    }
  });

  if (!nearest) return;

  const distText = minDist < 1000
    ? `${Math.round(minDist)} m de distancia`
    : `${(minDist / 1000).toFixed(1)} km de distancia`;

  document.getElementById('next-stop-name').textContent = nearest.title;
  document.getElementById('next-stop-dist').textContent = distText;

  // Highlight in list
  highlightStop(nearest.id);
}

// ── Stops list ──
function renderStopsList() {
  const container = document.getElementById('stops-items');
  const sorted = [...STOPS].sort((a, b) => a.time.localeCompare(b.time));

  sorted.forEach((stop, idx) => {
    const isLast = idx === sorted.length - 1;
    const isTerminal = stop.starts || stop.ends;

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
    });

    container.appendChild(item);
  });
}

function highlightStop(id) {
  document.querySelectorAll('.stop-item').forEach((el) => {
    el.style.background = '';
  });
  document.querySelectorAll('.stop-dot').forEach((el) => {
    el.classList.remove('nearest');
  });

  const item = document.querySelector(`.stop-item[data-id="${id}"]`);
  if (item) {
    item.style.background = 'rgba(255,214,0,0.08)';
    item.querySelector('.stop-dot')?.classList.add('nearest');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Center button ──
function setupCenterButton() {
  document.getElementById('center-btn').addEventListener('click', () => {
    if (userLatLng) {
      map.setView(userLatLng, 15, { animate: true });
    } else {
      // Center on route
      map.setView([9.938381, -84.0864747], 12, { animate: true });
    }
  });
}

// ── Boot ──
initMap();
renderStopsList();
startGeolocation();
setupCenterButton();
