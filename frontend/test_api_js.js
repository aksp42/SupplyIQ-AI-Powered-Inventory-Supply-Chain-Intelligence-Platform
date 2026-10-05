const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/js/api.js',
  method: 'GET'
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Content-Length:', data.length);
    console.log('First 200 chars:', data.substring(0, 200));
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.end();