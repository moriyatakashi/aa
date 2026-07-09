// app.js — ab/src/main/m5(訪問地図)のロジックをaa向けに移植したもの。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する(APIは無認証のまま)。
const API_BASE = "https://ab-board-api.azurewebsites.net/api";
const VISITS_API = `${API_BASE}/visits`;

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const popup = document.getElementById("popup");

async function fetchGeo(path) {
  const r = await fetch(path);
  return r.json();
}

function makeProjector(features, W, H, padding = 20) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  features.forEach(f => {
    const geom = f.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    polys.forEach(poly => poly.forEach(ring => ring.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    })));
  });
  const scaleX = (W - padding * 2) / (maxLng - minLng);
  const scaleY = (H - padding * 2) / (maxLat - minLat);
  const scale = Math.min(scaleX, scaleY);
  const offX = padding + (W - padding * 2 - (maxLng - minLng) * scale) / 2;
  const offY = padding + (H - padding * 2 - (maxLat - minLat) * scale) / 2;
  return (lng, lat) => [
    offX + (lng - minLng) * scale,
    H - offY - (lat - minLat) * scale
  ];
}

function drawFeatures(features, proj, fillColor, strokeColor) {
  features.forEach(f => {
    const geom = f.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    polys.forEach(poly => {
      ctx.beginPath();
      poly.forEach(ring => {
        ring.forEach(([lng, lat], i) => {
          const [x, y] = proj(lng, lat);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath();
      });
      ctx.fillStyle = fillColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    });
  });
}

function drawPoints(visits, proj) {
  const points = [];
  visits.forEach(v => {
    const [x, y] = proj(v.lng, v.lat);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#b5651d";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    points.push({ x, y, v });
  });
  return points;
}

function addVisitRow(listEl, v, hasPin, onClick) {
  const row = document.createElement("div");
  row.className = "visit-row";

  const placeEl = document.createElement("div");
  placeEl.className = "visit-row-place";
  placeEl.textContent = v.place || "—";
  row.appendChild(placeEl);

  const metaEl = document.createElement("div");
  metaEl.className = "visit-row-meta";
  metaEl.textContent = `${v.date || ""} ${v.time || ""}${hasPin ? "" : " (地図なし)"}`;
  row.appendChild(metaEl);

  if (onClick) row.addEventListener("click", onClick);
  listEl.appendChild(row);
  return row;
}

async function load() {
  const [higashiGeo, osakaCityGeo, visitRes] = await Promise.all([
    fetchGeo("higashiosaka.geojson"),
    fetchGeo("osaka_city.geojson"),
    fetch(VISITS_API, { cache: "no-store" })
  ]);

  const allVisits = visitRes.ok ? await visitRes.json() : [];
  const withLatLng = allVisits.filter(v => v.lat && v.lng);

  document.getElementById("statTotal").textContent = allVisits.length;
  document.getElementById("statPlaces").textContent = new Set(allVisits.map(v => v.place).filter(Boolean)).size;
  document.getElementById("statDays").textContent = new Set(allVisits.map(v => v.date).filter(Boolean)).size;

  const W = canvas.offsetWidth;
  const H = 360;
  canvas.width = W;
  canvas.height = H;

  const allFeatures = [...higashiGeo.features, ...osakaCityGeo.features];
  const proj = makeProjector(allFeatures, W, H);

  ctx.clearRect(0, 0, W, H);
  drawFeatures(osakaCityGeo.features, proj, "#e8f0e0", "#a8c890");
  drawFeatures(higashiGeo.features, proj, "#dce8f5", "#aac4e0");
  const points = withLatLng.length > 0 ? drawPoints(withLatLng, proj) : [];

  canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    let hit = null;
    for (const pt of points) {
      if (Math.hypot(mx - pt.x, my - pt.y) < 12) { hit = pt; break; }
    }
    if (hit) {
      const v = hit.v;
      document.getElementById("popupPlace").textContent = v.place || "—";
      document.getElementById("popupMeta").textContent = `${v.date || ""} ${v.time || ""}${v.memo ? "\n" + v.memo : ""}`;
      const px = Math.min(hit.x + 10, W - 200);
      const py = Math.max(hit.y - 60, 10);
      popup.style.left = px + "px";
      popup.style.top = py + "px";
      popup.classList.add("show");
    } else {
      popup.classList.remove("show");
    }
  });

  const listEl = document.getElementById("visitList");
  if (allVisits.length === 0) {
    document.getElementById("emptyMsg").style.display = "block";
    return;
  }

  allVisits.forEach(v => {
    const hasPin = !!(v.lat && v.lng);
    let ptIdx = -1;
    if (hasPin) ptIdx = withLatLng.findIndex(w => w.id === v.id);

    addVisitRow(listEl, v, hasPin, hasPin ? () => {
      document.querySelectorAll(".visit-row").forEach(r => r.classList.remove("active"));
      const pt = points[ptIdx];
      if (pt) {
        document.getElementById("popupPlace").textContent = v.place || "—";
        document.getElementById("popupMeta").textContent = `${v.date || ""} ${v.time || ""}`;
        popup.style.left = Math.min(pt.x + 10, W - 200) + "px";
        popup.style.top = Math.max(pt.y - 60, 10) + "px";
        popup.classList.add("show");
      }
    } : null);
  });
}

window.addEventListener("n2-login-success", load, { once: true });
