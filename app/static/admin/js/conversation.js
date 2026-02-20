let apiKey = "";
let page = 1;
let pageSize = 50;
let total = 0;
let filterToken = "";

const byId = (id) => document.getElementById(id);

function toEpochSec(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function fmtTs(sec) {
  const n = toEpochSec(sec);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
}

function maskToken(t) {
  const s = String(t || "");
  if (!s) return "-";
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-8)}`;
}

function showLoading(loading) {
  const el = byId("loading");
  if (!el) return;
  el.style.display = loading ? "block" : "none";
}

function updatePageInfo(count) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const info = byId("page-info");
  if (info) info.textContent = `第 ${page} / ${totalPages} 页 · 共 ${total} 条`;
  const summary = byId("summary");
  if (summary) summary.textContent = `当前页 ${count} 条，共 ${total} 条`;
  const prev = byId("btn-prev");
  const next = byId("btn-next");
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

function syncQueryParams() {
  try {
    const url = new URL(window.location.href);
    if (filterToken) url.searchParams.set("token", filterToken);
    else url.searchParams.delete("token");
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  } catch {
    // ignore
  }
}

function bootstrapFromQuery() {
  try {
    const url = new URL(window.location.href);
    const token = String(url.searchParams.get("token") || "").trim();
    const p = Number(url.searchParams.get("page") || 1);
    const ps = Number(url.searchParams.get("page_size") || 50);
    filterToken = token;
    page = Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
    pageSize = Number.isFinite(ps) && ps > 0 ? Math.min(200, Math.max(20, Math.floor(ps))) : 50;

    const input = byId("filter-token");
    if (input) input.value = filterToken;
    const sizeSel = byId("page-size");
    if (sizeSel) sizeSel.value = String(pageSize);
  } catch {
    // ignore
  }
}

async function loadConversations() {
  showLoading(true);
  const tbody = byId("table-body");
  const empty = byId("empty");
  if (tbody) tbody.innerHTML = "";
  if (empty) empty.classList.add("hidden");

  try {
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    if (filterToken) params.set("token", filterToken);

    const res = await fetch(`/v1/admin/conversations?${params.toString()}`, {
      headers: buildAuthHeaders(apiKey),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    total = Number(data.total || 0);

    if (!items.length) {
      if (empty) empty.classList.remove("hidden");
      updatePageInfo(0);
      syncQueryParams();
      return;
    }

    const rows = items
      .map((it) => {
        const expired = toEpochSec(it.expires_at) <= Math.floor(Date.now() / 1000);
        return `
          <tr>
            <td class="mono">${it.conversation_id || "-"}</td>
            <td class="mono">${maskToken(it.token)}</td>
            <td class="mono">${it.upstream_conversation_id || "-"}</td>
            <td class="mono">${it.response_id || "-"}</td>
            <td class="mono">${it.share_link_id || "-"}</td>
            <td>${fmtTs(it.updated_at)}</td>
            <td class="${expired ? "tag-expired" : "tag-active"}">${fmtTs(it.expires_at)}</td>
            <td class="text-center">
              <button class="geist-button-outline text-xs px-2" onclick="clearByConversation('${(it.conversation_id || "").replace(/'/g, "&#39;")}')">清理</button>
            </td>
          </tr>`;
      })
      .join("");

    if (tbody) tbody.innerHTML = rows;
    updatePageInfo(items.length);
    syncQueryParams();
  } catch (e) {
    showToast(`加载失败: ${e.message || e}`, "error");
  } finally {
    showLoading(false);
  }
}

async function clearByConversation(conversationId) {
  if (!conversationId) return;
  if (!window.confirm(`确认清理会话 ${conversationId} ?`)) return;
  try {
    const res = await fetch("/v1/admin/conversations/clear", {
      method: "POST",
      headers: {
        ...buildAuthHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("会话已清理", "success");
    await loadConversations();
  } catch (e) {
    showToast(`清理失败: ${e.message || e}`, "error");
  }
}

async function clearExpired() {
  if (!window.confirm("确认清理所有过期会话?")) return;
  try {
    const res = await fetch("/v1/admin/conversations/clear", {
      method: "POST",
      headers: {
        ...buildAuthHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expired_only: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    showToast(`已清理 ${data.deleted || 0} 条`, "success");
    await loadConversations();
  } catch (e) {
    showToast(`清理失败: ${e.message || e}`, "error");
  }
}

async function clearByToken() {
  const token = String(byId("filter-token")?.value || "").trim();
  if (!token) {
    showToast("请先输入 Token", "warning");
    return;
  }
  if (!window.confirm("确认按该 Token 清理会话?")) return;
  try {
    const res = await fetch("/v1/admin/conversations/clear", {
      method: "POST",
      headers: {
        ...buildAuthHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    showToast(`已清理 ${data.deleted || 0} 条`, "success");
    await loadConversations();
  } catch (e) {
    showToast(`清理失败: ${e.message || e}`, "error");
  }
}

function bindEvents() {
  byId("btn-search")?.addEventListener("click", async () => {
    filterToken = String(byId("filter-token")?.value || "").trim();
    page = 1;
    await loadConversations();
  });

  byId("btn-reset")?.addEventListener("click", async () => {
    const input = byId("filter-token");
    if (input) input.value = "";
    filterToken = "";
    page = 1;
    await loadConversations();
  });

  byId("filter-token")?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    filterToken = String(byId("filter-token")?.value || "").trim();
    page = 1;
    await loadConversations();
  });

  byId("btn-clear-expired")?.addEventListener("click", clearExpired);
  byId("btn-clear-token")?.addEventListener("click", clearByToken);

  byId("btn-prev")?.addEventListener("click", async () => {
    if (page <= 1) return;
    page -= 1;
    await loadConversations();
  });
  byId("btn-next")?.addEventListener("click", async () => {
    const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
    if (page >= totalPages) return;
    page += 1;
    await loadConversations();
  });

  byId("page-size")?.addEventListener("change", async (e) => {
    pageSize = Number(e.target.value || 50);
    page = 1;
    await loadConversations();
  });
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) return;
  bootstrapFromQuery();
  bindEvents();
  await loadConversations();
}

document.addEventListener("DOMContentLoaded", init);
window.clearByConversation = clearByConversation;
