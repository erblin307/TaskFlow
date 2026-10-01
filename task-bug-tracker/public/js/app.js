(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const dateFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' });
  const shortDate = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short' });
  const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };
  const labels = {
    priority: { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
    taskStatus: { todo: 'To do', 'in-progress': 'In progress', done: 'Done' },
    bugStatus: { open: 'Open', 'in-progress': 'In progress', testing: 'Testing', resolved: 'Resolved', closed: 'Closed' }
  };

  const state = {
    user: null,
    users: [],
    tasks: [],
    bugs: [],
    view: 'dashboard',
    taskFilter: 'all', taskSearch: '', taskSort: 'newest',
    bugStatus: 'all', bugPriority: 'all', bugSearch: '', bugSort: 'newest',
    screenshot: '', screenshotChanged: false,
    pendingDelete: null
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function user(id) { return state.users.find((item) => item.id === id) || { id, name: 'Unknown', role: '', color: 'blue' }; }
  function formatDate(value, short = false) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : (short ? shortDate : dateFormat).format(date); }
  function setText(id, value) { $(`#${id}`).textContent = value; }
  function canManage(item) { return item.createdBy === state.user.id; }

  function avatar(person, small = false) {
    const node = el('span', `mini-avatar ${person.color === 'blue' ? '' : person.color}`, person.name.slice(0, 1).toUpperCase());
    if (small) node.classList.add('small');
    return node;
  }

  function badge(type, value, text) { return el('span', `badge ${type}-${value}`, text); }

  function toast(message, type = 'success') {
    const item = el('div', `toast ${type === 'error' ? 'error' : ''}`);
    const copy = el('span', '', message);
    const close = el('button', '', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Dismiss');
    item.append(copy, close); $('#toast-stack').append(item);
    const remove = () => item.remove();
    close.addEventListener('click', remove); setTimeout(remove, 4000);
  }

  function formError(id, message) {
    const box = $(`#${id}`); box.textContent = message || ''; box.classList.toggle('visible', Boolean(message));
  }

  function setBusy(button, busy, busyText) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy; button.textContent = busy ? busyText : button.dataset.label;
  }

  function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
  function closeDialog(dialog) { if (dialog?.open) dialog.close(); }

  function showAuth() {
    state.user = null;
    $('#app').classList.add('hidden'); $('#auth-screen').classList.remove('hidden');
    $('#login-form').reset(); formError('login-error', '');
    setTimeout(() => $('#login-username').focus(), 40);
  }

  function applyIdentity() {
    setText('sidebar-name', state.user.name); setText('sidebar-role', state.user.role);
    setText('welcome-name', state.user.name); setText('sidebar-avatar', state.user.name[0]); setText('topbar-avatar', state.user.name[0]);
    [$('#sidebar-avatar'), $('#topbar-avatar')].forEach((node) => { node.classList.remove('violet', 'amber'); if (state.user.color !== 'blue') node.classList.add(state.user.color); });
  }

  async function showApp(currentUser) {
    state.user = currentUser;
    $('#auth-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
    applyIdentity(); switchView('dashboard');
    await reloadData();
  }

  async function reloadData() {
    try {
      const [users, tasks, bugs] = await Promise.all([TaskflowAPI.users(), TaskflowAPI.tasks(), TaskflowAPI.bugs()]);
      state.users = users; state.tasks = tasks; state.bugs = bugs;
      fillAssignees(); renderAll();
    } catch (error) { toast(error.message, 'error'); }
  }

  function fillAssignees() {
    ['task-assignee', 'bug-assignee'].forEach((id) => {
      const select = $(`#${id}`); const previous = select.value; select.replaceChildren();
      state.users.forEach((person) => { const option = el('option', '', person.name); option.value = person.id; select.append(option); });
      select.value = previous && state.users.some((person) => person.id === previous) ? previous : 'erblin';
    });
  }

  function switchView(view) {
    state.view = view;
    const names = { dashboard: 'Overview', tasks: 'Tasks', bugs: 'Bug reports' };
    $$('.view').forEach((node) => node.classList.toggle('active', node.id === `${view}-view`));
    $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
    setText('page-title', names[view]); setText('breadcrumb-current', names[view]);
    document.title = `${names[view]} · TaskFlow`; closeSidebar();
  }

  function taskStats() {
    return {
      total: state.tasks.length,
      open: state.tasks.filter((task) => task.status !== 'done').length,
      progress: state.tasks.filter((task) => task.status === 'in-progress').length,
      done: state.tasks.filter((task) => task.status === 'done').length
    };
  }

  function renderMetrics() {
    const tasks = taskStats();
    const openBugs = state.bugs.filter((bug) => !['resolved', 'closed'].includes(bug.status)).length;
    const completion = tasks.total ? Math.round(tasks.done / tasks.total * 100) : 0;
    setText('metric-open-tasks', tasks.open); setText('metric-progress', tasks.progress); setText('metric-open-bugs', openBugs); setText('metric-completion', `${completion}%`);
    setText('metric-task-caption', tasks.open ? `${tasks.done} completed` : 'Nothing pending');
    setText('nav-task-count', tasks.open); setText('nav-bug-count', openBugs);
    const assigned = state.tasks.filter((task) => task.assignedTo === state.user.id && task.status !== 'done').length + state.bugs.filter((bug) => bug.assignedTo === state.user.id && !['resolved', 'closed'].includes(bug.status)).length;
    setText('sidebar-assigned-count', assigned);
    $('#sidebar-progress').style.width = `${Math.min(100, completion)}%`;
    $('#progress-orbit').style.setProperty('--progress', `${completion}%`);
  }

  function emptyState(title, copy, iconName = 'task') {
    const wrap = el('div', 'empty'); const box = el('div'); const mark = el('span', 'empty-icon'); mark.append(icon(iconName));
    box.append(mark, el('h3', '', title), el('p', '', copy)); wrap.append(box); return wrap;
  }

  function renderDashboard() {
    renderMetrics();
    const queue = $('#work-queue'); queue.replaceChildren();
    const work = [
      ...state.tasks.filter((item) => item.assignedTo === state.user.id && item.status !== 'done').map((item) => ({ ...item, type: 'task' })),
      ...state.bugs.filter((item) => item.assignedTo === state.user.id && !['resolved', 'closed'].includes(item.status)).map((item) => ({ ...item, type: 'bug' }))
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 7);
    if (!work.length) queue.append(emptyState('Queue is clear', 'No active work is assigned to you.'));
    work.forEach((item) => {
      const row = el('div', 'queue-item'); const type = el('span', `queue-type ${item.type === 'bug' ? 'bug' : ''}`); type.append(icon(item.type === 'bug' ? 'bug' : 'task'));
      const copy = el('div', 'queue-copy'); copy.append(el('strong', '', item.title), el('span', '', item.type === 'bug' ? `${item.id} · from ${user(item.createdBy).name}` : `Task · from ${user(item.createdBy).name}`));
      const status = badge('status', item.status, item.type === 'bug' ? labels.bugStatus[item.status] : labels.taskStatus[item.status]);
      const date = el('span', 'queue-date', formatDate(item.updatedAt, true));
      row.append(type, copy, status, date); row.tabIndex = 0; row.setAttribute('role', 'button');
      row.addEventListener('click', () => showDetails(item.type, item.id)); row.addEventListener('keydown', (event) => { if (event.key === 'Enter') row.click(); }); queue.append(row);
    });

    const recent = $('#recent-bugs'); recent.replaceChildren();
    const bugs = [...state.bugs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    if (!bugs.length) recent.append(emptyState('No reports yet', 'New issues will appear here.', 'bug'));
    bugs.forEach((bug) => {
      const row = el('div', 'activity-item'); const line = el('span', 'activity-line'); const copy = el('div');
      copy.append(el('strong', '', bug.title), el('span', '', `${bug.id} · ${user(bug.createdBy).name} · ${formatDate(bug.createdAt, true)}`));
      row.append(line, copy); row.tabIndex = 0; row.addEventListener('click', () => showDetails('bug', bug.id)); recent.append(row);
    });
  }

  function filteredTasks() {
    const term = state.taskSearch.toLowerCase().trim();
    return state.tasks.filter((item) => (!term || `${item.title} ${item.description}`.toLowerCase().includes(term)) && (state.taskFilter === 'all' || item.status === state.taskFilter)).sort(sorter(state.taskSort));
  }

  function filteredBugs() {
    const term = state.bugSearch.toLowerCase().trim();
    return state.bugs.filter((item) => (!term || `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(term)) && (state.bugStatus === 'all' || item.status === state.bugStatus) && (state.bugPriority === 'all' || item.priority === state.bugPriority)).sort(sorter(state.bugSort));
  }

  function sorter(mode) {
    if (mode === 'oldest') return (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
    if (mode === 'priority') return (a, b) => priorityRank[b.priority] - priorityRank[a.priority] || new Date(b.createdAt) - new Date(a.createdAt);
    return (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  }

  function personCell(person) { const cell = el('div', 'record-person'); cell.append(avatar(person), el('span', '', person.name)); return cell; }

  function statusSelect(item, type) {
    const map = type === 'task' ? labels.taskStatus : labels.bugStatus;
    const select = el('select', 'status-control'); select.setAttribute('aria-label', `Change status for ${item.title}`);
    Object.entries(map).forEach(([value, text]) => { const option = el('option', '', text); option.value = value; option.selected = item.status === value; select.append(option); });
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        const updated = type === 'task' ? await TaskflowAPI.updateTask(item.id, { status: select.value }) : await TaskflowAPI.updateBug(item.id, { status: select.value });
        replaceRecord(type, updated); renderAll(); toast('Status updated');
      } catch (error) { select.value = item.status; toast(error.message, 'error'); }
      finally { select.disabled = false; }
    });
    return select;
  }

  function actionButton(text, action, className = '') { const button = el('button', `row-action ${className}`, text); button.type = 'button'; button.dataset.action = action; return button; }

  function taskRow(task) {
    const row = el('div', 'data-row task-columns'); row.dataset.id = task.id;
    const main = el('div', 'record-main'); main.append(el('strong', '', task.title), el('span', '', task.description));
    const actions = el('div', 'row-actions'); actions.append(actionButton('View', 'view'));
    if (canManage(task)) actions.append(actionButton('Edit', 'edit'), actionButton('Delete', 'delete', 'danger'));
    row.append(main, personCell(user(task.assignedTo)), el('span', 'record-date', task.deadline ? formatDate(`${task.deadline}T12:00:00`) : 'No deadline'), statusSelect(task, 'task'), actions);
    return row;
  }

  function bugRow(bug) {
    const row = el('div', 'data-row bug-columns'); row.dataset.id = bug.id;
    const main = el('div', 'record-main'); main.append(el('strong', '', bug.title), el('span', '', `${bug.id} · ${bug.description}`));
    const actions = el('div', 'row-actions'); actions.append(actionButton('View', 'view'));
    if (canManage(bug)) actions.append(actionButton('Edit', 'edit'), actionButton('Delete', 'delete', 'danger'));
    row.append(main, personCell(user(bug.createdBy)), badge('priority', bug.priority, labels.priority[bug.priority]), statusSelect(bug, 'bug'), actions);
    return row;
  }

  function renderTasks() {
    const list = $('#task-list'); list.replaceChildren(); const tasks = filteredTasks();
    if (!tasks.length) list.append(emptyState('No tasks found', state.tasks.length ? 'Try changing the search or filter.' : 'Create a task to start planning the work.'));
    else tasks.forEach((task) => list.append(taskRow(task)));
  }

  function renderBugs() {
    const list = $('#bug-list'); list.replaceChildren(); const bugs = filteredBugs();
    if (!bugs.length) list.append(emptyState('No bug reports found', state.bugs.length ? 'Try changing the search or filters.' : 'Reported issues will appear here.', 'bug'));
    else bugs.forEach((bug) => list.append(bugRow(bug)));
  }

  function renderAll() { renderDashboard(); renderTasks(); renderBugs(); }
  function replaceRecord(type, updated) { const collection = type === 'task' ? state.tasks : state.bugs; const index = collection.findIndex((item) => item.id === updated.id); if (index >= 0) collection[index] = updated; else collection.unshift(updated); }

  function openTaskForm(id = '') {
    const item = id ? state.tasks.find((task) => task.id === id) : null;
    if (item && !canManage(item)) return;
    $('#task-form').reset(); formError('task-error', ''); setText('task-dialog-title', item ? 'Edit task' : 'Create a task'); setText('task-save', item ? 'Save changes' : 'Create task');
    $('#task-id').value = item?.id || ''; $('#task-title').value = item?.title || ''; $('#task-description').value = item?.description || ''; $('#task-priority').value = item?.priority || 'medium'; $('#task-status').value = item?.status || 'todo'; $('#task-assignee').value = item?.assignedTo || 'erblin'; $('#task-deadline').value = item?.deadline || '';
    openDialog($('#task-dialog')); setTimeout(() => $('#task-title').focus(), 40);
  }

  function openBugForm(id = '') {
    const item = id ? state.bugs.find((bug) => bug.id === id) : null;
    if (item && !canManage(item)) return;
    $('#bug-form').reset(); formError('bug-error', ''); setText('bug-dialog-title', item ? `Edit ${item.id}` : 'Report an issue'); setText('bug-save', item ? 'Save changes' : 'Report bug');
    $('#bug-id').value = item?.id || ''; $('#bug-title').value = item?.title || ''; $('#bug-description').value = item?.description || ''; $('#bug-url').value = item?.url || ''; $('#bug-priority').value = item?.priority || 'medium'; $('#bug-status').value = item?.status || 'open'; $('#bug-assignee').value = item?.assignedTo || 'erblin';
    state.screenshot = item?.hasScreenshot ? `/api/bugs/${encodeURIComponent(item.id)}/screenshot` : ''; state.screenshotChanged = false; renderImagePreview(); openDialog($('#bug-dialog')); setTimeout(() => $('#bug-title').focus(), 40);
  }

  async function saveTask(event) {
    event.preventDefault(); const button = $('#task-save'); formError('task-error', '');
    const body = { title: $('#task-title').value, description: $('#task-description').value, priority: $('#task-priority').value, status: $('#task-status').value, assignedTo: $('#task-assignee').value, deadline: $('#task-deadline').value };
    if (!body.title.trim() || !body.description.trim()) { formError('task-error', 'Title and description are required.'); return; }
    setBusy(button, true, 'Saving…');
    try { const id = $('#task-id').value; const saved = id ? await TaskflowAPI.updateTask(id, body) : await TaskflowAPI.createTask(body); replaceRecord('task', saved); closeDialog($('#task-dialog')); renderAll(); toast(id ? 'Task updated' : 'Task created'); }
    catch (error) { formError('task-error', error.message); }
    finally { setBusy(button, false); }
  }

  async function saveBug(event) {
    event.preventDefault(); const button = $('#bug-save'); formError('bug-error', '');
    const body = { title: $('#bug-title').value, description: $('#bug-description').value, url: $('#bug-url').value, priority: $('#bug-priority').value, status: $('#bug-status').value, assignedTo: $('#bug-assignee').value };
    if (state.screenshotChanged) body.screenshot = state.screenshot;
    if (!body.title.trim() || !body.description.trim()) { formError('bug-error', 'Title and description are required.'); return; }
    setBusy(button, true, 'Saving…');
    try { const id = $('#bug-id').value; const saved = id ? await TaskflowAPI.updateBug(id, body) : await TaskflowAPI.createBug({ ...body, screenshot: state.screenshot }); replaceRecord('bug', saved); closeDialog($('#bug-dialog')); renderAll(); toast(id ? 'Bug report updated' : 'Bug reported'); }
    catch (error) { formError('bug-error', error.message); }
    finally { setBusy(button, false); }
  }

  function handleImage(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { formError('bug-error', 'Choose a PNG, JPG or WEBP image.'); return; }
    if (file.size > 5 * 1024 * 1024) { formError('bug-error', 'Screenshot must be 5MB or smaller.'); return; }
    const reader = new FileReader(); reader.onload = () => { state.screenshot = reader.result; state.screenshotChanged = true; renderImagePreview(); formError('bug-error', ''); }; reader.onerror = () => formError('bug-error', 'The image could not be read.'); reader.readAsDataURL(file);
  }

  function renderImagePreview() {
    const wrap = $('#image-preview'); wrap.replaceChildren(); wrap.classList.toggle('visible', Boolean(state.screenshot));
    if (!state.screenshot) return;
    const image = el('img'); image.src = state.screenshot; image.alt = 'Screenshot preview';
    const remove = el('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove screenshot'); remove.addEventListener('click', () => { state.screenshot = ''; state.screenshotChanged = true; $('#bug-screenshot').value = ''; renderImagePreview(); }); wrap.append(image, remove);
  }

  function detailCell(label, value, link = false) {
    const cell = el('div', 'detail-cell'); cell.append(el('span', '', label));
    if (link && value) { const anchor = el('a', '', value); anchor.href = value; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; cell.append(anchor); } else cell.append(el('strong', '', value || '—'));
    return cell;
  }

  function showDetails(type, id) {
    const item = (type === 'task' ? state.tasks : state.bugs).find((record) => record.id === id); if (!item) return;
    setText('detail-eyebrow', type === 'task' ? 'Task details' : item.id); setText('detail-title', item.title);
    const content = $('#detail-content'); content.replaceChildren(); const badges = el('div', 'detail-badges'); badges.append(badge('priority', item.priority, labels.priority[item.priority]), badge('status', item.status, type === 'task' ? labels.taskStatus[item.status] : labels.bugStatus[item.status]));
    const grid = el('div', 'detail-grid'); grid.append(detailCell(type === 'task' ? 'Created by' : 'Reported by', user(item.createdBy).name), detailCell('Assigned to', user(item.assignedTo).name), detailCell('Created', formatDate(item.createdAt)), type === 'task' ? detailCell('Deadline', item.deadline ? formatDate(`${item.deadline}T12:00:00`) : 'No deadline') : detailCell('Page URL', item.url, Boolean(item.url)));
    content.append(badges, el('p', 'detail-description', item.description), grid);
    if (type === 'bug' && item.hasScreenshot) { const image = el('img', 'detail-image'); image.src = `/api/bugs/${encodeURIComponent(item.id)}/screenshot`; image.alt = `Screenshot for ${item.id}`; image.addEventListener('click', () => { $('#lightbox-image').src = image.src; openDialog($('#lightbox')); }); content.append(image); }
    openDialog($('#detail-dialog'));
  }

  function requestDelete(type, id) {
    const item = (type === 'task' ? state.tasks : state.bugs).find((record) => record.id === id); if (!item || !canManage(item)) return;
    state.pendingDelete = { type, id }; setText('confirm-copy', `“${item.title}” will be permanently removed.`); openDialog($('#confirm-dialog'));
  }

  async function confirmDelete() {
    if (!state.pendingDelete) return; const button = $('#confirm-delete'); const { type, id } = state.pendingDelete; setBusy(button, true, 'Deleting…');
    try { if (type === 'task') await TaskflowAPI.deleteTask(id); else await TaskflowAPI.deleteBug(id); const collection = type === 'task' ? state.tasks : state.bugs; collection.splice(collection.findIndex((item) => item.id === id), 1); closeDialog($('#confirm-dialog')); state.pendingDelete = null; renderAll(); toast(type === 'task' ? 'Task deleted' : 'Bug report deleted'); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(button, false); }
  }

  function handleListAction(event, type) {
    const action = event.target.closest('[data-action]'); if (!action) return;
    const row = action.closest('[data-id]'); const id = row?.dataset.id; if (!id) return;
    if (action.dataset.action === 'view') showDetails(type, id); else if (action.dataset.action === 'edit') type === 'task' ? openTaskForm(id) : openBugForm(id); else if (action.dataset.action === 'delete') requestDelete(type, id);
  }

  function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebar-shade').classList.add('visible'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-shade').classList.remove('visible'); }

  function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('#theme-icon').setAttribute('href', theme === 'light' ? '#icon-moon' : '#icon-sun'); }
  function toggleTheme() { const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; localStorage.setItem('taskflow_theme', theme); applyTheme(theme); }

  function bindEvents() {
    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const button = $('#login-submit'); formError('login-error', ''); setBusy(button, true, 'Signing in…');
      try { const current = await TaskflowAPI.login($('#login-username').value.trim(), $('#login-password').value); await showApp(current); }
      catch (error) { formError('login-error', error.message); }
      finally { setBusy(button, false); }
    });
    $('#toggle-password').addEventListener('click', () => { const input = $('#login-password'); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; $('#toggle-password').textContent = show ? 'Hide' : 'Show'; });
    $('#logout-button').addEventListener('click', async () => { try { await TaskflowAPI.logout(); } catch (_) {} showAuth(); });
    window.addEventListener('taskflow:unauthorized', showAuth);
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
    $$('[data-view-link]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewLink)));
    $$('[data-new-task]').forEach((button) => button.addEventListener('click', () => openTaskForm()));
    $$('[data-new-bug]').forEach((button) => button.addEventListener('click', () => openBugForm()));
    $('#menu-button').addEventListener('click', openSidebar); $('#sidebar-close').addEventListener('click', closeSidebar); $('#sidebar-shade').addEventListener('click', closeSidebar);
    $('#theme-button').addEventListener('click', toggleTheme);
    $('#task-form').addEventListener('submit', saveTask); $('#bug-form').addEventListener('submit', saveBug); $('#confirm-delete').addEventListener('click', confirmDelete);
    $$('.dialog-close').forEach((button) => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
    $('#task-list').addEventListener('click', (event) => handleListAction(event, 'task')); $('#bug-list').addEventListener('click', (event) => handleListAction(event, 'bug'));
    $('#task-search').addEventListener('input', (event) => { state.taskSearch = event.target.value; renderTasks(); }); $('#task-sort').addEventListener('change', (event) => { state.taskSort = event.target.value; renderTasks(); });
    $('#task-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-value]'); if (!button) return; state.taskFilter = button.dataset.value; $$('#task-filters button').forEach((node) => node.classList.toggle('active', node === button)); renderTasks(); });
    $('#bug-search').addEventListener('input', (event) => { state.bugSearch = event.target.value; renderBugs(); }); $('#bug-status-filter').addEventListener('change', (event) => { state.bugStatus = event.target.value; renderBugs(); }); $('#bug-priority-filter').addEventListener('change', (event) => { state.bugPriority = event.target.value; renderBugs(); }); $('#bug-sort').addEventListener('change', (event) => { state.bugSort = event.target.value; renderBugs(); });
    $('#bug-screenshot').addEventListener('change', (event) => handleImage(event.target.files[0])); const upload = $('.upload'); ['dragenter', 'dragover'].forEach((name) => upload.addEventListener(name, (event) => { event.preventDefault(); upload.classList.add('dragging'); })); ['dragleave', 'drop'].forEach((name) => upload.addEventListener(name, (event) => { event.preventDefault(); upload.classList.remove('dragging'); })); upload.addEventListener('drop', (event) => handleImage(event.dataTransfer.files[0]));
  }

  async function init() {
    applyTheme(localStorage.getItem('taskflow_theme') || 'dark');
    $('#today-label').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date());
    bindEvents();
    try { await showApp(await TaskflowAPI.session()); } catch (_) { showAuth(); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
