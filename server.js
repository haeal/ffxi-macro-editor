import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const rootDir = fileURLToPath(new URL('.', import.meta.url));

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function resolveFilePath(requestUrl) {
  const requestPath = new URL(requestUrl, `http://${host}:${port}`).pathname;
  const safePath = normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const relativePath = safePath.replace(/^[/\\]+/, '');
  const candidate = relativePath === '' ? join(rootDir, 'index.html') : join(rootDir, relativePath);

  if (!candidate.startsWith(rootDir)) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  return null;
}

createServer((request, response) => {
  const filePath = resolveFilePath(request.url ?? '/');

  if (!filePath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream'
  });

  createReadStream(filePath).pipe(response);
}).listen(port, host, () => {
  console.log(`FFXI Macro Editor available at http://${host}:${port}`);
});