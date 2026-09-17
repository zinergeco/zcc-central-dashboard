const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => console.log(`ZCC coming-soon page running on port ${PORT}`));
