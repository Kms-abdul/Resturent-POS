'use strict';

/**
 * Till client.
 *
 * Three things here are not obvious and are worth reading before changing:
 *
 * 1. Nothing is trusted to the client. Prices, totals and invoice numbers all
 *    come back from the server. The cart is a UI convenience; the server
 *    reprices every line on submit. If you find yourself computing a total here
 *    and sending it, stop -- that is a hole anyone with devtools can drive
 *    through.
 *
 * 2. The cart survives a refresh. Restaurant tills get bumped, tablets sleep,
 *    browsers reload. Losing a half-built order for a table of eight is the
 *    kind of small disaster that makes staff stop using the system.
 *
 * 3. Every string that came from a user is escaped before it touches innerHTML.
 *    Menu item names are typed by staff and rendered on every till; one
 *    unescaped name is a stored XSS on every device in the restaurant.
 */

// The login button starts disabled in the HTML and this is the first thing
// this file does: enable it. If this script fails to load or run at all (a
// browser setting forcing an HTTPS upgrade on this asset has done exactly
// that in practice), the button stays disabled, Enter-to-submit has no
// enabled control to trigger, and the form cannot fall back to a native
// submission that would put the PIN in the URL in plain text.
document.getElementById('loginBtn').disabled = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

const CURRENCY = '₹';
const fmt = (n) => CURRENCY + Number(n || 0).toFixed(2);

function toast(kind, title, body) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML =
    `<div class="t-title">${escapeHtml(title)}</div>` +
    (body ? `<div class="t-body">${escapeHtml(body)}</div>` : '');
  $('toastStack').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/**
 * Replaces window.confirm/prompt. Not cosmetic: native dialogs block the event
 * loop, so a queued health poll or an in-flight order response cannot land
 * while one is open, and on a touch till they are easy to dismiss by accident.
 */
function modal({ title, message, confirmLabel = 'Confirm', danger = false, input = null }) {
  return new Promise((resolve) => {
    const root = $('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(message)}</p>
          ${input ? `<div class="form-group"><input class="form-input" id="modalInput" inputmode="${escapeHtml(input.inputmode || 'text')}" placeholder="${escapeHtml(input.placeholder || '')}" maxlength="120"></div>` : ''}
          <div class="modal-actions">
            <button class="btn btn-secondary" id="modalCancel" type="button">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modalOk" type="button">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>`;

    const close = (value) => {
      root.innerHTML = '';
      resolve(value);
    };
    $('modalCancel').onclick = () => close(null);
    $('modalOk').onclick = () => close(input ? ($('modalInput').value || '').trim() : true);
    if (input) $('modalInput').focus();
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, payload) {
    super((payload && payload.error && payload.error.message) || 'Request failed');
    this.status = status;
    this.code = (payload && payload.error && payload.error.code) || 'UNKNOWN';
    this.details = (payload && payload.error && payload.error.details) || null;
  }
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Distinguish "the network is down" from "the server said no". They need
    // completely different responses from the cashier.
    setConnStatus('down');
    throw new ApiError(0, {
      error: { code: 'OFFLINE', message: 'Cannot reach the POS server. Check the wifi.' },
    });
  }

  setConnStatus('ok');

  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    if (res.status === 401 && state.user) {
      state.user = null;
      showLogin('Your session expired. Sign in again.');
    }
    throw new ApiError(res.status, payload);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const CART_KEY = 'pos.cart.v1';
const TERMINAL_KEY = 'pos.terminal.v1';

const state = {
  user: null,
  permissions: [],
  menu: [],
  cart: [],
  // null = showing the category list; a string = drilled into that category.
  activeCategory: null,
  // Auto-assigned by the server when the order starts; the cashier can
  // overwrite it. Persisted with the cart so a refresh or a sleeping tablet
  // mid-order keeps the same number -- handing the customer one number and the
  // kitchen another is the failure this prevents.
  orderNumber: '',
  // True once the cashier edits the field by hand. Tracked so the app never
  // silently overwrites a deliberate override, and so the badge can show which
  // of the two it is.
  orderNumberManual: false,
  reservingNumber: false,
  paymentMode: 'cash',
  clientRef: null,
  kotHistory: [],
  orders: [],
  submitting: false,
};

const PERMISSIONS = {
  cashier: ['orders:create', 'orders:read', 'menu:read', 'reports:read:own'],
  manager: [
    'orders:create', 'orders:read', 'orders:void', 'menu:read', 'menu:write',
    'reports:read', 'users:manage', 'data:export',
  ],
};

const can = (perm) => state.permissions.includes(perm);

/** A stable per-device id, so reports can tell which till took an order. */
function terminalId() {
  let id = localStorage.getItem(TERMINAL_KEY);
  if (!id) {
    id = `till-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(TERMINAL_KEY, id);
  }
  return id;
}

/**
 * A fresh idempotency key is minted per cart, not per submit. Every retry of
 * the same order carries the same key, so the server can recognise a duplicate;
 * a genuinely new order gets a new key.
 */
function newClientRef() {
  return `${terminalId()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function saveCart() {
  try {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify({
        cart: state.cart,
        orderNumber: state.orderNumber,
        orderNumberManual: state.orderNumberManual,
        paymentMode: state.paymentMode,
        clientRef: state.clientRef,
      })
    );
  } catch {
    /* storage full or disabled: the cart is a convenience, never the record */
  }
}

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.cart = Array.isArray(saved.cart) ? saved.cart : [];
    state.orderNumber = typeof saved.orderNumber === 'string' ? saved.orderNumber : '';
    state.orderNumberManual = Boolean(saved.orderNumberManual);
    state.paymentMode = saved.paymentMode || 'cash';
    state.clientRef = saved.clientRef || null;
  } catch {
    localStorage.removeItem(CART_KEY);
  }
}

function clearCart() {
  state.cart = [];
  state.orderNumber = '';
  state.orderNumberManual = false;
  state.clientRef = null;
  localStorage.removeItem(CART_KEY);
  $('orderNumber').value = '';
  renderOrderNumberUi();
  renderCart();
}

function renderOrderNumberUi() {
  const badge = $('orderNumberBadge');
  const reset = $('orderNumberReset');
  badge.textContent = state.orderNumberManual ? 'manual' : 'auto';
  badge.classList.toggle('manual', state.orderNumberManual);
  reset.classList.toggle('hidden', !state.orderNumberManual);

  // Flag a number already used today. Not blocked -- some counters legitimately
  // recycle token slips through a service -- but a silent duplicate means two
  // customers holding the same slip, which the kitchen cannot resolve. Warning
  // beats both blocking and staying quiet.
  const warn = $('orderNumberWarn');
  const current = ($('orderNumber').value || '').trim();
  const clash =
    current &&
    state.orders.some((o) => String(o.orderNumber) === current && o.status !== 'voided');
  warn.textContent = clash ? `#${current} is already used today — check the slip.` : '';
}

/**
 * Reserve the auto number for this order, once.
 *
 * Called when the first item goes into an empty cart, so the number is on
 * screen before the cashier needs to read it out. A failure here is not fatal:
 * the field stays empty, the cashier can type one, and the server allocates a
 * fallback at billing if they don't. Taking an order must never be blocked by
 * a number that the system can supply itself later.
 */
async function ensureOrderNumber() {
  if (state.orderNumber || state.orderNumberManual || state.reservingNumber) return;
  state.reservingNumber = true;
  try {
    const { orderNumber } = await api('/orders/number', { method: 'POST' });
    // Re-check: the cashier may have typed their own while the call was in
    // flight. Their input wins over a late-arriving auto number.
    if (!state.orderNumberManual) {
      state.orderNumber = orderNumber;
      $('orderNumber').value = orderNumber;
      saveCart();
      renderOrderNumberUi();
      renderCart();
    }
  } catch {
    /* leave the field empty; billing still works */
  } finally {
    state.reservingNumber = false;
  }
}

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

function setConnStatus(kind) {
  const el = $('connStatus');
  if (!el) return;
  el.className = `status-dot ${kind}`;
  el.textContent = kind === 'ok' ? 'Connected' : 'Server unreachable';
}

async function pollHealth() {
  try {
    const res = await fetch('/health/ready', { credentials: 'same-origin' });
    const h = await res.json();
    setConnStatus('ok');
    const el = $('storageStatus');
    if (h.degraded) {
      el.className = 'status-dot warn';
      el.textContent = 'Workbook locked — sales still saving';
      el.title = h.degradedReason || '';
    } else {
      el.className = 'status-dot ok';
      el.textContent = h.pendingEvents > 0 ? `Saving (${h.pendingEvents})` : 'Workbook current';
      el.title = h.lastFlushAt ? `Last saved ${new Date(h.lastFlushAt).toLocaleTimeString()}` : '';
    }
  } catch {
    setConnStatus('down');
    const el = $('storageStatus');
    el.className = 'status-dot down';
    el.textContent = 'Offline';
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function showLogin(message) {
  $('loginOverlay').classList.remove('hidden');
  $('posApp').classList.add('hidden');
  $('loginError').textContent = message || '';
  $('loginPin').value = '';
  $('loginName').focus();
}

function showApp() {
  $('loginOverlay').classList.add('hidden');
  $('posApp').classList.remove('hidden');
  $('userChip').innerHTML =
    `<strong>${escapeHtml(state.user.name)}</strong><br><span>${escapeHtml(state.user.role)}</span>`;

  // Hide what this role cannot use. The server enforces the same rules; this
  // just avoids showing a cashier buttons that would only ever return 403.
  document.querySelectorAll('[data-requires]').forEach((el) => {
    el.classList.toggle('hidden', !can(el.dataset.requires));
  });
}

async function bootstrapSession() {
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    state.permissions = PERMISSIONS[user.role] || [];
    showApp();
    await refreshMenu();
    renderCart();
    return true;
  } catch {
    showLogin();
    return false;
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: { name: $('loginName').value.trim(), pin: $('loginPin').value.trim() },
    });
    state.user = user;
    state.permissions = PERMISSIONS[user.role] || [];
    showApp();
    await refreshMenu();
    renderCart();
    toast('success', `Welcome, ${user.name}`);
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginPin').value = '';
  } finally {
    btn.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  if (state.cart.length > 0) {
    const ok = await modal({
      title: 'Sign out?',
      message: 'There is an unfinished order on this till. Signing out keeps it saved on this device.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
  }
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showLogin();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function switchTab(tab) {
  ['order', 'menu', 'kot', 'reports', 'staff', 'kitchen'].forEach((t) => {
    const el = $(`${t}Tab`);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.nav-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('navTabs').classList.remove('active');

  if (tab === 'reports') loadReports();
  if (tab === 'menu') renderMenuList();
  if (tab === 'staff') loadStaff();
  if (tab === 'kitchen') loadKitchen();
}

document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
$('mobileMenuBtn').addEventListener('click', () => $('navTabs').classList.toggle('active'));

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function refreshMenu() {
  $('categoryGrid').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  try {
    const { items } = await api('/menu');
    state.menu = items;

    // A category can disappear while a till is sitting inside it -- the last
    // item in it was removed on the manager's till, or renamed. Dropping back
    // to the category list is better than showing an empty pane with a heading
    // for something that no longer exists.
    if (state.activeCategory && !items.some((i) => i.category === state.activeCategory)) {
      state.activeCategory = null;
    }

    renderBrowse();
    renderMenuList();
    renderCategoryList();
  } catch (err) {
    $('categoryGrid').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderCategoryList() {
  const categories = Array.from(new Set(state.menu.map((i) => i.category))).sort();
  $('categoryList').innerHTML = categories
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join('');
}

/**
 * Order screen browsing: categories first, then items within a category.
 *
 * Three states, one function, because they share the same two panes and
 * splitting them into separate renderers is how the panes get out of sync:
 *
 *   search active  -> flat item list across every category
 *   no category    -> category tiles
 *   category set   -> items in that category
 *
 * Menus grow. A place with 120 items across 15 categories is unusable as one
 * flat grid, which is the case this replaces.
 */
function renderBrowse() {
  const q = ($('menuSearch').value || '').trim().toLowerCase();
  const catGrid = $('categoryGrid');
  const itemGrid = $('menuGrid');
  const back = $('categoryBack');
  const title = $('browseTitle');

  if (q) {
    const items = state.menu.filter(
      (i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
    );
    catGrid.classList.add('hidden');
    itemGrid.classList.remove('hidden');
    back.classList.add('hidden');
    title.textContent = `🔍 ${items.length} result${items.length === 1 ? '' : 's'}`;
    itemGrid.innerHTML = items.length
      ? items.map(itemTile).join('')
      : '<div class="empty-state">No items match that search.</div>';
    return;
  }

  if (state.activeCategory === null) {
    const counts = new Map();
    for (const item of state.menu) {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
    const categories = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));

    itemGrid.classList.add('hidden');
    catGrid.classList.remove('hidden');
    back.classList.add('hidden');
    title.textContent = '📋 Categories';
    catGrid.innerHTML = categories.length
      ? categories
          .map(
            (c) => `
        <div class="category-item" data-category="${escapeHtml(c)}" role="button" tabindex="0">
          <div class="category-name">${escapeHtml(c)}</div>
          <div class="category-count">${counts.get(c)} item${counts.get(c) === 1 ? '' : 's'}</div>
        </div>`
          )
          .join('')
      : '<div class="empty-state">No menu items yet. Add some on the Menu tab.</div>';
    return;
  }

  const items = state.menu.filter((i) => i.category === state.activeCategory);
  catGrid.classList.add('hidden');
  itemGrid.classList.remove('hidden');
  back.classList.remove('hidden');
  title.textContent = state.activeCategory;
  itemGrid.innerHTML = items.length
    ? items.map(itemTile).join('')
    : '<div class="empty-state">Nothing left in this category.</div>';
}

function itemTile(item) {
  return `
    <div class="menu-item" data-add="${item.id}" role="button" tabindex="0">
      <div class="menu-item-name">${escapeHtml(item.name)}</div>
      <div class="menu-item-category">${escapeHtml(item.category)}</div>
      <div class="menu-item-footer">
        <div class="menu-item-price">${fmt(item.price)}</div>
        <button class="menu-item-btn" data-add="${item.id}" type="button" aria-label="Add ${escapeHtml(item.name)}">+</button>
      </div>
    </div>`;
}

$('menuSearch').addEventListener('input', renderBrowse);

$('categoryBack').addEventListener('click', () => {
  state.activeCategory = null;
  renderBrowse();
});

function openCategory(el) {
  state.activeCategory = el.dataset.category;
  $('menuSearch').value = '';
  renderBrowse();
}

$('categoryGrid').addEventListener('click', (e) => {
  const target = e.target.closest('[data-category]');
  if (target) openCategory(target);
});
$('categoryGrid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest('[data-category]');
  if (target) {
    e.preventDefault();
    openCategory(target);
  }
});

// One delegated listener rather than inline onclick attributes. Inline handlers
// would need 'unsafe-inline' in the CSP, which is the setting that turns a
// stored XSS into a working one.
$('menuGrid').addEventListener('click', (e) => {
  const target = e.target.closest('[data-add]');
  if (target) addToCart(Number(target.dataset.add));
});
$('menuGrid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest('[data-add]');
  if (target) {
    e.preventDefault();
    addToCart(Number(target.dataset.add));
  }
});

function renderMenuList() {
  const editable = can('menu:write');
  if (state.menu.length === 0) {
    $('menuList').innerHTML = '<div class="empty-state">No items in menu</div>';
    return;
  }
  $('menuList').innerHTML = state.menu
    .map(
      (item) => `
      <div style="background:#1e293b;border:1px solid #475569;border-radius:0.375rem;padding:0.75rem;margin-bottom:0.5rem;display:flex;justify-content:space-between;align-items:center;">
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:0.25rem">${escapeHtml(item.name)}</div>
          <div style="font-size:0.75rem;color:#94a3b8">${escapeHtml(item.category)}</div>
        </div>
        <div style="text-align:right;margin-left:1rem">
          <div style="color:#fbbf24;font-weight:700;margin-bottom:0.25rem">${fmt(item.price)}</div>
          ${
            editable
              ? `<button class="btn btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.5rem" data-remove="${item.id}" type="button">Remove</button>`
              : ''
          }
        </div>
      </div>`
    )
    .join('');
}

$('menuList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const id = Number(btn.dataset.remove);
  const item = state.menu.find((i) => i.id === id);
  if (!item) return;

  const ok = await modal({
    title: `Remove ${item.name}?`,
    message:
      'It disappears from the ordering screen. Past orders that included it stay intact, so your reports stay correct.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/menu/${id}`, { method: 'DELETE' });
    toast('success', `${item.name} removed`);
    await refreshMenu();
  } catch (err) {
    toast('error', 'Could not remove item', err.message);
  }
});

$('menuForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('addItemBtn');
  $('menuFormError').textContent = '';
  btn.disabled = true;
  try {
    await api('/menu', {
      method: 'POST',
      body: {
        name: $('itemName').value.trim(),
        category: $('itemCategory').value.trim(),
        price: $('itemPrice').value,
      },
    });
    $('itemName').value = '';
    $('itemCategory').value = '';
    $('itemPrice').value = '';
    toast('success', 'Item added');
    await refreshMenu();
  } catch (err) {
    const detail = err.details && err.details[0] ? `${err.details[0].message}` : err.message;
    $('menuFormError').textContent = detail;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function addToCart(menuItemId) {
  const item = state.menu.find((i) => i.id === menuItemId);
  if (!item) return;

  const startingNewOrder = state.cart.length === 0;
  if (!state.clientRef) state.clientRef = newClientRef();

  const existing = state.cart.find((c) => c.menuItemId === menuItemId);
  if (existing) existing.quantity += 1;
  else
    state.cart.push({
      menuItemId: item.id,
      name: item.name,
      price: item.price,
      quantity: 1,
    });

  renderCart();

  // Fire-and-forget: the number appears a moment later without blocking the
  // cashier from continuing to add items.
  if (startingNewOrder) ensureOrderNumber();
}

function setQty(menuItemId, qty) {
  if (qty <= 0) state.cart = state.cart.filter((c) => c.menuItemId !== menuItemId);
  else {
    const line = state.cart.find((c) => c.menuItemId === menuItemId);
    if (line) line.quantity = Math.min(qty, 999);
  }
  renderCart();
}

/**
 * Displayed only. The authoritative total is whatever the server returns on
 * submit, computed from its own menu prices.
 */
function cartTotal() {
  return state.cart.reduce((sum, l) => sum + l.price * l.quantity, 0);
}

function renderCart() {
  const list = $('cartItems');
  const billing = $('billingDetails');
  const hasItems = state.cart.length > 0;
  const hasNumber = ($('orderNumber').value || '').trim().length > 0;

  $('kotBtn').disabled = !hasItems || !hasNumber;
  $('billBtn').disabled = !hasItems || !hasNumber || state.submitting;
  $('clearCartBtn').disabled = !hasItems;

  if (!hasItems) {
    list.innerHTML = '<div class="empty-state">Add items to order</div>';
    billing.classList.add('hidden');
    saveCart();
    return;
  }

  list.innerHTML = state.cart
    .map(
      (line) => `
      <div class="cart-item">
        <div class="cart-item-header">
          <span class="cart-item-name">${escapeHtml(line.name)}</span>
          <button class="cart-item-delete" data-del="${line.menuItemId}" type="button" aria-label="Remove">✕</button>
        </div>
        <div style="color:#cbd5e1;margin-bottom:0.5rem;font-size:0.75rem">
          ${fmt(line.price)} × ${line.quantity} = ${fmt(line.price * line.quantity)}
        </div>
        <div class="cart-item-qty">
          <button class="qty-btn" data-qty="${line.menuItemId}" data-to="${line.quantity - 1}" type="button">−</button>
          <span class="qty-display" style="flex:1;text-align:center;font-size:0.875rem;cursor:pointer;text-decoration:underline;" data-edit-qty="${line.menuItemId}" title="Click to enter custom quantity (e.g., 0.5)">${line.quantity}</span>
          <button class="qty-btn" data-qty="${line.menuItemId}" data-to="${line.quantity + 1}" type="button">+</button>
        </div>
      </div>`
    )
    .join('');

  $('total').textContent = fmt(cartTotal());
  billing.classList.remove('hidden');
  saveCart();
}

$('cartItems').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) return setQty(Number(del.dataset.del), 0);
  const qtyBtn = e.target.closest('[data-qty]');
  if (qtyBtn) return setQty(Number(qtyBtn.dataset.qty), Number(qtyBtn.dataset.to));
  const editQty = e.target.closest('[data-edit-qty]');
  if (editQty) {
    const id = Number(editQty.dataset.editQty);
    const line = state.cart.find((c) => c.menuItemId === id);
    if (!line) return;
    const val = await modal({
      title: 'Enter Quantity',
      message: 'Enter custom quantity (e.g. 0.5 for half plate, 2.5, etc.)',
      confirmLabel: 'Set',
      input: { placeholder: String(line.quantity), inputmode: 'decimal' },
    });
    if (val) {
      const num = Number.parseFloat(val);
      if (!Number.isNaN(num) && num > 0) setQty(id, num);
    }
  }
});

$('orderNumber').addEventListener('input', (e) => {
  state.orderNumber = e.target.value;
  state.orderNumberManual = true;
  saveCart();
  renderOrderNumberUi();
  renderCart();
});

$('orderNumberReset').addEventListener('click', async () => {
  state.orderNumberManual = false;
  state.orderNumber = '';
  $('orderNumber').value = '';
  renderOrderNumberUi();
  await ensureOrderNumber();
  renderCart();
});

$('paymentModes').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  state.paymentMode = btn.dataset.mode;
  document
    .querySelectorAll('#paymentModes .pay-btn')
    .forEach((b) => b.classList.toggle('selected', b === btn));
  saveCart();
});

$('clearCartBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'Clear this order?',
    message: 'Everything in the current order is removed. Nothing is billed.',
    confirmLabel: 'Clear',
    danger: true,
  });
  if (ok) clearCart();
});

// ---------------------------------------------------------------------------
// KOT
// ---------------------------------------------------------------------------

function printKOT(kotId) {
  switchTab('kot');
  document.querySelectorAll('.kot-preview').forEach((el) => {
    if (el.dataset.id !== String(kotId)) {
      el.classList.add('hidden-print');
    }
  });
  window.print();
  document.querySelectorAll('.kot-preview').forEach((el) => {
    el.classList.remove('hidden-print');
  });
}

$('kotBtn').addEventListener('click', () => {
  // Whatever is in the field is what goes on the ticket -- the auto number
  // normally, the cashier's override if they changed it. The button is disabled
  // while the field is empty, so there is no unnumbered-ticket path here.
  const newKOT = {
    id: `KOT-${Date.now()}`,
    orderNumber: ($('orderNumber').value || '').trim(),
    items: state.cart.map((l) => ({ name: l.name, quantity: l.quantity })),
    timestamp: new Date(),
    cashier: state.user.name,
  };
  state.kotHistory.unshift(newKOT);

  renderKOT();
  
  // Directly print the newly generated KOT
  printKOT(newKOT.id);
});

$('kotContent').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-print-kot]');
  if (btn) printKOT(btn.dataset.printKot);
});

function renderKOT() {
  if (state.kotHistory.length === 0) {
    $('kotContent').innerHTML = '<div class="empty-state">👁️ No KOT history. Generate one from the Order tab.</div>';
    $('kotButtons').classList.add('hidden');
    return;
  }

  $('kotContent').innerHTML = state.kotHistory
    .map(
      (k) => `
    <div class="kot-preview" data-id="${escapeHtml(k.id)}">
      <div class="kot-header">
        <div class="kot-title">KITCHEN ORDER TICKET</div>
        <div class="kot-divider">─────────────────────────</div>
      </div>
      <div class="kot-section" style="text-align:center">
        <div style="font-size:2rem;font-weight:800;line-height:1.1">
          ORDER #${escapeHtml(k.orderNumber)}
        </div>
      </div>
      <div class="kot-section">
        <div>Time: ${escapeHtml(k.timestamp.toLocaleTimeString())}</div>
        <div>Taken by: ${escapeHtml(k.cashier)}</div>
      </div>
      <div class="kot-section">
        <div><strong>ITEMS:</strong></div>
        ${k.items
          .map((i) => `<div class="kot-item">• ${escapeHtml(i.name)} x ${i.quantity}</div>`)
          .join('')}
      </div>
      <div class="kot-footer">
        <div>═════════════════════════</div>
        <div><strong>PLEASE PREPARE ORDER</strong></div>
        <div>═════════════════════════</div>
      </div>
      <div class="kot-actions no-print" style="margin-top: 1rem;">
        <button class="btn btn-secondary" style="margin: 0 auto;" data-print-kot="${escapeHtml(k.id)}" type="button">🖨️ Print Again</button>
      </div>
    </div>`
    )
    .join('');

  $('kotButtons').classList.remove('hidden');
}

$('printKotBtn').addEventListener('click', () => window.print());
$('clearKotBtn').addEventListener('click', () => {
  state.kotHistory = [];
  renderKOT();
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

$('billBtn').addEventListener('click', async () => {
  if (state.submitting) return;
  if (state.cart.length === 0) return;

  if (!state.clientRef) state.clientRef = newClientRef();

  state.submitting = true;
  const btn = $('billBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const { order, duplicate } = await api('/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.clientRef },
      body: {
        // Read from the field rather than state so an override typed a moment
        // before pressing Complete Billing cannot be missed.
        orderNumber: ($('orderNumber').value || '').trim() || undefined,
        paymentMode: state.paymentMode,
        terminal: terminalId(),
        items: state.cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
      },
    });

    if (duplicate) {
      toast('warn', 'Already billed', `Order #${order.orderNumber} was already recorded. Not charged twice.`);
    } else {
      toast(
        'success',
        `Order #${order.orderNumber} complete`,
        `${fmt(order.total)} — ${order.paymentMode} — ${order.id}`
      );
    }
    clearCart();
  } catch (err) {
    if (err.code === 'OFFLINE') {
      // The order stays in the cart deliberately. Clearing it here would mean a
      // cashier who lost wifi for two seconds loses the whole order, and the
      // idempotency key is preserved so a retry cannot double-bill.
      toast('error', 'Not saved', 'No connection to the server. The order is still here — try again.');
    } else {
      toast('error', 'Could not complete billing', err.message);
    }
  } finally {
    state.submitting = false;
    btn.textContent = originalLabel;
    renderCart();
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

async function loadReports() {
  const date = $('reportDate').value || new Date().toISOString().slice(0, 10);
  $('reportDate').value = date;

  try {
    const [{ summary }, { orders }] = await Promise.all([
      api(`/reports/daily?date=${encodeURIComponent(date)}`),
      api(`/orders?date=${encodeURIComponent(date)}`),
    ]);
    state.orders = orders;
    renderStats(summary);
    renderOrders(orders);
  } catch (err) {
    toast('error', 'Could not load reports', err.message);
  }
}

function renderStats(s) {
  const paymentLines = Object.entries(s.byPaymentMode || {})
    .map(([mode, v]) => `${mode}: ${fmt(v.total)}`)
    .join(' · ');

  const cards = [
    { label: 'Orders', value: s.orderCount, icon: '📋', color: '' },
    { label: 'Revenue', value: fmt(s.revenue), icon: '💰', color: 'green' },
    { label: 'Average order', value: fmt(s.averageOrderValue), icon: '📈', color: 'purple' },
    {
      label: s.voidedCount ? 'Voided orders' : paymentLines || 'Payments',
      value: s.voidedCount ? s.voidedCount : '—',
      icon: s.voidedCount ? '⚠️' : '💳',
      color: 'amber',
    },
  ];

  $('statsCards').innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.color}">
        <div class="stat-icon">${c.icon}</div>
        <div class="stat-value">${escapeHtml(c.value)}</div>
        <div class="stat-label">${escapeHtml(c.label)}</div>
      </div>`
    )
    .join('');
}

function renderOrders(orders) {
  if (orders.length === 0) {
    $('ordersBody').innerHTML = '<tr><td colspan="8" class="empty-state">No orders on this date</td></tr>';
    return;
  }
  $('ordersBody').innerHTML = orders
    .map(
      (o) => `
      <tr class="${o.status === 'voided' ? 'row-voided' : ''}">
        <td><strong>#${escapeHtml(o.orderNumber ?? '—')}</strong></td>
        <td style="font-size:0.75rem;color:#94a3b8">${escapeHtml(o.id)}</td>
        <td>${escapeHtml(new Date(o.createdAt).toLocaleTimeString())}</td>
        <td>${escapeHtml(o.paymentMode || '—')}</td>
        <td>${escapeHtml(o.createdBy || '—')}</td>
        <td>${o.itemCount}</td>
        <td style="text-align:right;color:#86efac;font-weight:700">${fmt(o.total)}</td>
        <td style="text-align:right">${
          can('orders:void') && o.status !== 'voided'
            ? `<button class="btn btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.5rem" data-void="${escapeHtml(o.id)}" type="button">Void</button>`
            : ''
        }</td>
      </tr>`
    )
    .join('');
}

$('ordersBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-void]');
  if (!btn) return;
  const id = btn.dataset.void;

  const reason = await modal({
    title: `Void ${id}?`,
    message:
      'The order stays in the records with a void stamp and is excluded from revenue. It is never deleted.',
    confirmLabel: 'Void order',
    danger: true,
    input: { placeholder: 'Reason (e.g. wrong table, customer cancelled)' },
  });
  if (!reason) return;

  try {
    await api(`/orders/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } });
    toast('success', `${id} voided`);
    await loadReports();
  } catch (err) {
    toast('error', 'Could not void order', err.message);
  }
});

$('refreshReportBtn').addEventListener('click', loadReports);
$('reportDate').addEventListener('change', loadReports);

$('exportBtn').addEventListener('click', () => {
  const date = $('reportDate').value || new Date().toISOString().slice(0, 10);
  window.location.href = `/api/reports/daily.xlsx?date=${encodeURIComponent(date)}`;
});

$('flushBtn').addEventListener('click', async () => {
  try {
    const res = await api('/reports/flush', { method: 'POST' });
    if (res.ok) toast('success', 'Workbook saved', 'pos-data.xlsx is up to date.');
    else toast('warn', 'Workbook is locked', res.health.degradedReason || 'Close it in Excel and try again.');
    pollHealth();
  } catch (err) {
    toast('error', 'Could not save workbook', err.message);
  }
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

async function loadStaff() {
  if (!can('users:manage')) return;
  try {
    const { users } = await api('/users');
    $('staffList').innerHTML = users
      .map(
        (u) => `
        <div style="background:#1e293b;border:1px solid #475569;border-radius:0.375rem;padding:0.75rem;margin-bottom:0.5rem;display:flex;justify-content:space-between;align-items:center;${u.isActive ? '' : 'opacity:0.5'}">
          <div>
            <div style="font-weight:600">${escapeHtml(u.name)}</div>
            <div style="font-size:0.75rem;color:#94a3b8;text-transform:capitalize">${escapeHtml(u.role)}${u.isActive ? '' : ' — removed'}</div>
          </div>
          ${
            u.isActive && String(u.id) !== String(state.user.id)
              ? `<button class="btn btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.5rem" data-staff-remove="${u.id}" type="button">Remove</button>`
              : ''
          }
        </div>`
      )
      .join('');
  } catch (err) {
    $('staffList').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

$('staffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('staffFormError').textContent = '';
  try {
    await api('/users', {
      method: 'POST',
      body: {
        name: $('staffName').value.trim(),
        role: $('staffRole').value,
        pin: $('staffPin').value.trim(),
      },
    });
    $('staffName').value = '';
    $('staffPin').value = '';
    toast('success', 'Staff member added');
    loadStaff();
  } catch (err) {
    $('staffFormError').textContent =
      err.details && err.details[0] ? err.details[0].message : err.message;
  }
});

$('staffList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-staff-remove]');
  if (!btn) return;
  const ok = await modal({
    title: 'Remove staff member?',
    message: 'They can no longer sign in. Orders they took stay in the records.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/users/${btn.dataset.staffRemove}`, { method: 'DELETE' });
    toast('success', 'Staff member removed');
    loadStaff();
  } catch (err) {
    toast('error', 'Could not remove', err.message);
  }
});

$('pinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pinFormError').textContent = '';
  try {
    await api(`/users/${state.user.id}/pin`, {
      method: 'POST',
      body: { currentPin: $('currentPin').value.trim(), newPin: $('newPin').value.trim() },
    });
    $('currentPin').value = '';
    $('newPin').value = '';
    toast('success', 'PIN updated');
  } catch (err) {
    $('pinFormError').textContent =
      err.details && err.details[0] ? err.details[0].message : err.message;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadKitchen() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const { orders } = await api(`/orders?date=${encodeURIComponent(date)}`);
    const pendingOrders = orders.filter(o => o.status !== 'voided' && o.fulfillmentStatus === 'pending');
    
    // Chef View: Aggregate items across all pending orders
    const aggregatedItems = {};
    pendingOrders.forEach(o => {
      o.items.forEach(i => {
        if (!aggregatedItems[i.name]) aggregatedItems[i.name] = 0;
        aggregatedItems[i.name] += i.quantity;
      });
    });
    
    const chefHtml = Object.entries(aggregatedItems).map(([name, qty]) => `
      <div style="display:flex; justify-content:space-between; padding: 0.75rem; border-bottom: 1px solid #475569; align-items:center;">
        <span style="font-weight:600; font-size:1.1rem;">${escapeHtml(name)}</span>
        <span style="font-weight:700; color:#fbbf24; font-size:1.4rem;">${qty}</span>
      </div>
    `).join('');
    
    $('chefViewContent').innerHTML = chefHtml || '<div class="empty-state">No items to cook right now.</div>';
    
    // Packer View: Individual orders
    const packerHtml = pendingOrders.map(o => `
      <div style="margin-bottom: 1rem; border: 1px solid #475569; border-radius: 0.5rem; padding: 1rem; background:#1e293b;">
        <div style="display:flex; justify-content:space-between; margin-bottom:1rem; border-bottom: 1px solid #334155; padding-bottom:0.5rem;">
          <strong style="color:#fbbf24; font-size:1.2rem;">ORDER #${escapeHtml(o.orderNumber)}</strong>
          <span style="font-size:0.875rem; color:#94a3b8;">${new Date(o.createdAt).toLocaleTimeString()}</span>
        </div>
        <div style="margin-bottom:1rem;">
          ${o.items.map(i => `
            <div style="display:flex; justify-content:space-between; padding: 0.25rem 0; font-size: 1.1rem;">
              <span>• ${escapeHtml(i.name)}</span>
              <span style="font-weight:bold;">${i.quantity}</span>
            </div>
          `).join('')}
        </div>
        <button class="btn btn-success" style="width:100%" data-fulfill-order="${escapeHtml(o.id)}" type="button">✔️ Mark Packed</button>
      </div>
    `).join('');
    
    $('packerViewContent').innerHTML = packerHtml || '<div class="empty-state">No pending orders.</div>';
    
  } catch (err) {
    toast('error', 'Could not load kitchen data', err.message);
  }
}

if ($('refreshKitchenBtn')) {
  $('refreshKitchenBtn').addEventListener('click', loadKitchen);
}
if ($('packerViewContent')) {
  $('packerViewContent').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-fulfill-order]');
    if (!btn) return;
    const orderId = btn.dataset.fulfillOrder;
    try {
      await api(`/orders/${encodeURIComponent(orderId)}/fulfill`, { method: 'POST' });
      toast('success', `Order marked as packed.`);
      loadKitchen();
    } catch (err) {
      toast('error', 'Could not update order', err.message);
    }
  });
}

(async function boot() {
  loadCart();
  $('orderNumber').value = state.orderNumber;
  renderOrderNumberUi();
  document.querySelectorAll('#paymentModes .pay-btn').forEach((b) => {
    b.classList.toggle('selected', b.dataset.mode === state.paymentMode);
  });
  $('reportDate').value = new Date().toISOString().slice(0, 10);

  await bootstrapSession();
  pollHealth();
  setInterval(pollHealth, 15000);

  // Refresh the menu periodically so a price change made on the manager's till
  // reaches the other tills without anyone reloading. Cheap, and it prevents the
  // confusing case where two tills quote different prices for the same dish.
  setInterval(() => {
    if (state.user) refreshMenu().catch(() => {});
  }, 120000);
})();
