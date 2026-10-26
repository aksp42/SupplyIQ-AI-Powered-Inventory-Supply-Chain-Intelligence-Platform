const fs = require('fs');
const content = fs.readFileSync('SupplyIQ-Grocery-Dashboard.html', 'utf8');

const scriptTags = content.match(/<script[^>]*src=["']([^"']+)["'][^>]*>/g);
console.log('Script tags found:');
console.log(scriptTags);

console.log('Uses siqApi:', content.includes('siqApi'));
console.log('Uses apiFetch:', content.includes('apiFetch'));
console.log('Uses apiGet:', content.includes('apiGet'));
console.log('Uses apiPost:', content.includes('apiPost'));