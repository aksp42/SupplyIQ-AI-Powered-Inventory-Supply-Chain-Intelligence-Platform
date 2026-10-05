/**
 * api.js — SupplyIQ Frontend API Client
 *
 * Centralized fetch wrapper for all backend communication.
 * - Automatic JWT injection from session
 * - storeId injection from session
 * - 401 → session clear + redirect to login
 * - 403 → access denied handling
 * - Network error handling
 * - Only exposes endpoints that actually exist in the backend
 */
(() => {
  'use strict';

  const API_BASE = 'http://localhost:4000/api';

  // ─── Session helpers ──────────────────────────────────────────────
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem('siq_session'));
    } catch {
      return null;
    }
  }

  function clearSessionAndRedirect() {
    localStorage.setItem('siq_signed_out', '1');
    localStorage.removeItem('siq_session');
    localStorage.removeItem('siq-store');
    window.location.replace('public/login.html');
  }

  function getStoreId() {
    const sess = getSession();
    if (sess?.storeId) return sess.storeId;
    // No storeId in session → cannot make store-scoped calls
    return null;
  }

  // ─── Core fetch wrapper ───────────────────────────────────────────
  async function apiFetch(path, options = {}) {
    const session = getSession();
    const storeId = getStoreId();

    const headers = {
      'Content-Type': 'application/json',
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    };

    // Auto-inject storeId for store-scoped endpoints
    if (storeId && !path.includes('storeId=')) {
      const sep = path.includes('?') ? '&' : '?';
      path = `${path}${sep}storeId=${encodeURIComponent(storeId)}`;
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
      });
    } catch (err) {
      // Network error (offline, CORS, etc.)
      throw new Error('Network error: cannot reach backend. Is the server running on port 4000?');
    }

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    if (response.status === 401) {
      clearSessionAndRedirect();
      throw Object.assign(new Error('Session expired. Please log in again.'), { status: 401 });
    }

    if (response.status === 403) {
      throw Object.assign(new Error(data.error || 'Access denied: you do not have permission for this store.'), { status: 403 });
    }

    if (!response.ok) {
      // The HTTP status and the backend's error code travel with the message:
      // callers that need to distinguish "these columns are wrong" (400) from
      // "this file is already in" (409) cannot tell them apart from the text.
      throw Object.assign(
        new Error(data.error || `HTTP ${response.status}: ${response.statusText}`),
        { status: response.status, code: data.code || null });
    }

    return data;
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────
  const api = {
    get:    (path) => apiFetch(path, { method: 'GET' }),
    post:   (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
    put:    (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (path) => apiFetch(path, { method: 'DELETE' }),
  };

  // ─── Auth endpoints ───────────────────────────────────────────────
  const auth = {
    login:      (email, password)           => api.post('/login', { email, password }),
    signup:     (name, email, password, businessType, phone, code) =>
                api.post('/signup', { name, email, password, businessType, phone, code }),
    firebase:   (idToken)                   => api.post('/auth/firebase', { idToken }),
    me:         ()                          => api.get('/me'),
    permissions:()                          => api.get('/me/permissions'),
    sendOtp:    (email, purpose)            => api.post('/otp/send', { email, purpose }),
    verifyOtp:  (email, code, purpose)      => api.post('/otp/verify', { email, code, purpose }),
    resetPassword: (email, code, newPassword)=> api.post('/password/reset', { email, code, newPassword }),
    logout:     ()                          => { localStorage.setItem('siq_signed_out', '1'); localStorage.removeItem('siq_session'); localStorage.removeItem('siq-store'); },
  };

  // ─── Store / Profile ──────────────────────────────────────────────
  const store = {
    list:       () => api.get('/stores'),
    get:        (storeId) => api.get(`/stores/${encodeURIComponent(storeId)}`),
    profile:    () => {
      const sid = getStoreId();
      return sid ? api.get(`/stores/${encodeURIComponent(sid)}`) : Promise.reject(new Error('No storeId in session'));
    },
  };

  // ─── KPIs ─────────────────────────────────────────────────────────
  const kpis = {
    get: () => api.get('/kpis'),
  };

  // ─── Sales ────────────────────────────────────────────────────────
  const sales = {
    get: (period = '1W') => api.get(`/sales?period=${encodeURIComponent(period)}`),
  };

  // ─── Inventory ────────────────────────────────────────────────────
  const inventory = {
    get: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/inventory${qs ? '?' + qs : ''}`);
    },
  };

  // ─── Products ──────────────────────────────────────────────────────
  // Creates a product by hand. "Add Stock" on the dashboard accepts a name the
  // user types, and without this the quantity could only ever live in the
  // browser tab — there was no route to save the name it belonged to.
  const products = {
    create: ({ name, sku, quantity, unitCost, sellPrice, category, supplier,
               reorderPoint, safetyStock, maxStock, monthlyDemand } = {}) =>
      api.post('/products', {
        name, sku, quantity, unitCost, sellPrice,
        category, supplier, reorderPoint, safetyStock, maxStock, monthlyDemand }),
  };

  // ─── Stock movements ──────────────────────────────────────────────
  const stock = {
    in:  (sku, quantity, note, unitCost, reason) => api.post('/stock/in',  { sku, quantity, note, unitCost, reason }),
    out: (sku, quantity, note, reason)          => api.post('/stock/out', { sku, quantity, note, reason }),
    transactions: (sku) => api.get(`/stock/transactions${sku ? '?sku=' + encodeURIComponent(sku) : ''}`),

    // The Stock Out screen. Deliberately not folded into `out` above: that call
    // path is the one the Sales button uses and it is frozen, so it keeps its
    // exact three-argument signature. This posts to the same endpoint with the
    // two extra fields the screen needs, and there is still only one server-side
    // writer of stock movements.
    outRecord: (sku, quantity, reason, date, invoiceNo) =>
      api.post('/stock/out', { sku, quantity, reason, date, invoiceNo }),
    outHistory: ({ from, to, sku } = {}) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (sku) q.set('sku', sku);
      const qs = q.toString();
      return api.get(`/stock/out${qs ? '?' + qs : ''}`);
    },
  };

  // ─── Purchase Orders / Orders ─────────────────────────────────────
  const orders = {
    list:    () => api.get('/orders'),
create:  (supplier, sku, product, quantity, total_value, unit_cost, expected_date) =>
                api.post('/orders', { supplier, sku, product, quantity, total_value, unit_cost, expected_date }),
    receive: (orderNo) => api.post(`/orders/${encodeURIComponent(orderNo)}/receive`, {}),
  };

  // ─── CSV Imports ──────────────────────────────────────────────────
  // Templates come back as raw CSV text, so they need their own fetch: the
  // shared apiFetch always calls response.json() and would mangle the body.
  async function templateText(type) {
    const session = getSession();
    const storeId = getStoreId();
    const url = `${API_BASE}/imports/template/${encodeURIComponent(type)}`
      + (storeId ? `?storeId=${encodeURIComponent(storeId)}` : '');

    let response;
    try {
      response = await fetch(url, {
        headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
      });
    } catch {
      throw new Error('Network error: cannot reach the backend to download the template.');
    }
    if (response.status === 401) {
      clearSessionAndRedirect();
      throw new Error('Session expired. Please log in again.');
    }
    if (!response.ok) throw new Error(`Could not download the template (HTTP ${response.status}).`);
    return response.text();
  }

const imports = {
      types:     () => api.get('/imports/types'),
      template:  templateText,
      // 'auto' asks the backend to identify the format from the column headers.
      validate:  (type, fileName, content) => api.post('/imports/validate', { type, fileName, content }),
      get:       (id) => api.get(`/imports/${encodeURIComponent(id)}`),
      commit:    (id) => api.post(`/imports/${encodeURIComponent(id)}/commit`, {}),
      history:   () => api.get('/imports'),
    };

  // ─── Chat / TradeSaarthi ──────────────────────────────────────────
  const chat = {
    send: (message) => api.post('/chat', { message }),
  };

  // ─── Demand forecast ───────────────────────────────────────────────
  // Reads the movement ledger for one product. Returns the real series it holds
  // plus whether there is enough of it to forecast from; an empty result is a
  // valid answer, not a reason for the caller to draw something instead.
  const forecast = {
    history: (sku, days = 30) =>
      api.get(`/forecast/history?sku=${encodeURIComponent(sku)}&days=${days}`),
  };

  // ─── Expose ───────────────────────────────────────────────────────
  window.siqApi = {
    api,
    auth,
    store,
    kpis,
    sales,
    inventory,
    products,
    stock,
    orders,
    imports,
    chat,
    forecast,
    getStoreId,
    getSession,
    clearSessionAndRedirect,
  };
})();