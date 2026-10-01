'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { hashPassword, hashToken, randomToken, SESSION_TTL_MS } = require('./security');

const USER_SEEDS = [
  { id: 'erblin', name: 'Erblin', role: 'Developer', env: 'ERBLIN_PASSWORD', color: 'blue' },
  { id: 'shkumbin', name: 'Shkumbin', role: 'Team member', env: 'SHKUMBIN_PASSWORD', color: 'violet' },
  { id: 'altin', name: 'Altin', role: 'Team member', env: 'ALTIN_PASSWORD', color: 'amber' }
];

function publicUser(row) {
  return row ? { id: row.id, name: row.name, role: row.role, color: row.color } : null;
}

class TaskflowDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.seedUsers();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        color TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
        status TEXT NOT NULL CHECK(status IN ('todo','in-progress','done')),
        deadline TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL REFERENCES users(id),
        assigned_to TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_access_idx ON tasks(created_by, assigned_to, created_at DESC);
      CREATE TABLE IF NOT EXISTS bugs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','critical')),
        status TEXT NOT NULL CHECK(status IN ('open','in-progress','testing','resolved','closed')),
        screenshot BLOB,
        screenshot_type TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        assigned_to TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bugs_access_idx ON bugs(created_by, assigned_to, created_at DESC);
    `);
  }

  seedUsers() {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    if (count) return;
    const missing = USER_SEEDS.filter((user) => !process.env[user.env] || process.env[user.env].length < 12 || process.env[user.env].startsWith('replace-'));
    if (missing.length) {
      throw new Error(`First start requires strong passwords (12+ characters) in: ${missing.map((user) => user.env).join(', ')}`);
    }
    const insert = this.db.prepare('INSERT INTO users (id, name, role, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const user of USER_SEEDS) insert.run(user.id, user.name, user.role, user.color, hashPassword(process.env[user.env]), now);
  }

  listUsers() {
    return this.db.prepare('SELECT id, name, role, color FROM users ORDER BY CASE id WHEN \'erblin\' THEN 1 WHEN \'shkumbin\' THEN 2 ELSE 3 END').all();
  }

  getUser(id) {
    return publicUser(this.db.prepare('SELECT id, name, role, color FROM users WHERE id = ?').get(id));
  }

  getUserForLogin(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  userExists(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
  }

  createSession(userId) {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(hashToken(token), userId, csrfToken, now + SESSION_TTL_MS, now);
    return { token, csrfToken, expiresAt: now + SESSION_TTL_MS };
  }

  getSession(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT s.csrf_token, s.expires_at, u.id, u.name, u.role, u.color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now());
    if (!row) return null;
    return { csrfToken: row.csrf_token, expiresAt: row.expires_at, user: publicUser(row) };
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  listTasks(userId) {
    return this.db.prepare('SELECT * FROM tasks WHERE created_by = ? OR assigned_to = ? ORDER BY created_at DESC').all(userId, userId).map(this.serializeTask);
  }

  getTask(id) {
    return this.serializeTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  createTask(task) {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare('INSERT INTO tasks (id, title, description, priority, status, deadline, created_by, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, task.title, task.description, task.priority, task.status, task.deadline, task.createdBy, task.assignedTo, now, now);
    return this.getTask(id);
  }

  updateTask(id, task) {
    this.db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, deadline = ?, assigned_to = ?, updated_at = ? WHERE id = ?').run(task.title, task.description, task.priority, task.status, task.deadline, task.assignedTo, Date.now(), id);
    return this.getTask(id);
  }

  updateTaskStatus(id, status) {
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
    return this.getTask(id);
  }

  deleteTask(id) { return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0; }

  listBugs(userId) {
    return this.db.prepare('SELECT id, title, description, url, priority, status, screenshot IS NOT NULL AS has_screenshot, created_by, assigned_to, created_at, updated_at FROM bugs WHERE created_by = ? OR assigned_to = ? ORDER BY created_at DESC').all(userId, userId).map(this.serializeBug);
  }

  getBug(publicId) {
    const id = this.parseBugId(publicId);
    if (!id) return null;
    return this.serializeBug(this.db.prepare('SELECT id, title, description, url, priority, status, screenshot IS NOT NULL AS has_screenshot, created_by, assigned_to, created_at, updated_at FROM bugs WHERE id = ?').get(id));
  }

  getBugScreenshot(publicId) {
    const id = this.parseBugId(publicId);
    return id ? this.db.prepare('SELECT screenshot, screenshot_type, created_by, assigned_to FROM bugs WHERE id = ?').get(id) : null;
  }

  createBug(bug) {
    const now = Date.now();
    const result = this.db.prepare('INSERT INTO bugs (title, description, url, priority, status, screenshot, screenshot_type, created_by, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(bug.title, bug.description, bug.url, bug.priority, bug.status, bug.screenshot, bug.screenshotType, bug.createdBy, bug.assignedTo, now, now);
    return this.getBug(`BUG-${result.lastInsertRowid}`);
  }

  updateBug(publicId, bug) {
    const id = this.parseBugId(publicId);
    this.db.prepare('UPDATE bugs SET title = ?, description = ?, url = ?, priority = ?, status = ?, screenshot = ?, screenshot_type = ?, assigned_to = ?, updated_at = ? WHERE id = ?').run(bug.title, bug.description, bug.url, bug.priority, bug.status, bug.screenshot, bug.screenshotType, bug.assignedTo, Date.now(), id);
    return this.getBug(publicId);
  }

  updateBugStatus(publicId, status) {
    const id = this.parseBugId(publicId);
    this.db.prepare('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
    return this.getBug(publicId);
  }

  deleteBug(publicId) {
    const id = this.parseBugId(publicId);
    return id ? this.db.prepare('DELETE FROM bugs WHERE id = ?').run(id).changes > 0 : false;
  }

  parseBugId(publicId) {
    const match = /^BUG-(\d+)$/.exec(String(publicId));
    return match ? Number(match[1]) : 0;
  }

  serializeTask(row) {
    if (!row) return null;
    return { id: row.id, title: row.title, description: row.description, priority: row.priority, status: row.status, deadline: row.deadline, createdBy: row.created_by, assignedTo: row.assigned_to, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }

  serializeBug(row) {
    if (!row) return null;
    return { id: `BUG-${String(row.id).padStart(3, '0')}`, title: row.title, description: row.description, url: row.url, priority: row.priority, status: row.status, hasScreenshot: Boolean(row.has_screenshot), createdBy: row.created_by, assignedTo: row.assigned_to, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }

  close() { this.db.close(); }
}

module.exports = { TaskflowDatabase };
