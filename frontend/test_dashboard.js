const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/SupplyIQ-Grocery-Dashboard.html',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Content-Length:', data.length);
    console.log('First 500 chars:', data.substring(0, 500));
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.end();