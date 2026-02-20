let apiKey = "";
const byId = (id) => document.getElementById(id);

const overviewState = {
  trendItems: [],
  keyItems: [],
  keyTrendItems: [],
};

function currentKeyFilter() {
  return String(byId("key-filter")?.value || "").trim();
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(headers, rows) {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const body = rows.map((r) => r.map(escapeCsvCell).join(",")).join("\n");
  return `${headerLine}\n${body}`;
}

function buildExportData() {
  const keyFilter = currentKeyFilter();
  const visibleOnly = Boolean(byId("export-visible-only")?.checked);
  const windowVal = byId("window")?.value || "24h";
  const bucketVal = byId("bucket")?.value || "hour";

  const trendRows = (overviewState.trendItems || []).map((i) => [
    fmtTime(i.timestamp),
    Number(i.total || 0),
    Number(i.success || 0),
    Number(i.error || 0),
    pct(i.success, i.total),
    Number(i.avg_duration_ms || 0).toFixed(2),
  ]);

  const keyItemsSource = (overviewState.keyItems || []);
  const keyFiltered = keyItemsSource.filter((i) => {
    if (!visibleOnly) return true;
    if (!keyFilter) return true;
    return String(i.key_name || "") === keyFilter;
  });
  const keyRows = keyFiltered.map((i) => [
    String(i.key_name || "anonymous"),
    Number(i.count || 0),
    Number(i.success || 0),
    Number(i.error || 0),
    pct(i.success, i.count),
    Number(i.avg_duration_ms || 0).toFixed(2),
  ]);

  const keyTrendItemsSource = (overviewState.keyTrendItems || []);
  const keyTrendFiltered = keyTrendItemsSource.filter((i) => {
    if (!visibleOnly) return true;
    if (!keyFilter) return true;
    return String(i.key_name || "") === keyFilter;
  });
  const keyTrendRows = keyTrendFiltered.map((i) => [
    fmtTime(i.timestamp),
    String(i.key_name || "anonymous"),
    Number(i.total || 0),
    Number(i.success || 0),
    Number(i.error || 0),
    pct(i.success, i.total),
    Number(i.avg_duration_ms || 0).toFixed(2),
  ]);

  return {
    meta: {
      window: windowVal,
      bucket: bucketVal,
      key_filter: keyFilter || "ALL",
      visible_only: visibleOnly,
      exported_at: new Date().toISOString(),
    },
    trendRows,
    keyRows,
    keyTrendRows,
    keyFiltered,
    keyTrendFiltered,
    trendItems: overviewState.trendItems || [],
  };
}

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
  overviewState.trendItems = items;
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
  overviewState.keyItems = items;
  rebuildKeyFilterOptions(items);
  const selectedKey = currentKeyFilter();
  const filteredItems = selectedKey
    ? items.filter((it) => String(it.key_name || "") === selectedKey)
    : items;
  if (!filteredItems.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = filteredItems.map(rowKey).join("");
}

function updateOverview() {
  const trend = Array.isArray(overviewState.trendItems) ? overviewState.trendItems : [];
  const total = trend.reduce((sum, i) => sum + Number(i.total || 0), 0);
  const success = trend.reduce((sum, i) => sum + Number(i.success || 0), 0);
  const errors = trend.reduce((sum, i) => sum + Number(i.error || 0), 0);
  const weightedDuration = trend.reduce(
    (sum, i) => sum + Number(i.avg_duration_ms || 0) * Number(i.total || 0),
    0,
  );
  const avgLatency = total > 0 ? (weightedDuration / total) : 0;

  if (byId("ov-total")) byId("ov-total").textContent = Number(total).toLocaleString();
  if (byId("ov-success-rate")) byId("ov-success-rate").textContent = pct(success, total);
  if (byId("ov-avg-latency")) byId("ov-avg-latency").textContent = Number(avgLatency).toFixed(2);
  if (byId("ov-errors")) byId("ov-errors").textContent = Number(errors).toLocaleString();
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
  overviewState.keyTrendItems = items;
  const selectedKey = currentKeyFilter();
  const filteredItems = selectedKey
    ? items.filter((it) => String(it.key_name || "") === selectedKey)
    : items;
  if (!filteredItems.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (body) body.innerHTML = filteredItems.map(rowKeyTrend).join("");
}

function rebuildKeyFilterOptions(items) {
  const select = byId("key-filter");
  if (!select) return;
  const prev = currentKeyFilter();
  const names = Array.from(
    new Set((Array.isArray(items) ? items : []).map((it) => String(it.key_name || "")).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部 Key";
  select.appendChild(all);
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (prev && names.includes(prev)) select.value = prev;
}

async function refreshAll() {
  try {
    await loadTrend();
    await loadModels();
    await loadKeys();
    await loadKeyTrend();
    updateOverview();
  } catch (e) {
    showToast(`加载失败: ${e.message || e}`, "error");
  }
}

function exportCsv() {
  const data = buildExportData();

  const parts = [
    "# 导出元信息",
    `window,${escapeCsvCell(data.meta.window)}`,
    `bucket,${escapeCsvCell(data.meta.bucket)}`,
    `key_filter,${escapeCsvCell(data.meta.key_filter)}`,
    `visible_only,${escapeCsvCell(data.meta.visible_only ? "true" : "false")}`,
    `exported_at,${escapeCsvCell(data.meta.exported_at)}`,
    "",
    "# 请求趋势",
    toCsv(["时间", "总请求", "成功", "失败", "成功率", "平均耗时(ms)"], data.trendRows),
    "",
    "# 按 Key 统计",
    toCsv(["Key", "请求数", "成功", "失败", "成功率", "平均耗时(ms)"], data.keyRows),
    "",
    "# 按 Key 24h 趋势",
    toCsv(["时间", "Key", "请求数", "成功", "失败", "成功率", "平均耗时(ms)"], data.keyTrendRows),
  ];

  const blob = new Blob([parts.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `stats-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const data = buildExportData();
  const payload = {
    meta: data.meta,
    trend: data.trendItems,
    keys: data.keyFiltered,
    key_trend_24h: data.keyTrendFiltered,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `stats-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyTable() {
  try {
    const data = buildExportData();
    const text = [
      "[请求趋势]",
      toCsv(["时间", "总请求", "成功", "失败", "成功率", "平均耗时(ms)"], data.trendRows),
      "",
      "[按 Key 统计]",
      toCsv(["Key", "请求数", "成功", "失败", "成功率", "平均耗时(ms)"], data.keyRows),
      "",
      "[按 Key 24h 趋势]",
      toCsv(["时间", "Key", "请求数", "成功", "失败", "成功率", "平均耗时(ms)"], data.keyTrendRows),
    ].join("\n");
    await navigator.clipboard.writeText(text);
    showToast("已复制当前统计表格", "success");
  } catch (e) {
    showToast(`复制失败: ${e.message || e}`, "error");
  }
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) return;
  byId("btn-refresh")?.addEventListener("click", refreshAll);
  byId("btn-export-csv")?.addEventListener("click", exportCsv);
  byId("btn-export-json")?.addEventListener("click", exportJson);
  byId("btn-copy-table")?.addEventListener("click", copyTable);
  byId("window")?.addEventListener("change", refreshAll);
  byId("bucket")?.addEventListener("change", refreshAll);
  byId("key-filter")?.addEventListener("change", async () => {
    try {
      await loadKeys();
      await loadKeyTrend();
    } catch (e) {
      showToast(`加载失败: ${e.message || e}`, "error");
    }
  });
  await refreshAll();
}

document.addEventListener("DOMContentLoaded", init);
