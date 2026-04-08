# miYoViajo — Progressive Web App

App para registrar horarios reales de buses en Costa Rica.

## ✅ Características PWA habilitadas

- **Instalable** — Agrega a pantalla de inicio (Android + iOS)
- **Offline** — Funciona sin conexión con datos cacheados
- **Background GPS** — Continúa detectando paradas en background
- **Sincronización** — Guarda datos automáticamente
- **Standalone** — Se ejecuta como app nativa

## 📱 Cómo instalar

### Android (Chrome)
1. Abre https://miyoviajo.netlify.app
2. Toca ⊕ (arriba derecha) → "Instalar app"

### iOS (Safari)
1. Abre en Safari
2. Toca ↗ (Compartir)
3. "Agregar a pantalla de inicio"

## 🚌 Cómo registrar viaje

1. **Áborda** → Selecciona hora de salida
2. **Graba** → Toca ⏺️ rojo
3. **Muévete** → App detecta paradas automáticamente
4. **Finaliza** → Toca ⏺️ de nuevo

### Lo que ves mientras grabas:
- 🟠 Ruta en **naranja** (no en color original)
- 🟢 **Línea verde** que sigue el bus

## 🔄 Persistencia

- Datos guardados en **localStorage**
- Si recarga → **continúa donde dejó**
- Se sincroniza cada parada detectada
- Al terminar → resumen con Discord

## 🛠️ Service Worker

**`public/service-worker.js`** hace:
- ✅ Cachea archivos estáticos
- ✅ Network-first (intenta red, fallback caché)
- ✅ Detecta paradas en background
- ✅ Notifica actualizaciones disponibles

## 🌐 URLs

- Web: https://miyoviajo.netlify.app
- Cloudflare: https://miyoviajo.antony-08.workers.dev
- GitHub: https://github.com/anthonyOviedo/miYoViajo

## 📦 Build

```bash
npm run dev              # Local dev
npm run build:public    # Build público
npm run build:admin     # Build con editor
./build.sh              # Ambos
```

---
**Last**: 2026-04-08
