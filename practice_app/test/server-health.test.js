'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_DIR = path.join(__dirname, '..');
const SERVER_PATH = path.join(APP_DIR, 'server.cjs');
function getBackendBuildId() {
  const files = [
    SERVER_PATH,
    path.join(APP_DIR, 'score-data.cjs'),
    ...fs.readdirSync(path.join(APP_DIR, 'lib'))
      .filter(name => name.endsWith('.js'))
      .sort()
      .map(name => path.join(APP_DIR, 'lib', name)),
  ];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(APP_DIR, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/api/health`);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Health endpoint did not become available');
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test('server health endpoint identifies the current practice-app build', async () => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: APP_DIR,
    env: { ...process.env, PRACTICE_APP_PORT: String(port) },
    stdio: 'ignore',
  });

  try {
    const response = await waitForHealth(port);
    const expectedBuildId = getBackendBuildId();
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.appId, 'neothesia-practice-app');
    assert.equal(response.body.buildId, expectedBuildId);
    assert.equal(response.body.port, port);
    assert.ok(response.body.startedAt);
  } finally {
    child.kill();
  }
});
