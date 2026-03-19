const fs = require('fs');
const v = JSON.parse(fs.readFileSync('version.json', 'utf8'));
v.version += 1;
fs.writeFileSync('version.json', JSON.stringify(v));
const html = fs.readFileSync('public/index.html', 'utf8');
const updated = html.replace(/v\d+<\/span>/g, 'v' + v.version + '</span>');
fs.writeFileSync('public/index.html', updated);
console.log('Version bumped to v' + v.version);
