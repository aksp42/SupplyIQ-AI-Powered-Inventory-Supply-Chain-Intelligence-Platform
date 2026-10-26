const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/SupplyIQ-Grocery-Dashboard.html',
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { });
  res.on('end', () => {
    console.log('Dashboard Status:', res.statusCode);
    console.log('Headers:', res.headers);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.end();