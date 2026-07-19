// app.js — ab/src/main/m5(訪問地図)のロジックをaa向けに移植したもの。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する。GETもcredentialヘッダで認証する(ba-16)。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
const API_BASE = window.AA_API_BASE; // common/config.js から(ba-9)
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
  // 通常ピンを先に描画し、最後の訪問地(赤)は最後に描画して常に最前面に出す
  // (同じ場所への複数訪問がある場合、後から描画されるピンに埋もれるのを防ぐ)
  visits.forEach((v, i) => {
    const [x, y] = proj(v.lng, v.lat);
    points.push({ x, y, v, isLatest: i === 0 });
  });

  points.filter(p => !p.isLatest).forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#b5651d";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
  points.filter(p => p.isLatest).forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#e63946";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });

  return points;
}

function todayStr() {
  return new Date().toLocaleDateString("sv-SE");
}

function withCredential(body = {}) {
  return { ...body, credential: window.__credential };
}

// 訪問記録の入力(ab/src/main/n1の訪問記録機能を移植、メモ欄は対象外)
function initVisitInput() {
  const elPlaceInput = document.getElementById("placeInput");
  const elDateInput = document.getElementById("dateInput");
  const elTimeInput = document.getElementById("timeInput");
  const elBtnGps = document.getElementById("btnGps");
  const elBtnAddVisit = document.getElementById("btnAddVisit");
  const elStatus = document.getElementById("visitInputStatus");

  const today = todayStr();
  elDateInput.value = today;
  const now = new Date();
  elTimeInput.value = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  let _lat = null, _lng = null;

  elBtnGps.addEventListener("click", () => {
    if (!navigator.geolocation) { alert("位置情報非対応"); return; }
    elBtnGps.textContent = "取得中...";
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      _lat = lat; _lng = lng;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`
        );
        const data = await res.json();
        const addr = data.address;
        const place = [addr.city || addr.town || addr.village, addr.suburb || addr.neighbourhood || addr.quarter]
          .filter(Boolean).join(" ");
        elPlaceInput.value = place || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      } catch {
        elPlaceInput.value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
      elBtnGps.textContent = "📍 現在地";
    }, () => {
      alert("位置情報を取得できませんでした");
      elBtnGps.textContent = "📍 現在地";
    });
  });

  elBtnAddVisit.addEventListener("click", async () => {
    // ba-35残課題(2): 公開閲覧モードでは未ログインでも閲覧できるため、書き込み時に
    // credentialの有無を確認し、無ければ通信(401)ではなくログインへ誘導する。
    if (!window.__credential) {
      elStatus.textContent = "追加にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const place = elPlaceInput.value.trim();
    const date = elDateInput.value;
    const time = elTimeInput.value;
    if (!place) { elPlaceInput.focus(); return; }
    try {
      const res = await fetch(VISITS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({ place, date, time, lat: _lat, lng: _lng })),
      });
      if (!res.ok) { elStatus.textContent = "エラー: 追加に失敗しました"; return; }
      elPlaceInput.value = "";
      _lat = null; _lng = null;
      elStatus.textContent = "✓ 追加しました";
      setTimeout(() => elStatus.textContent = "", 2000);
      load();
    } catch (e) {
      elStatus.textContent = "エラー: " + e.message;
    }
  });
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

let _points = [];
let _W = 0;

canvas.addEventListener("click", e => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (_W / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  let hit = null;
  for (const pt of _points) {
    if (Math.hypot(mx - pt.x, my - pt.y) < 12) { hit = pt; break; }
  }
  if (hit) {
    const v = hit.v;
    document.getElementById("popupPlace").textContent = v.place || "—";
    document.getElementById("popupMeta").textContent = `${v.date || ""} ${v.time || ""}${v.memo ? "\n" + v.memo : ""}`;
    const px = Math.min(hit.x + 10, _W - 200);
    const py = Math.max(hit.y - 60, 10);
    popup.style.left = px + "px";
    popup.style.top = py + "px";
    popup.classList.add("show");
  } else {
    popup.classList.remove("show");
  }
});

async function load() {
  const listEl = document.getElementById("visitList");
  const emptyMsg = document.getElementById("emptyMsg");
  listEl.innerHTML = "";
  emptyMsg.style.display = "none";

  const [higashiGeo, osakaCityGeo, visitRes] = await Promise.all([
    fetchGeo("higashiosaka.geojson"),
    fetchGeo("osaka_city.geojson"),
    fetch(VISITS_API, { cache: "no-store", headers: { "X-Visits-Credential": window.__credential || "" } })
  ]);

  const allVisits = visitRes.ok ? await visitRes.json() : [];
  // 訪問記録を日付→時刻の降順(新しい順)に並べ替える
  allVisits.sort((a, b) => {
    const da = a.date || "", db = b.date || "";
    if (da !== db) return db.localeCompare(da);
    const ta = a.time || "", tb = b.time || "";
    return tb.localeCompare(ta);
  });
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
  _W = W;
  _points = withLatLng.length > 0 ? drawPoints(withLatLng, proj) : [];

  if (allVisits.length === 0) {
    emptyMsg.style.display = "block";
    return;
  }

  allVisits.forEach(v => {
    const hasPin = !!(v.lat && v.lng);
    let ptIdx = -1;
    if (hasPin) ptIdx = withLatLng.findIndex(w => w.id === v.id);

    addVisitRow(listEl, v, hasPin, hasPin ? () => {
      document.querySelectorAll(".visit-row").forEach(r => r.classList.remove("active"));
      const pt = _points[ptIdx];
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

// issue #8対応(案B): auth.jsの実行順は変えず、起動時にwindow.__loginStateを直接チェックする。
// auth.js(通常script)はHTML解析中に同期実行されるため、このモジュール(type="module"でdefer)が
// 動く時点では既にwindow.__loginStateがセット済みの可能性がある。その場合はイベントを待たずに即実行し、
// まだ未ログインならこれまで通りn2-login-successイベントを待つ(通常のログインボタン操作に対応)。
function onLoginSuccess() {
  initVisitInput();
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("n2-login-success", onLoginSuccess, { once: true });
}
