import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export async function withServer(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lemon-api-'));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let child, token;
  const request = (method, endpoint, { body, raw, auth = token, headers = {} } = {}) => fetch(origin + endpoint, {
    method, headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), 'Content-Type': raw === undefined ? 'application/json' : 'application/octet-stream', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(120000),
  });
  const api = async (method, endpoint, body, options = {}) => {
    const response = await request(method, endpoint, { ...options, body });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    assert.equal(response.status, options.expect ?? 200, `${method} ${endpoint}: ${JSON.stringify(data).slice(0, 400)}`);
    return data;
  };
  const start = async () => {
    const env = { ...process.env, ...(process.platform === 'win32' ? { PATH: 'E:\\MinGW64\\bin;' + process.env.PATH } : {}) };
    child = spawn(path.resolve(process.argv[2]), ['--host', '127.0.0.1', '--port', String(port), '--config', path.join(home, 'server.json')], { cwd: home, env, windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 200; i++) {
      if (await fetch(origin + '/api/auth/status').then(response => response.ok).catch(() => false)) {
        token = (await api('POST', '/api/auth/login', { token: '123456' })).session;
        return;
      }
      assert.equal(child.exitCode, null, 'server exited during startup'); await pause(50);
    }
    throw Error('server did not start');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('exit', resolve)); child.kill();
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await Promise.race([closed, pause(5000)]);
  };
  const idle = async () => {
    for (let i = 0; i < 2400; i++) { if (!(await api('GET', '/api/judge/status')).judging) return; await pause(50); }
    throw Error('judging did not finish');
  };
  try {
    await start();
    await api('PUT', '/api/setup', { contestRoot: path.join(home, 'contests') });
    await run({ home, origin, api, request, idle, pause, restart: async () => { await stop(); await start(); } });
  } finally { await stop(); await fs.rm(home, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 }); }
}
