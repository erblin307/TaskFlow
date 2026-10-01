'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TaskflowDatabase } = require('./database');
const {
  clearSessionCookie,
  createRateLimiter,
  parseCookies,
  securityHeaders,
  sessionCookie,
  verifyPassword
} = require('./security');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRODUCTION = process.env.NODE_ENV === 'production';
const JSON_LIMIT = 7 * 1024 * 1024;
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const writeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 80 });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      reject(new HttpError(415, 'Content-Type must be application/json.'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(new HttpError(413, 'Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(new HttpError(400, 'Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function cleanText(value, label, max, required = true) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is invalid.`);
  const text = value.trim();
  if (required && !text) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) throw new HttpError(400, `${label} is too long.`);
  return text;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label} is invalid.`);
  return value;
}

function validateUrl(value) {
  const text = cleanText(value || '', 'URL', 2000, false);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch (_) { throw new HttpError(400, 'URL must begin with http:// or https://.'); }
}

function validateDeadline(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())) throw new HttpError(400, 'Deadline is invalid.');
  return value;
}

function parseScreenshot(value) {
  if (!value) return { screenshot: null, screenshotType: null };
  if (typeof value !== 'string') throw new HttpError(400, 'Screenshot is invalid.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new HttpError(400, 'Screenshot must be PNG, JPG or WEBP.');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 5 * 1024 * 1024) throw new HttpError(400, 'Screenshot must be 5MB or smaller.');
  const mime = match[1];
  const valid = mime === 'image/png'
    ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === 'image/jpeg'
      ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new HttpError(400, 'Screenshot content does not match its image type.');
  return { screenshot: data, screenshotType: mime };
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = `${PRODUCTION ? 'https' : 'http'}://${req.headers.host}`;
  if (origin !== expected) throw new HttpError(403, 'Cross-origin request blocked.');
}

function authenticate(req, db) {
  const token = parseCookies(req.headers.cookie).taskflow_session;
  const session = db.getSession(token);
  if (!session) throw new HttpError(401, 'Please sign in.');
  return { ...session, token };
}

function authorizeWrite(req, session) {
  assertSameOrigin(req);
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || csrf !== session.csrfToken) throw new HttpError(403, 'Security token is invalid. Refresh and try again.');
  const result = writeLimiter(`${req.socket.remoteAddress}:${session.user.id}`);
  if (!result.allowed) throw new HttpError(429, `Too many requests. Try again in ${result.retryAfter} seconds.`);
}

function assertAssignee(db, id) {
  if (!db.userExists(id)) throw new HttpError(400, 'Assigned user does not exist.');
  return id;
}

function taskInput(body, db, existing = null) {
  return {
    title: cleanText(body.title, 'Title', 120),
    description: cleanText(body.description, 'Description', 2000),
    priority: enumValue(body.priority, ['low', 'medium', 'high'], 'Priority'),
    status: enumValue(body.status, ['todo', 'in-progress', 'done'], 'Status'),
    deadline: validateDeadline(body.deadline),
    assignedTo: assertAssignee(db, body.assignedTo),
    createdBy: existing?.createdBy
  };
}

function bugInput(body, db, existing = null) {
  const image = body.screenshot === undefined && existing
    ? { screenshot: existing.screenshot, screenshotType: existing.screenshotType }
    : parseScreenshot(body.screenshot);
  return {
    title: cleanText(body.title, 'Title', 120),
    description: cleanText(body.description, 'Description', 3000),
    url: validateUrl(body.url),
    priority: enumValue(body.priority, ['low', 'medium', 'high', 'critical'], 'Priority'),
    status: enumValue(body.status, ['open', 'in-progress', 'testing', 'resolved', 'closed'], 'Status'),
    assignedTo: assertAssignee(db, body.assignedTo),
    createdBy: existing?.createdBy,
    ...image
  };
}

function canView(item, userId) { return item && (item.createdBy === userId || item.assignedTo === userId); }

function mimeType(filename) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(urlPath, res) {
  const pathname = urlPath === '/' ? '/index.html' : urlPath;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { throw new HttpError(400, 'Invalid path.'); }
  const filename = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!(filename === PUBLIC_DIR || filename.startsWith(`${PUBLIC_DIR}${path.sep}`))) throw new HttpError(403, 'Forbidden.');
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new HttpError(404, 'Not found.');
  const cache = filename.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': mimeType(filename), 'Cache-Control': cache });
  fs.createReadStream(filename).pipe(res);
}

async function api(req, res, url, db) {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    assertSameOrigin(req);
    const body = await readJson(req);
    const username = cleanText(body.username, 'Username', 40).toLowerCase();
    const password = cleanText(body.password, 'Password', 256);
    const limit = loginLimiter(`${req.socket.remoteAddress}:${username}`);
    if (!limit.allowed) throw new HttpError(429, `Too many login attempts. Try again in ${limit.retryAfter} seconds.`);
    const user = db.getUserForLogin(username);
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Username or password is incorrect.');
    const session = db.createSession(user.id);
    send(res, 200, { user: db.getUser(user.id), csrfToken: session.csrfToken }, { 'Set-Cookie': sessionCookie(session.token, PRODUCTION) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    const session = authenticate(req, db);
    send(res, 200, { user: session.user, csrfToken: session.csrfToken });
    return;
  }

  const session = authenticate(req, db);

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    authorizeWrite(req, session);
    db.deleteSession(session.token);
    send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(PRODUCTION) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/users') { send(res, 200, { users: db.listUsers() }); return; }
  if (req.method === 'GET' && url.pathname === '/api/tasks') { send(res, 200, { tasks: db.listTasks(session.user.id) }); return; }
  if (req.method === 'GET' && url.pathname === '/api/bugs') { send(res, 200, { bugs: db.listBugs(session.user.id) }); return; }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    authorizeWrite(req, session);
    const input = taskInput(await readJson(req), db);
    send(res, 201, { task: db.createTask({ ...input, createdBy: session.user.id }) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bugs') {
    authorizeWrite(req, session);
    const input = bugInput(await readJson(req), db);
    send(res, 201, { bug: db.createBug({ ...input, createdBy: session.user.id }) });
    return;
  }

  const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (taskMatch) {
    const task = db.getTask(taskMatch[1]);
    if (!canView(task, session.user.id)) throw new HttpError(404, 'Task not found.');
    if (req.method === 'PATCH') {
      authorizeWrite(req, session);
      const body = await readJson(req);
      if (Object.keys(body).length === 1 && body.status !== undefined) {
        const status = enumValue(body.status, ['todo', 'in-progress', 'done'], 'Status');
        send(res, 200, { task: db.updateTaskStatus(task.id, status) });
      } else {
        if (task.createdBy !== session.user.id) throw new HttpError(403, 'Only the creator can edit this task.');
        send(res, 200, { task: db.updateTask(task.id, taskInput(body, db, task)) });
      }
      return;
    }
    if (req.method === 'DELETE') {
      authorizeWrite(req, session);
      if (task.createdBy !== session.user.id) throw new HttpError(403, 'Only the creator can delete this task.');
      db.deleteTask(task.id);
      send(res, 200, { ok: true });
      return;
    }
  }

  const screenshotMatch = /^\/api\/bugs\/(BUG-\d+)\/screenshot$/.exec(url.pathname);
  if (req.method === 'GET' && screenshotMatch) {
    const shot = db.getBugScreenshot(screenshotMatch[1]);
    if (!shot || !shot.screenshot || (shot.created_by !== session.user.id && shot.assigned_to !== session.user.id)) throw new HttpError(404, 'Screenshot not found.');
    res.writeHead(200, { 'Content-Type': shot.screenshot_type, 'Content-Length': shot.screenshot.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.end(shot.screenshot);
    return;
  }

  const bugMatch = /^\/api\/bugs\/(BUG-\d+)$/.exec(url.pathname);
  if (bugMatch) {
    const bug = db.getBug(bugMatch[1]);
    if (!canView(bug, session.user.id)) throw new HttpError(404, 'Bug not found.');
    if (req.method === 'PATCH') {
      authorizeWrite(req, session);
      const body = await readJson(req);
      if (Object.keys(body).length === 1 && body.status !== undefined) {
        const status = enumValue(body.status, ['open', 'in-progress', 'testing', 'resolved', 'closed'], 'Status');
        send(res, 200, { bug: db.updateBugStatus(bug.id, status) });
      } else {
        if (bug.createdBy !== session.user.id) throw new HttpError(403, 'Only the reporter can edit this bug.');
        const stored = db.getBugScreenshot(bug.id);
        const existing = { ...bug, screenshot: stored?.screenshot || null, screenshotType: stored?.screenshot_type || null };
        send(res, 200, { bug: db.updateBug(bug.id, bugInput(body, db, existing)) });
      }
      return;
    }
    if (req.method === 'DELETE') {
      authorizeWrite(req, session);
      if (bug.createdBy !== session.user.id) throw new HttpError(403, 'Only the reporter can delete this bug.');
      db.deleteBug(bug.id);
      send(res, 200, { ok: true });
      return;
    }
  }

  throw new HttpError(404, 'Endpoint not found.');
}

function createTaskflowServer(options = {}) {
  const databasePath = options.databasePath || process.env.TASKFLOW_DB || path.join(ROOT, 'data', 'taskflow.db');
  const db = new TaskflowDatabase(databasePath);
  const server = http.createServer(async (req, res) => {
    Object.entries(securityHeaders(PRODUCTION)).forEach(([name, value]) => res.setHeader(name, value));
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url, db);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(url.pathname, res);
      else throw new HttpError(405, 'Method not allowed.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, { error: { message: status === 500 ? 'Unexpected server error.' : error.message } });
    }
  });
  server.on('close', () => db.close());
  return { server, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || (PRODUCTION ? '0.0.0.0' : '127.0.0.1');
  const { server } = createTaskflowServer();
  server.listen(port, host, () => console.log(`TaskFlow is running on ${host}:${port}`));
}

module.exports = { createTaskflowServer };
