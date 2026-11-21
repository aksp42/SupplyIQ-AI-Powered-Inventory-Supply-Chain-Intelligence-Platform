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

  const API_BASE = window.API_BASE
    || (window.location.hostname === 'localhost' && window.location.port === '3000'
        ? 'http://localhost:4000/api'
        : '/api');

  // ─── Demo Mode Interceptor ─────────────────────────────────────────
  const DEMO_STORE = {
    store_id: 'demo-store-01',
    name: 'SupplyIQ Supermarket (Demo Store)',
    owner_name: 'Demo Visitor',
    owner_initials: 'DV',
    city: 'Mysuru',
    theme: 'green',
    suppliers: [
      { name: 'Krishna Wholesale', contact: 'Ramesh Iyer', city: 'Mysuru', rating: 4.4, terms: 'Net 30' },
      { name: 'FreshFarm Co.', contact: 'Anita Desai', city: 'Bengaluru', rating: 4.1, terms: 'Net 15' },
      { name: 'AgriLink Suppliers', contact: 'Suresh Nair', city: 'Hassan', rating: 3.8, terms: 'Advance 50%' }
    ]
  };

  const DEMO_INVENTORY = [
    { sku: 'GRC-001', name: 'Basmati Rice 5kg', category: 'Staples', supplier: 'Krishna Wholesale', quantity: 8, unit_cost: 620, sell_price: 780, monthly_demand: 420, monthly_demand_est: 420, reorder_point: 50, status: 'Critical', forecast_low: 12, forecast_high: 16, forecast_sufficient: true, forecast_level: 14, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '5kg' },
    { sku: 'GRC-002', name: 'Sunflower Oil 1L', category: 'Oils', supplier: 'FreshFarm Co.', quantity: 22, unit_cost: 165, sell_price: 210, monthly_demand: 300, monthly_demand_est: 300, reorder_point: 30, status: 'Low', forecast_low: 9, forecast_high: 12, forecast_sufficient: true, forecast_level: 10, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '1L' },
    { sku: 'GRC-003', name: 'Wheat Atta 10kg', category: 'Staples', supplier: 'Krishna Wholesale', quantity: 64, unit_cost: 260, sell_price: 330, monthly_demand: 220, monthly_demand_est: 220, reorder_point: 30, status: 'Healthy', forecast_low: 6, forecast_high: 9, forecast_sufficient: true, forecast_level: 7, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '10kg' },
    { sku: 'GRC-004', name: 'Toor Dal 1kg', category: 'Pulses', supplier: 'AgriLink Suppliers', quantity: 95, unit_cost: 140, sell_price: 175, monthly_demand: 180, monthly_demand_est: 180, reorder_point: 25, status: 'Healthy', forecast_low: 5, forecast_high: 7, forecast_sufficient: true, forecast_level: 6, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '1kg' },
    { sku: 'GRC-005', name: 'Tata Tea Gold 500g', category: 'Beverages', supplier: 'Krishna Wholesale', quantity: 150, unit_cost: 280, sell_price: 340, monthly_demand: 110, monthly_demand_est: 110, reorder_point: 20, status: 'Overstock', forecast_low: 3, forecast_high: 5, forecast_sufficient: true, forecast_level: 4, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '500g' },
    { sku: 'GRC-006', name: 'Aashirvaad Salt 1kg', category: 'Spices', supplier: 'FreshFarm Co.', quantity: 45, unit_cost: 24, sell_price: 30, monthly_demand: 150, monthly_demand_est: 150, reorder_point: 20, status: 'Healthy', forecast_low: 4, forecast_high: 6, forecast_sufficient: true, forecast_level: 5, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '1kg' },
    { sku: 'GRC-007', name: 'Maggi 2-Minute Noodles 280g', category: 'Staples', supplier: 'AgriLink Suppliers', quantity: 12, unit_cost: 48, sell_price: 60, monthly_demand: 320, monthly_demand_est: 320, reorder_point: 40, status: 'Critical', forecast_low: 10, forecast_high: 14, forecast_sufficient: true, forecast_level: 12, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: 'Pack of 4' },
    { sku: 'GRC-008', name: 'Everest Garam Masala 100g', category: 'Spices', supplier: 'FreshFarm Co.', quantity: 38, unit_cost: 72, sell_price: 92, monthly_demand: 90, monthly_demand_est: 90, reorder_point: 15, status: 'Healthy', forecast_low: 2, forecast_high: 4, forecast_sufficient: true, forecast_level: 3, forecast_basis: 'Observed sales ledger', forecast_observed_days: 30, pack_size: '100g' }
  ];

  const DEMO_KPIS = {
    // Fields the dashboard renderPeriod / loadKpis reads:
    todaySales:     38600,
    todayProfit:    8900,
    todayUnitsSold: 94,
    weekSales:      201000,
    weekProfit:     46900,
    runningOut:     2,          // Critical stock items
    stockReceived:  180,        // Units received in last 30 days
    inventoryValue: 118450,
    totalProducts:  8,
    pendingOrders:  2,
    stockoutRisk:   3,
    overstockCount: 1,
    margin:         23.3,
    categories: {
      Staples: 3, Oils: 1, Pulses: 1,
      Beverages: 1, Spices: 2
    },
    // % change vs previous period — [Sales, Profit, ProductsSold, RunningOut, StockReceived]
    delta1D: [ 12.4,  9.8, 11.2, 0, 0 ],
    delta1W: [  8.3,  6.1,  7.5, 0, 0 ],
  };

  // DEMO_SALES must be an ARRAY of day objects — same shape the backend returns
  // so loadSalesChart()'s data.map() / data.length calls work correctly.
  function _demoSalesForPeriod(period) {
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    const day = ms => new Date(today - ms);
    const MS  = 86400000;
    const salesByPeriod = {
      '1D':  [{ date: fmt(today),         sales: 38600, profit: 8900, units_sold: 94, orders_count: 31 }],
      '1W':  [
        { date: fmt(day(6*MS)), sales: 18400, profit: 4200, units_sold: 48, orders_count: 16 },
        { date: fmt(day(5*MS)), sales: 22100, profit: 5100, units_sold: 57, orders_count: 19 },
        { date: fmt(day(4*MS)), sales: 19800, profit: 4600, units_sold: 51, orders_count: 17 },
        { date: fmt(day(3*MS)), sales: 26400, profit: 6200, units_sold: 68, orders_count: 22 },
        { date: fmt(day(2*MS)), sales: 34200, profit: 8100, units_sold: 88, orders_count: 29 },
        { date: fmt(day(1*MS)), sales: 41500, profit: 9800, units_sold: 107, orders_count: 35 },
        { date: fmt(today),     sales: 38600, profit: 8900, units_sold: 94,  orders_count: 31 }
      ],
      '15D': [
        { date: fmt(day(14*MS)), sales: 15200, profit: 3500, units_sold: 39, orders_count: 13 },
        { date: fmt(day(13*MS)), sales: 18700, profit: 4300, units_sold: 48, orders_count: 16 },
        { date: fmt(day(12*MS)), sales: 21000, profit: 4900, units_sold: 54, orders_count: 18 },
        { date: fmt(day(11*MS)), sales: 17500, profit: 4100, units_sold: 45, orders_count: 15 },
        { date: fmt(day(10*MS)), sales: 23400, profit: 5500, units_sold: 60, orders_count: 20 },
        { date: fmt(day(9*MS)),  sales: 19800, profit: 4600, units_sold: 51, orders_count: 17 },
        { date: fmt(day(8*MS)),  sales: 26400, profit: 6200, units_sold: 68, orders_count: 22 },
        { date: fmt(day(7*MS)),  sales: 18400, profit: 4200, units_sold: 48, orders_count: 16 },
        { date: fmt(day(6*MS)),  sales: 22100, profit: 5100, units_sold: 57, orders_count: 19 },
        { date: fmt(day(5*MS)),  sales: 19800, profit: 4600, units_sold: 51, orders_count: 17 },
        { date: fmt(day(4*MS)),  sales: 26400, profit: 6200, units_sold: 68, orders_count: 22 },
        { date: fmt(day(3*MS)),  sales: 34200, profit: 8100, units_sold: 88, orders_count: 29 },
        { date: fmt(day(2*MS)),  sales: 41500, profit: 9800, units_sold: 107, orders_count: 35 },
        { date: fmt(day(1*MS)),  sales: 38600, profit: 8900, units_sold: 94,  orders_count: 31 },
        { date: fmt(today),      sales: 38600, profit: 8900, units_sold: 94,  orders_count: 31 }
      ],
      '1M':  [
        { date: fmt(day(29*MS)), sales: 480000, profit: 112000, units_sold: 1240, orders_count: 413 },
        { date: fmt(day(22*MS)), sales: 512000, profit: 119000, units_sold: 1320, orders_count: 440 },
        { date: fmt(day(15*MS)), sales: 495000, profit: 115000, units_sold: 1280, orders_count: 426 },
        { date: fmt(day(7*MS)),  sales: 541000, profit: 126000, units_sold: 1395, orders_count: 465 },
        { date: fmt(today),      sales: 348200, profit:  46900, units_sold:  624, orders_count: 208 }
      ]
    };
    return salesByPeriod[period] || salesByPeriod['1W'];
  }

  const DEMO_ORDERS = [
    { order_no: 'PO-DEMO-01', supplier: 'Krishna Wholesale', sku: 'GRC-001', product: 'Basmati Rice 5kg', quantity: 60, total_value: 37200, status: 'Ordered', expected_date: '2026-11-26' },
    { order_no: 'PO-DEMO-02', supplier: 'FreshFarm Co.', sku: 'GRC-002', product: 'Sunflower Oil 1L', quantity: 40, total_value: 6600, status: 'Delivered', expected_date: '2026-11-20' },
    { order_no: 'PO-DEMO-03', supplier: 'AgriLink Suppliers', sku: 'GRC-007', product: 'Maggi 2-Minute Noodles 280g', quantity: 80, total_value: 3840, status: 'Ordered', expected_date: '2026-11-25' }
  ];

  function handleDemoApi(path, options = {}) {
    const cleanPath = path.split('?')[0];
    if (cleanPath.startsWith('/stores/') || cleanPath === '/store/profile') {
      return Promise.resolve(DEMO_STORE);
    }
    if (cleanPath === '/inventory') {
      return Promise.resolve([...DEMO_INVENTORY]);
    }
    if (cleanPath === '/kpis') {
      return Promise.resolve({ ...DEMO_KPIS });
    }
    if (cleanPath === '/sales') {
      // Extract the period query param (e.g. /sales?period=1W → '1W')
      const periodParam = (path.split('period=')[1] || '1W').split('&')[0];
      return Promise.resolve(_demoSalesForPeriod(decodeURIComponent(periodParam)));
    }
    if (cleanPath === '/orders') {
      return Promise.resolve([...DEMO_ORDERS]);
    }
    if (cleanPath.startsWith('/forecast/history')) {
      return Promise.resolve({
        sku: 'GRC-001',
        days_observed: 30,
        history: [
          { date: '2026-11-18', sales: 14 },
          { date: '2026-11-19', sales: 15 },
          { date: '2026-11-20', sales: 13 },
          { date: '2026-11-21', sales: 16 }
        ],
        sufficient: true,
        forecast: { low: 12, high: 16, mean: 14 }
      });
    }
    if (cleanPath === '/chat') {
      return Promise.resolve({
        reply: 'Hello! I am TradeSaarthi, your AI Business Guide. Currently you are in Demo Mode. Your Basmati Rice 5kg is critical (8 units left, demand is 14 units/day). I recommend placing an order for 60 units from Krishna Wholesale.'
      });
    }
    if (cleanPath === '/imports/types') {
      return Promise.resolve([
        { type: 'ledger', label: 'Stock Movement Ledger' },
        { type: 'products', label: 'Product Master Catalog' }
      ]);
    }
    if (cleanPath === '/imports') {
      return Promise.resolve([
        { id: 1, file_name: 'demo_ledger_november.csv', status: 'ready', entity_type: 'ledger', total_rows: 100, valid_rows: 100, error_rows: 0, created_at: new Date().toISOString() }
      ]);
    }
    if (cleanPath.startsWith('/imports/')) {
      return Promise.resolve({
        job: { id: 1, file_name: 'demo_sample.csv', status: 'ready', total_rows: 10, valid_rows: 10, error_rows: 0 },
        preview: DEMO_INVENTORY.slice(0, 5),
        headers: ['Date', 'Type', 'Product', 'Quantity', 'Unit Cost']
      });
    }
    return Promise.resolve({ success: true, message: 'Action simulated in Demo Mode.' });
  }

  // ─── Session helpers ──────────────────────────────────────────────
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem('siq_session'));
    } catch {
      return null;
    }
  }

  function clearSessionAndRedirect() {
    const session = getSession();
    if (session?.isDemo) return;
    localStorage.setItem('siq_signed_out', '1');
    localStorage.removeItem('siq_session');
    localStorage.removeItem('siq-store');
    window.location.replace('public/login.html');
  }

  function getStoreId() {
    const sess = getSession();
    if (sess?.storeId) return sess.storeId;
    return null;
  }

  // ─── Core fetch wrapper ───────────────────────────────────────────
  async function apiFetch(path, options = {}) {
    const session = getSession();
    if (session?.isDemo) {
      return handleDemoApi(path, options);
    }
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
                api.post('/signup', { name, email, password, businessType, phone, ...(code ? { code } : {}) }),
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
    list:          () => api.get('/stores'),
    get:           (storeId) => api.get(`/stores/${encodeURIComponent(storeId)}`),
    profile:       () => {
      const sid = getStoreId();
      return sid ? api.get(`/stores/${encodeURIComponent(sid)}`) : Promise.reject(new Error('No storeId in session'));
    },
    updateProfile: (data) => api.put('/store/profile', data),
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
    if (session?.isDemo) {
      return 'Date,Type,Product,Quantity,Unit Cost\n2026-11-21,IN,Basmati Rice 5kg,50,620\n';
    }
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