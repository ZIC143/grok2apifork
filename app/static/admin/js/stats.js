let apiKey = "";
const byId = (id) => document.getElementById(id);

function fmtTime(tsMs) {
  const n = Number(tsMs || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
}

function pct(success, total) {
  const t = Number(total || 0);
  if (t <= 0) return "0.00%";
  return `${((Number(success || 0) * 100) / t).toFixed(2)}%`;
}

function rowTrend(item) {
  return `
    <tr>
      <td class="mono">${fmtTime(item.timestamp)}</td>
      <td class="num">${Number(item.total || 0).toLocaleString()}</td>
      <td class="num">${Number(item.success || 0).toLocaleString()}</td>
      <td class="num">${Number(item.error || 0).toLocaleString()}</td>
      <td class="num">${pct(item.success, item.total)}</td>
      <td class="num">${Number(item.avg_duration_ms || 0).toFixed(2)}</td>
    </tr>`;
}

function rowModel(item) {
  return `
    <tr>
      <td class="mono">${String(item.model || "unknown")}</td>
      <td class="num">${Number(item.count || 0).toLocaleString()}</td>
      <td class="num">${Number(item.success || 0).toLocaleString()}</td>
      <td class="num">${Number(item.error || 0).toLocaleString()}</td>
      <td class="num">${pct(item.success, item.count)}</td>
      <td class="num">${Number(item.avg_duration_ms || 0).toFixed(2)}</td>
    </tr>`;
}

function rowKey(item) {
  return `
    <tr>
      <td class="mono">${String(item.key_name || "anonymous")}</td>
      <td class="num">${Number(item.count || 0).toLocaleString()}</td>
      <td class="num">${Number(item.success || 0).toLocaleString()}</td>
      <td class="num">${Number(item.error || 0).toLocaleString()}</td>
      <td class="num">${pct(item.success, item.count)}</td>
      <td class="num">${Number(item.avg_duration_ms || 0).toFixed(2)}</td>
    </tr>`;
}

function rowKeyTrend(item) {
  return `
    <tr>
      <td class="mono">${fmtTime(item.timestamp)}</td>
      <td class="mono">${String(item.key_name || "anonymous")}</td>
      <td class="num">${Number(item.total || 0).toLocaleString()}</td>
      <td class="num">${Number(item.success || 0).toLocaleString()}</td>
      <td class="num">${Number(item.error || 0).toLocaleString()}</td>
      <td class="num">${pct(item.success, item.total)}</td>
      <td class="num">${Number(item.avg_duration_ms || 0).toFixed(2)}</td>
    </tr>`;
}

async function loadTrend() {
  const windowVal = byId("window")?.value || "24h";
  const bucketVal = byId("bucket")?.value || "hour";
  const body = byId("trend-body");
  const empty = byId("trend-empty");
  if (body) body.innerHTML = "";
  if (empty) empty.classList.add("hidden");

  const res = await fetch(`/v1/admin/stats/trend?window=${encodeURIComponent(windowVal)}&bucket=${encodeURIComponent(bucketVal)}`, {
    headers: buildAuthHeaders(apiKey),
  });
  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = items.map(rowTrend).join("");
}

async function loadModels() {
  const windowVal = byId("window")?.value || "24h";
  const body = byId("models-body");
  const empty = byId("models-empty");
  if (body) body.innerHTML = "";
  if (empty) empty.classList.add("hidden");

  const res = await fetch(`/v1/admin/stats/models?window=${encodeURIComponent(windowVal)}`, {
    headers: buildAuthHeaders(apiKey),
  });
  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = items.map(rowModel).join("");
}

async function loadKeys() {
  const windowVal = byId("window")?.value || "24h";
  const body = byId("keys-body");
  const empty = byId("keys-empty");
  if (body) body.innerHTML = "";
  if (empty) empty.classList.add("hidden");

  const res = await fetch(`/v1/admin/stats/keys?window=${encodeURIComponent(windowVal)}`, {
    headers: buildAuthHeaders(apiKey),
  });
  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = items.map(rowKey).join("");
}

async function loadKeyTrend() {
  const body = byId("keys-trend-body");
  const empty = byId("keys-trend-empty");
  if (body) body.innerHTML = "";
  if (empty) empty.classList.add("hidden");

  const res = await fetch(`/v1/admin/stats/keys/trend`, {
    headers: buildAuthHeaders(apiKey),
  });
  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = items.map(rowKeyTrend).join("");
}

async function refreshAll() {
  try {
    await loadTrend();
    await loadModels();
    await loadKeys();
    await loadKeyTrend();
  } catch (e) {
    showToast(`加载失败: ${e.message || e}`, "error");
  }
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) return;
  byId("btn-refresh")?.addEventListener("click", refreshAll);
  byId("window")?.addEventListener("change", refreshAll);
  byId("bucket")?.addEventListener("change", refreshAll);
  await refreshAll();
}

document.addEventListener("DOMContentLoaded", init);
