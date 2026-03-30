#!/usr/bin/env node
/**
 * Generates route geometries using Valhalla (OpenStreetMap.de) and caches them
 * as a static JSON file so the app never depends on external routing at runtime.
 *
 * Usage: node scripts/generate-geometries.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stopsPath = resolve(__dirname, '../src/stops.js');
const outPath = resolve(__dirname, '../src/route-geometries.json');

// Parse ROUTES from stops.js (it's an ES module export, so we extract with regex)
const stopsSource = readFileSync(stopsPath, 'utf-8');
const routesMatch = stopsSource.match(/export\s+const\s+ROUTES\s*=\s*(\[[\s\S]*\]);?\s*$/);
if (!routesMatch) { console.error('Could not parse ROUTES from stops.js'); process.exit(1); }
const ROUTES = eval(routesMatch[1]);

// Decode Valhalla's encoded polyline (precision 6)
function decodePolyline(encoded, precision = 6) {
  const factor = Math.pow(10, precision);
  const points = [];
  let lat = 0, lng = 0, index = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / factor, lng / factor]);
  }
  return points;
}

async function fetchValhallaRoute(stops) {
  // Use sorted stops as waypoints — limit to ~20 for long routes
  const sorted = [...stops].sort((a, b) => a.time.localeCompare(b.time));
  let selected = sorted;
  if (sorted.length > 20) {
    // Keep first, last, and evenly spaced intermediate stops
    const step = (sorted.length - 1) / 19;
    selected = [];
    for (let i = 0; i < 20; i++) {
      selected.push(sorted[Math.round(i * step)]);
    }
  }
  const locations = selected.map(s => ({ lat: s.lat, lon: s.lng, type: 'through' }));
  // First and last must be "break"
  locations[0].type = 'break';
  locations[locations.length - 1].type = 'break';

  const body = JSON.stringify({ locations, costing: 'auto', directions_options: { units: 'km' } });
  const url = `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(body)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Valhalla error: ${resp.status}`);
  const data = await resp.json();

  if (data.trip?.legs) {
    // Concatenate all leg shapes
    let allPoints = [];
    for (const leg of data.trip.legs) {
      const pts = decodePolyline(leg.shape);
      if (allPoints.length > 0) pts.shift(); // avoid duplicate junction point
      allPoints = allPoints.concat(pts);
    }
    return allPoints;
  }
  throw new Error('No route found');
}

async function main() {
  const geometries = {};

  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i];
    process.stdout.write(`[${i + 1}/${ROUTES.length}] ${route.name}... `);
    try {
      const coords = await fetchValhallaRoute(route.stops);
      geometries[route.slug] = coords;
      console.log(`${coords.length} points`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      // Fallback: sorted stop coords
      const sorted = [...route.stops].sort((a, b) => a.time.localeCompare(b.time));
      geometries[route.slug] = sorted.map(s => [s.lat, s.lng]);
    }
    // Small delay to be polite to the server
    await new Promise(r => setTimeout(r, 500));
  }

  writeFileSync(outPath, JSON.stringify(geometries));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
