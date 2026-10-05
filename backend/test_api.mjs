const endpoints = [
  '/api/health',
  '/api/me',
  '/api/kpis',
  '/api/sales?period=1W',
  '/api/inventory',
  '/api/orders',
  '/api/stock/transactions?sku=GRC-001',
  '/api/stores',
  '/api/imports/types',
  '/api/stores/demo-store-01',
  '/api/me/permissions'
];

async function test() {
  // First login
  const loginRes = await fetch('http://localhost:4000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DEMO_EMAIL || 'demo@supplyiq.local',
      password: process.env.DEMO_PASSWORD
    })
  });
  const loginData = await loginRes.json();
  console.log('Login:', loginRes.status, JSON.stringify(loginData));
  
  if (!loginData.token) {
    console.error('Login failed');
    process.exit(1);
  }
  
  const token = loginData.token;
  
  const endpoints = [
    '/api/health',
    '/api/me',
    '/api/kpis',
    '/api/sales?period=1W',
    '/api/inventory',
    '/api/orders',
    '/api/stock/transactions?sku=GRC-001',
    '/api/stores',
    '/api/imports/types',
    '/api/stores/demo-store-01',
    '/api/me/permissions'
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch('http://localhost:4000' + ep, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const text = await res.text();
      console.log(ep, res.status, text.substring(0, 100));
    } catch(e) {
      console.log(ep, 'ERROR:', e.message);
    }
  }
}

test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });