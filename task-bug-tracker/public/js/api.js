(function () {
  'use strict';

  let csrfToken = '';

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new CustomEvent('taskflow:unauthorized'));
      const error = new Error(payload?.error?.message || 'Request failed.');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function session() {
    const data = await request('/api/auth/session');
    csrfToken = data.csrfToken;
    return data.user;
  }

  async function login(username, password) {
    const data = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    csrfToken = data.csrfToken;
    return data.user;
  }

  async function logout() {
    await request('/api/auth/logout', { method: 'POST', body: {} });
    csrfToken = '';
  }

  window.TaskflowAPI = {
    login,
    logout,
    session,
    users: async () => (await request('/api/users')).users,
    tasks: async () => (await request('/api/tasks')).tasks,
    bugs: async () => (await request('/api/bugs')).bugs,
    createTask: async (body) => (await request('/api/tasks', { method: 'POST', body })).task,
    updateTask: async (id, body) => (await request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body })).task,
    deleteTask: async (id) => request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
    createBug: async (body) => (await request('/api/bugs', { method: 'POST', body })).bug,
    updateBug: async (id, body) => (await request(`/api/bugs/${encodeURIComponent(id)}`, { method: 'PATCH', body })).bug,
    deleteBug: async (id) => request(`/api/bugs/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} })
  };
})();
