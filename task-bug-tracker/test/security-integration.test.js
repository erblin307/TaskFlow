'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ERBLIN_PASSWORD = 'Erblin-test-password-2026!';
process.env.SHKUMBIN_PASSWORD = 'Shkumbin-test-password-2026!';
process.env.ALTIN_PASSWORD = 'Altin-test-password-2026!';
process.env.NODE_ENV = 'test';

const { createTaskflowServer } = require('../server/server');

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-test-'));
  const { server, db } = createTaskflowServer({ databasePath: path.join(temp, 'test.db') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  async function call(url, options = {}) {
    const headers = { Origin: base, ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.session?.cookie) headers.Cookie = options.session.cookie;
    if (options.session?.csrf && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = options.session.csrf;
    const response = await fetch(`${base}${url}`, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
    return { response, body };
  }

  async function login(username, password) {
    const result = await call('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(result.response.status, 200);
    const cookieHeader = result.response.headers.getSetCookie()[0];
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Strict/i);
    return { cookie: cookieHeader.split(';')[0], csrf: result.body.csrfToken, user: result.body.user };
  }

  try {
    const page = await call('/');
    assert.equal(page.response.status, 200);
    assert.match(page.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.response.headers.get('x-content-type-options'), 'nosniff');

    const badLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'erblin', password: 'wrong-password' } });
    assert.equal(badLogin.response.status, 401);

    const shkumbin = await login('shkumbin', process.env.SHKUMBIN_PASSWORD);
    const erblin = await login('erblin', process.env.ERBLIN_PASSWORD);
    const altin = await login('altin', process.env.ALTIN_PASSWORD);
    assert.notEqual(db.getUserForLogin('erblin').password_hash, process.env.ERBLIN_PASSWORD);

    const missingCsrf = await call('/api/tasks', { method: 'POST', session: { cookie: shkumbin.cookie }, body: {} });
    assert.equal(missingCsrf.response.status, 403);

    const createdTask = await call('/api/tasks', { method: 'POST', session: shkumbin, body: { title: 'Review API changes', description: 'Validate the new response contract.', priority: 'high', status: 'todo', assignedTo: 'erblin', deadline: '2026-10-15' } });
    assert.equal(createdTask.response.status, 201);
    const taskId = createdTask.body.task.id;

    const erblinTasks = await call('/api/tasks', { session: erblin });
    const altinTasks = await call('/api/tasks', { session: altin });
    assert.equal(erblinTasks.body.tasks.length, 1);
    assert.equal(altinTasks.body.tasks.length, 0);

    const statusUpdate = await call(`/api/tasks/${taskId}`, { method: 'PATCH', session: erblin, body: { status: 'in-progress' } });
    assert.equal(statusUpdate.response.status, 200);
    const forbiddenEdit = await call(`/api/tasks/${taskId}`, { method: 'PATCH', session: erblin, body: { ...createdTask.body.task, title: 'Unauthorized edit' } });
    assert.equal(forbiddenEdit.response.status, 403);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const createdBug = await call('/api/bugs', { method: 'POST', session: altin, body: { title: 'Checkout crash', description: 'The page crashes when saving.', url: 'https://example.com/checkout', priority: 'critical', status: 'open', assignedTo: 'erblin', screenshot: png } });
    assert.equal(createdBug.response.status, 201);
    const bugId = createdBug.body.bug.id;

    const erblinBugs = await call('/api/bugs', { session: erblin });
    const shkumbinBugs = await call('/api/bugs', { session: shkumbin });
    assert.equal(erblinBugs.body.bugs.length, 1);
    assert.equal(shkumbinBugs.body.bugs.length, 0);
    const allowedImage = await call(`/api/bugs/${bugId}/screenshot`, { session: erblin });
    const blockedImage = await call(`/api/bugs/${bugId}/screenshot`, { session: shkumbin });
    assert.equal(allowedImage.response.status, 200);
    assert.equal(allowedImage.response.headers.get('content-type'), 'image/png');
    assert.equal(blockedImage.response.status, 404);

    const deleted = await call(`/api/tasks/${taskId}`, { method: 'DELETE', session: shkumbin, body: {} });
    assert.equal(deleted.response.status, 200);
    console.log('Security integration: PASS');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
