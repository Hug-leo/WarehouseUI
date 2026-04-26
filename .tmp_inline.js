
// Dynamic origin â€” works on localhost, LAN, or over the internet (tunnel/VPS)
const API    = location.origin;
const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';

/* â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
let feed       = [];          // array of enriched scan objects (max 20)
let _products  = [];
let _locations = [];
let _robots    = [];
let editCache  = { robots:{}, locations:{}, products:{}, inventory:{} };
let modalCtx   = {};
let ws         = null;

/* â”€â”€ Pallet Lift Warning Light â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
let _palletLiftTimer = null;
function showPalletLift(state, location) {
  // state: 'lifting' | 'lifted' | 'idle'
  const badge = document.getElementById('pallet-lift-badge');
  const light = document.getElementById('pallet-lift-light');
  const label = document.getElementById('pallet-lift-label');
  const sub   = document.getElementById('pallet-lift-sub');
  clearTimeout(_palletLiftTimer);
  if (state === 'idle') { badge.style.display = 'none'; return; }
  light.className   = state;
  label.textContent = state === 'lifting' ? 'âš¡ PALLET LIFTING'
                    : state === 'lifted'  ? 'âœ” PALLET LIFTED'
                    : state === 'wrong'   ? 'âœ– WRONG SHELF'
                    : 'PALLET LIFT';
  sub.textContent   = location || 'â€”';
  badge.style.display = 'flex';
  if (state === 'lifted') {
    _palletLiftTimer = setTimeout(() => showPalletLift('idle'), 4000);
  }
}

/* â”€â”€ Clock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

/* â”€â”€ Tabs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'amr' && rosConnected) {
      requestSlamMapList();
    }
  });
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   WEBSOCKET â€” real-time connection
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsBadge(true);
    console.log('[WS] Connected');
    // Clear the initial "Connecting to server" placeholder even before history arrives.
    renderFeed(false);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'error') {
      console.error('[WS] Server error:', msg.message || msg);
      const grid = document.getElementById('feed-grid');
      if (grid) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red);font-family:var(--mono);font-size:11px">Server error: ${esc(msg.message || 'unknown')}</div>`;
      }
      toast('Live stream error: ' + (msg.message || 'unknown'), 'err');
    } else if (msg.type === 'history') {
      // Server sends last 20 scans on first connect
      feed = msg.data || [];
      renderFeed(false);
      updateStats();
    } else if (msg.type === 'scan') {
      // New scan from robot â€” prepend to feed
      feed.unshift(msg.data);
      if (feed.length > 20) feed.pop();
      updateSpotlight(msg.data, true);
      renderFeed(true);
      updateStats();
    } else if (['order_created','order_dispatched','pick_scanned','pick_completed','order_completed','pick_wrong_shelf','pick_no_task'].includes(msg.type)) {
      // Any order event â†’ refresh orders table
      loadOrders();
      if (msg.type === 'pick_scanned') {
        toast('ðŸ“¦ QR verified at ' + (msg.location ?? '') + ' â€” lifting palletâ€¦', 'ok');
        showPalletLift('lifting', msg.location ?? '');
      }
      if (msg.type === 'pick_completed') {
        showPalletLift('lifted', 'Pick complete');
      }
      if (msg.type === 'order_completed') {
        toast('âœ… Order complete â€” all pallets lifted!', 'ok');
        showPalletLift('lifted', 'Order complete');
      }
      if (msg.type === 'pick_wrong_shelf') {
        const scanned  = msg.scanned  ?? '?';
        const expected = msg.expected ?? '?';
        toast('âš  WRONG SHELF â€” scanned ' + scanned + ', expected ' + expected, 'err');
        showPalletLift('wrong', 'Scanned: ' + scanned + '  âœ•  Expected: ' + expected);
      }
    }
  };

  ws.onclose = () => {
    setWsBadge(false);
    console.log('[WS] Disconnected â€” retrying in 3sâ€¦');
    setTimeout(connectWS, 3000);    // auto-reconnect
  };

  ws.onerror = () => {
    ws.close();
  };
}

function setWsBadge(online) {
  const el = document.getElementById('ws-badge');
  el.className = 'ws-badge ' + (online ? 'connected' : 'disconnected');
  document.getElementById('ws-label').textContent = online ? 'LIVE' : 'OFFLINE';
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SPOTLIGHT â€” big card for the latest scan
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function updateSpotlight(d, animate = false) {
  document.getElementById('spot-empty').style.display = 'none';
  document.getElementById('scan-card').style.display  = 'flex';

  setText('v-robot', d.robot_code  || 'â€”', !!d.robot_code);
  setText('v-loc',   d.qr_code     || 'â€”', !!d.qr_code);
  document.getElementById('v-rack').textContent =
    (d.rack && d.slot) ? `Rack ${d.rack}  Â·  Slot ${d.slot}` : '';

  const hasProd = !!(d.product_name || d.product_code);
  setText('v-prod', d.product_name || d.product_code || 'â€”', hasProd);
  document.getElementById('v-cat').textContent = d.category || '';

  const hasQty = d.quantity != null;
  const qtyEl  = document.getElementById('v-qty');
  qtyEl.textContent  = hasQty ? d.quantity : 'N/A';
  qtyEl.className    = 'card-value qty' + (hasQty ? '' : ' na');

  document.getElementById('v-id').textContent   = '#' + (d.id || '?');
  document.getElementById('v-time').textContent = d.scan_time || 'â€”';

  if (animate) {
    const sp = document.getElementById('spotlight');
    sp.classList.remove('flash');
    void sp.offsetWidth;  // reflow to restart animation
    sp.classList.add('flash');
  }
}

function setText(id, val, hasData) {
  const el = document.getElementById(id);
  el.textContent = val;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   HISTORY FEED â€” grid of small cards
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function renderFeed(highlightFirst = false) {
  const grid = document.getElementById('feed-grid');
  if (!feed.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);font-family:var(--mono);font-size:11px">No scans yet.</div>`;
    return;
  }
  grid.innerHTML = feed.map((d, i) => {
    const isNew = highlightFirst && i === 0;
    const prod  = d.product_name || d.product_code;
    const loc   = d.qr_code;
    return `
    <div class="h-card${isNew ? ' new' : ''}">
      <div class="h-card-top">
        <span class="h-robot">${esc(d.robot_code || 'â€”')}</span>
        <span class="h-time">${esc(timeOnly(d.scan_time))}</span>
      </div>
      <div class="h-loc">${esc(loc || 'â€”')}</div>
      ${prod
        ? `<div class="h-prod">${esc(prod)}</div>
           <div class="h-qty">Qty: <span>${esc(d.quantity ?? 'N/A')}</span></div>`
        : `<div class="h-na">No product linked</div>`
      }
    </div>`;
  }).join('');
}

function timeOnly(dt) {
  if (!dt) return 'â€”';
  const parts = dt.split(' ');
  return parts.length > 1 ? parts[1] : dt;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   STATS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function updateStats() {
  document.getElementById('s-total').textContent  = feed.length;
  document.getElementById('s-robots').textContent = new Set(feed.map(r => r.robot_code)).size;
  document.getElementById('s-locs').textContent   = new Set(feed.map(r => r.qr_code)).size;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CRUD â€” fetch & render tables
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {headers:{'Content-Type':'application/json'}, ...opts});
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.detail || `HTTP ${res.status}`); }
  return res.json();
}

async function loadCrud() {
  try {
    const [robots, locs, prods, inv, logs] = await Promise.all([
      api('/robots'), api('/locations'), api('/products'), api('/inventory'), api('/scanlogs'),
    ]);
    _products  = prods;
    _locations = locs;
    _robots    = robots;
    renderRobots(robots);
    renderLocations(locs);
    renderProducts(prods);
    renderInventory(inv);
    renderScanlogs(logs);
    populateRobotSelect();
  } catch(e) { console.error('CRUD load failed:', e); }
}

function renderRobots(data) {
  setCount('cnt-robots', data.length);
  const tb = document.getElementById('body-robots');
  editCache.robots = {};
  if (!data.length) { emptyRow(tb, 7); return; }
  const stCls = s => s === 'IDLE' ? 'COMPLETED' : s === 'BUSY' ? 'IN_PROGRESS' : 'PENDING';
  tb.innerHTML = data.map(r => {
    editCache.robots[r.id] = r;
    return `<tr>
      <td class="id">${esc(r.id)}</td>
      <td class="code">${esc(r.robot_code)}</td>
      <td>${esc(r.description??'â€”')}</td>
      <td><span class="order-status ${stCls(r.status)}">${esc(r.status??'IDLE')}</span></td>
      <td style="font-family:var(--mono);font-size:11px">${esc(r.ip_address??'â€”')}</td>
      <td style="font-size:11px;font-family:var(--mono)">${r.home_x != null ? Number(r.home_x).toFixed(3) : 'â€”'}, ${r.home_y != null ? Number(r.home_y).toFixed(3) : 'â€”'}</td>
      <td class="acts">
        <button class="btn btn-ghost btn-sm" onclick="openEdit('robots',${r.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDel('robots',${r.id},'${esc(r.robot_code)}')">Del</button>
      </td></tr>`;
  }).join('');
}

function renderLocations(data) {
  setCount('cnt-locations', data.length);
  const tb = document.getElementById('body-locations');
  editCache.locations = {};
  syncSavedShelfWaypoints(data);
  if (!data.length) { emptyRow(tb, 6); return; }
  tb.innerHTML = data.map(r => {
    editCache.locations[r.id] = r;
    return `<tr>
      <td class="id">${esc(r.id)}</td>
      <td class="code">${esc(r.location_code)}</td>
      <td>${esc(r.rack??'â€”')}</td>
      <td>${esc(r.slot??'â€”')}</td>
      <td style="font-family:var(--mono);font-size:11px">${r.loc_x != null ? Number(r.loc_x).toFixed(3) : 'â€”'}, ${r.loc_y != null ? Number(r.loc_y).toFixed(3) : 'â€”'}, ${r.loc_yaw != null ? Number(r.loc_yaw).toFixed(2) : 'â€”'}</td>
      <td class="acts">
        <button class="btn btn-ghost btn-sm" onclick="openEdit('locations',${r.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDel('locations',${r.id},'${esc(r.location_code)}')">Del</button>
      </td></tr>`;
  }).join('');
}

function renderProducts(data) {
  setCount('cnt-products', data.length);
  const tb = document.getElementById('body-products');
  editCache.products = {};
  if (!data.length) { emptyRow(tb, 5); return; }
  tb.innerHTML = data.map(r => {
    editCache.products[r.id] = r;
    return `<tr>
      <td class="id">${esc(r.id)}</td>
      <td class="code">${esc(r.product_code)}</td>
      <td>${esc(r.name??'â€”')}</td>
      <td>${esc(r.category??'â€”')}</td>
      <td class="acts">
        <button class="btn btn-ghost btn-sm" onclick="openEdit('products',${r.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDel('products',${r.id},'${esc(r.product_code)}')">Del</button>
      </td></tr>`;
  }).join('');
}

function renderInventory(data) {
  setCount('cnt-inventory', data.length);
  const tb = document.getElementById('body-inventory');
  editCache.inventory = {};
  if (!data.length) { emptyRow(tb, 6); return; }
  tb.innerHTML = data.map(r => {
    editCache.inventory[r.id] = r;
    return `<tr>
      <td class="id">${esc(r.id)}</td>
      <td class="code">${esc(r.product_code??'â€”')} <small style="color:var(--muted)">${esc(r.product_name??'')}</small></td>
      <td>${esc(r.location_code??'â€”')}</td>
      <td style="color:var(--muted)">${esc(r.rack??'')}/${esc(r.slot??'')}</td>
      <td class="qty">${esc(r.quantity)}</td>
      <td class="acts">
        <button class="btn btn-ghost btn-sm" onclick="openEdit('inventory',${r.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDel('inventory',${r.id},'inventory #${r.id}')">Del</button>
      </td></tr>`;
  }).join('');
}

function renderScanlogs(data) {
  setCount('cnt-scanlogs', data.length);
  const tb = document.getElementById('body-scanlogs');
  if (!data.length) { emptyRow(tb, 5); return; }
  tb.innerHTML = data.map(r => `<tr>
    <td class="id">${esc(r.id)}</td>
    <td class="robot">${esc(r.robot_code)}</td>
    <td class="code">${esc(r.qr_code)}</td>
    <td class="time">${esc(r.scan_time)}</td>
    <td class="acts">
      <button class="btn btn-danger btn-sm" onclick='confirmDel("scanlogs",${r.id},"scan #${r.id}")'>Del</button>
    </td></tr>`).join('');
}

function setCount(id, n) { document.getElementById(id).textContent = n; }
function emptyRow(tb, cols) {
  tb.innerHTML = `<tr class="state-row"><td colspan="${cols}">No records.</td></tr>`;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   MODAL FORMS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
const FORMS = {
  robots: () => `<div class="form-grid">
    <div class="field full"><label>Robot Code *</label><input id="f0" placeholder="AMR_01"/></div>
    <div class="field full"><label>Description</label><input id="f1" placeholder="Main floor robot"/></div>
    <div class="field"><label>Status</label><select id="f2"><option value="IDLE">IDLE</option><option value="BUSY">BUSY</option><option value="OFFLINE">OFFLINE</option><option value="CHARGING">CHARGING</option></select></div>
    <div class="field"><label>IP Address</label><input id="f3" placeholder="192.168.1.56"/></div>
    <div class="field"><label>Home X</label><input id="f4" type="number" step="0.001" placeholder="-1.296"/></div>
    <div class="field"><label>Home Y</label><input id="f5" type="number" step="0.001" placeholder="-0.049"/></div>
    <div class="field"><label>Home Yaw</label><input id="f6" type="number" step="0.001" placeholder="0.185"/></div>
  </div>`,

  locations: () => `<div class="form-grid">
    <div class="field full"><label>Location Code *</label><input id="f0" placeholder="RACK_A_01"/></div>
    <div class="field"><label>Rack</label><input id="f1" placeholder="A"/></div>
    <div class="field"><label>Slot</label><input id="f2" placeholder="01"/></div>
    <div class="field"><label>Map X</label><input id="f3" type="number" step="0.001" placeholder="-0.546"/></div>
    <div class="field"><label>Map Y</label><input id="f4" type="number" step="0.001" placeholder="-0.512"/></div>
    <div class="field"><label>Yaw</label><input id="f5" type="number" step="0.01" placeholder="0.0"/></div>
  </div>`,

  products: () => `<div class="form-grid">
    <div class="field full"><label>Product Code *</label><input id="f0" placeholder="PROD-001"/></div>
    <div class="field full"><label>Name</label><input id="f1" placeholder="Motor"/></div>
    <div class="field full"><label>Category</label><input id="f2" placeholder="Electronics"/></div>
  </div>`,

  inventory: () => {
    const pOpts = _products.map(p => `<option value="${p.id}">${esc(p.product_code)} â€” ${esc(p.name??'')}</option>`).join('');
    const lOpts = _locations.map(l => `<option value="${l.id}">${esc(l.location_code)} (${esc(l.rack)}/${esc(l.slot)})</option>`).join('');
    return `<div class="form-grid one">
      <div class="field"><label>Product *</label><select id="f0"><option value="">â€” select â€”</option>${pOpts}</select></div>
      <div class="field"><label>Location *</label><select id="f1"><option value="">â€” select â€”</option>${lOpts}</select></div>
      <div class="field"><label>Quantity *</label><input id="f2" type="number" min="0" placeholder="0"/></div>
    </div>`;
  },

  scanlogs: () => `<div class="form-grid">
    <div class="field full"><label>Robot Code *</label><input id="f0" placeholder="AMR_01"/></div>
    <div class="field full"><label>QR Code *</label><input id="f1" placeholder="RACK_A_01"/></div>
  </div>`,
};

function openAdd(table) {
  modalCtx = { table, mode: 'add', id: null };
  document.getElementById('modal-title').textContent = 'Add â€” ' + table;
  document.getElementById('modal-body').innerHTML = FORMS[table]();
  document.getElementById('modal-save').textContent = 'Create';
  document.getElementById('form-modal').classList.add('open');
}

function openEdit(table, id, row) {
  row = row || editCache[table]?.[id];
  if (!row) { toast('Unable to load record for edit', 'err'); return; }
  modalCtx = { table, mode: 'edit', id };
  document.getElementById('modal-title').textContent = 'Edit â€” ' + table + ' #' + id;
  document.getElementById('modal-body').innerHTML = FORMS[table]();
  document.getElementById('modal-save').textContent = 'Update';
  document.getElementById('form-modal').classList.add('open');
  // pre-fill
  const fill = (fid, v) => { const el=document.getElementById(fid); if(el) el.value = v??''; };
  if (table==='robots')     { fill('f0',row.robot_code);   fill('f1',row.description); fill('f2',row.status); fill('f3',row.ip_address); fill('f4',row.home_x); fill('f5',row.home_y); fill('f6',row.home_yaw); }
  if (table==='locations')  { fill('f0',row.location_code);fill('f1',row.rack);fill('f2',row.slot); fill('f3',row.loc_x); fill('f4',row.loc_y); fill('f5',row.loc_yaw); }
  if (table==='products')   { fill('f0',row.product_code); fill('f1',row.name);fill('f2',row.category); }
  if (table==='inventory')  { fill('f0',row.product_id);   fill('f1',row.location_id);fill('f2',row.quantity); }
  if (table==='scanlogs')   { fill('f0',row.robot_code);   fill('f1',row.qr_code); }
}

function getv(id) { const el=document.getElementById(id); return el?el.value.trim():null; }

async function saveRecord() {
  const { table, mode, id } = modalCtx;
  let body = {};

  if (table==='robots')    { body={robot_code:getv('f0'),description:getv('f1'),status:getv('f2'),ip_address:getv('f3')||null,home_x:getv('f4')?+getv('f4'):null,home_y:getv('f5')?+getv('f5'):null,home_yaw:getv('f6')?+getv('f6'):null}; if(!body.robot_code){toast('Robot Code required','err');return;} }
  if (table==='locations') {
    body={
      location_code:getv('f0'),
      rack:getv('f1'),
      slot:getv('f2'),
      loc_x:getv('f3')!==''?+getv('f3'):null,
      loc_y:getv('f4')!==''?+getv('f4'):null,
      loc_yaw:getv('f5')!==''?+getv('f5'):null,
    };
    if(!body.location_code){toast('Location Code required','err');return;}
  }
  if (table==='products')  { body={product_code:getv('f0'),name:getv('f1'),category:getv('f2')}; if(!body.product_code){toast('Product Code required','err');return;} }
  if (table==='inventory') {
    const p=getv('f0'),l=getv('f1'),q=getv('f2');
    if(!p||!l||q===''){toast('All fields required','err');return;}
    body={product_id:+p,location_id:+l,quantity:+q};
  }
  if (table==='scanlogs')  { body={robot_code:getv('f0'),qr_code:getv('f1')}; if(!body.robot_code||!body.qr_code){toast('Both fields required','err');return;} }

  try {
    if (mode==='add') {
      await api('/'+table, {method:'POST',body:JSON.stringify(body)});
      toast('Created');
    } else {
      await api('/'+table+'/'+id, {method:'PUT',body:JSON.stringify(body)});
      toast('Updated');
    }
    closeModal('form-modal');
    loadCrud();
  } catch(e) { toast(e.message,'err'); }
}

/* â”€â”€ Delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function confirmDel(table, id, label) {
  document.getElementById('del-msg').innerHTML = `Delete <strong>${label}</strong>? This cannot be undone.`;
  document.getElementById('del-modal').classList.add('open');
  document.getElementById('del-ok').onclick = async () => {
    try {
      await api('/'+table+'/'+id, {method:'DELETE'});
      toast('Deleted');
      closeModal('del-modal');
      loadCrud();
    } catch(e) { toast(e.message,'err'); }
  };
}

/* â”€â”€ Modal utils â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-backdrop').forEach(el =>
  el.addEventListener('click', e => { if(e.target===el) closeModal(el.id); })
);
document.addEventListener('keydown', e => {
  if (e.key==='Escape') { closeModal('form-modal'); closeModal('del-modal'); }
});

/* â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function jq(r) { return JSON.stringify(r).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'); }

let toastT;
function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = (type==='ok'?'âœ“ ':'âœ— ') + msg;
  el.className = type;
  el.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(()=>{ el.style.display='none'; }, 3000);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CAMERA
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

// Camera streams through the server proxy â€” no direct Pi connection needed.
// Default URL uses the proxy; user can override with a direct URL if on LAN.
let MJPEG_URL = '';

// Track load timeout so we can show error if img never fires onload
let camLoadTimer = null;
let camActive    = false;
let camStreamToken = 0;

/** Build the proxy camera URL for the currently selected (or first) robot. */
function getCameraProxyUrl() {
  const code = activeRobotCode || (_robots.length ? _robots[0].robot_code : 'AMR_01');
  return location.origin + '/camera-proxy?robot=' + encodeURIComponent(code);
}

function normalizeCameraUrl(rawUrl) {
  const isAbsolute = /^https?:\/\//i.test(rawUrl);
  const url = new URL(rawUrl, location.origin);
  if (!isAbsolute && url.pathname === '/camera-proxy') {
    url.protocol = location.protocol;
    url.host = location.host;
  }
  return url.toString();
}

function buildCameraRequestUrl(rawUrl) {
  const url = new URL(normalizeCameraUrl(rawUrl));
  url.searchParams.set('t', Date.now().toString());
  return url.toString();
}

function applyUrl() {
  const val = document.getElementById('cam-url-input').value.trim();
  if (!val) return;
  MJPEG_URL = normalizeCameraUrl(val);
  document.getElementById('cam-url-input').value = MJPEG_URL;
  toast('Stream URL updated â€” press Start Camera to connect');
  // If stream is currently running, restart with new URL
  if (camActive) startCamera();
}

function startCamera() {
  camActive = true;
  camStreamToken += 1;
  const token = camStreamToken;

  // Use the input field value, or auto-build a proxy URL
  const inputVal = document.getElementById('cam-url-input').value.trim();
  if (inputVal && !inputVal.includes('RASPBERRY_PI_IP')) {
    MJPEG_URL = normalizeCameraUrl(inputVal);
  } else {
    MJPEG_URL = getCameraProxyUrl();
    document.getElementById('cam-url-input').value = MJPEG_URL;
  }

  // Show loading state
  showCamState('loading');
  document.getElementById('cam-loading-url').textContent = MJPEG_URL;
  document.getElementById('btn-start-cam').disabled = true;
  document.getElementById('btn-stop-cam').disabled  = false;
  setCamBadge('connecting');

  // Nuke any previous stream, then inject a fresh <img>
  const wrap = document.getElementById('cam-img-wrap');
  wrap.innerHTML = '';

  setTimeout(() => {
    if (!camActive || token !== camStreamToken) return;
    const img = document.createElement('img');
    img.id = 'cam-img';
    img.style.cssText = 'width:100%;height:100%;object-fit:contain';
    img.alt = 'Robot camera feed';
    img.onload  = () => onCamLoad(token);
    img.onerror = () => onCamError(token);
    img.src = buildCameraRequestUrl(MJPEG_URL);
    wrap.appendChild(img);

    // Timeout: if onload hasn't fired within 8 s, treat as offline
    clearTimeout(camLoadTimer);
    camLoadTimer = setTimeout(() => {
      if (token !== camStreamToken || !camActive) return;
      if (!img.complete || img.naturalWidth === 0) {
        onCamError(token);
      }
    }, 8000);
  }, 80);
}

function stopCamera() {
  camActive = false;
  camStreamToken += 1;
  clearTimeout(camLoadTimer);

  // Nuke the wrapper innerHTML â€” the ONLY reliable way to abort an MJPEG stream
  document.getElementById('cam-img-wrap').innerHTML = '';

  showCamState('idle');
  document.getElementById('btn-start-cam').disabled = false;
  document.getElementById('btn-stop-cam').disabled  = true;
  setCamBadge('offline');
  document.getElementById('cam-footer-info').textContent = 'No stream active';
}

function onCamLoad(token = camStreamToken) {
  if (!camActive || token !== camStreamToken) return;
  // img fired onload â€” stream is alive
  clearTimeout(camLoadTimer);
  showCamState('stream');
  setCamBadge('online');
  document.getElementById('cam-footer-info').textContent =
    'â— Streaming from ' + MJPEG_URL;
}

function onCamError(token = camStreamToken) {
  // img fired onerror, or our timeout fired
  clearTimeout(camLoadTimer);
  if (!camActive || token !== camStreamToken) return;           // user stopped manually â€” ignore

  document.getElementById('cam-img').style.display = 'none';
  document.getElementById('cam-error-msg').textContent =
    'Could not reach: ' + MJPEG_URL;
  showCamState('error');
  setCamBadge('offline');
  document.getElementById('btn-start-cam').disabled = false;
  document.getElementById('btn-stop-cam').disabled  = true;
  document.getElementById('cam-footer-info').textContent = 'Stream unavailable';
}

/**
 * Switch which overlay/image is visible inside the camera window.
 * state: 'idle' | 'loading' | 'error' | 'stream'
 */
function showCamState(state) {
  document.getElementById('cam-idle').style.display    = state==='idle'    ? 'flex' : 'none';
  document.getElementById('cam-loading').style.display = state==='loading' ? 'flex' : 'none';
  document.getElementById('cam-error').style.display   = state==='error'   ? 'flex' : 'none';
  document.getElementById('cam-img-wrap').style.display = state==='stream' ? 'block' : 'none';
}

/** Update the status badge in the panel header */
function setCamBadge(state) {
  // state: 'online' | 'offline' | 'connecting'
  const badge = document.getElementById('cam-status-badge');
  const txt   = document.getElementById('cam-status-txt');
  if (state === 'online') {
    badge.className  = 'cam-badge online';
    txt.textContent  = 'Camera Online';
  } else if (state === 'connecting') {
    badge.className  = 'cam-badge offline';
    txt.textContent  = 'Connectingâ€¦';
  } else {
    badge.className  = 'cam-badge offline';
    txt.textContent  = 'Camera Offline';
  }
}

function preloadCameraUrl() {
  const input = document.getElementById('cam-url-input');
  if (!input) return;
  const val = input.value.trim();
  if (!val) {
    input.value = getCameraProxyUrl();
  }
}

// Prefill URL when Camera tab is opened (no auto-start)
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'camera') {
    btn.addEventListener('click', () => {
      setTimeout(preloadCameraUrl, 30);
    });
  }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   AMR CONTROL â€” ROS2 / Nav2 Integration
   Requires: roslib.min.js, eventemitter2.min.js, chart.js
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

// â”€â”€ Dynamic script loader (load ROS libs on demand) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadScript(src, cb) {
  if (document.querySelector(`script[src="${src}"]`)) { cb && cb(); return; }
  const s = document.createElement('script'); s.src = src;
  s.onload = cb || (()=>{});
  document.head.appendChild(s);
}

let rosLibsLoaded = false;
function ensureRosLibs(cb) {
  if (rosLibsLoaded) { cb(); return; }
  loadScript('https://cdn.jsdelivr.net/npm/eventemitter2@6/lib/eventemitter2.min.js', () => {
    loadScript('https://cdn.jsdelivr.net/npm/roslib@1/build/roslib.min.js', () => {
      loadScript('https://cdn.jsdelivr.net/npm/chart.js', () => {
        rosLibsLoaded = true;
        cb();
      });
    });
  });
}

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let ros = null;
let rosConnected = false;

// Multi-robot connection map: { robot_code: { ros, connected, ip } }
let rosConnections = {};
let activeRobotCode = null;    // currently selected robot_code

// Operating mode: 'manual' | 'auto'
let amrMode = 'manual';

// SLAM state
let slamState = 'IDLE';  // IDLE | MAPPING | SAVING | SAVED | NAV | LOADING | ERROR
let topicSlamCmd = null, topicSlamStatus = null, topicSlamMapList = null;
let mapLoadExpected = false;  // gate: only show map when user clicks Load Map or Start SLAM
let mapListLoaded = false;
let mapListRetryTimer = null;
let mapLoadRequestToken = 0;
let mapSwitchInProgress = false;
let mapSwitchTargetName = '';
let mapSwitchTimeoutTimer = null;
let mapSwitchNavConfirmed = false;
let mapSwitchHasMapFrame = false;
let mapSwitchMapFrameTimer = null;

function normalizeMapName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^.*\//, '')
    .replace(/\.ya?ml$/, '');
}

function navStateMapName(state) {
  if (!state || typeof state !== 'string' || !state.startsWith('NAV:')) return '';
  return state.substring(4).trim();
}

function completeMapSwitch(successText) {
  mapSwitchInProgress = false;
  mapSwitchNavConfirmed = false;
  mapSwitchHasMapFrame = false;
  if (mapSwitchMapFrameTimer) {
    clearTimeout(mapSwitchMapFrameTimer);
    mapSwitchMapFrameTimer = null;
  }
  if (mapSwitchTimeoutTimer) {
    clearTimeout(mapSwitchTimeoutTimer);
    mapSwitchTimeoutTimer = null;
  }
  setMapListMeta(successText || ('Loaded map "' + (mapSwitchTargetName || 'selected') + '"'));
}

// Shelf mapping mode (persistent locations)
let isMultiWpMode = false;
let draftWaypoints = [];   // temporary points not yet saved to DB
let squareWaypoints = [];  // persisted shelf points (from DB)

// Current robot pose (map frame)
let robotX = null, robotY = null, robotYaw = null;

// Goal state
let goalX = null, goalY = null;
let goalInitX = null;              // goal origin for distance calc
let goalInitY = null;              // goal origin for distance calc
let navState = 'IDLE';             // IDLE | NAVIGATING | SUCCESS | FAILED
let localizationReady = false;
let localizationRequested = false;
let localizationWaitTimer = null;
let initPosePending = false;

// Trajectory history
let poseHistory = [];
const MAX_HISTORY = 500;

// Mission waypoints
let missionWaypoints = [];         // [{x,y,yaw}]
let missionActive = false;
let missionIndex  = 0;

// Map / canvas state
let mapCanvas = null, mapCtx = null;
let mapViewer = null;              // ROS2D viewer if lib loaded
let mapScale  = 1;                 // pixels per metre
let mapOriginX = 0, mapOriginY = 0; // map origin in canvas px
let mapResolution = 0.05;          // metres per cell
let mapWidth = 0, mapHeight = 0;   // cells
let occupancyData = null;          // flat Uint8Array
let occupancyCachedCanvas = null;  // pre-rendered grid (1 px/cell)
let mapPanOffset  = { x: 0, y: 0 };
let isPanning     = false;
let panStart      = { x: 0, y: 0 };

// Map interaction â€” 'nav' | 'wp' | 'pan'
let activeTool = 'nav';
let isDragging = false;
let dragStart  = null;             // {x,y} map coords at mousedown
let dragCurrent = null;

// ROS topics (populated after connect)
let topicCmdVel, topicGoal, topicInitPose, topicPID;
let teleopInterval = null;
let teleopLinear = 0, teleopAngular = 0;

// LiDAR data
let lidarPoints = [];
const MAX_LIDAR_PTS = 800;
let lidarVisible = true;
let pathVisible  = true;
let histVisible  = true;

// Global nav path
let globalPath = [];

// PID chart data
let amrChartL = null, amrChartR = null;
let pidTarL = 0, pidTarR = 0, pidActL = 0, pidActR = 0;
const WHEEL_BASE = 0.30;
const MAX_CHART_PTS = 50;

// Preset waypoints intentionally empty: runtime points come from saved map data.
const PRESETS = [];

// â”€â”€ Multi-robot fleet UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function populateRobotSelect() {
  const sel = document.getElementById('amr-robot-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">â€” select robot â€”</option>' +
    _robots.map(r => `<option value="${esc(r.robot_code)}">${esc(r.robot_code)} â€” ${esc(r.description ?? '')}</option>`).join('');
  // restore previous selection
  if (prev && _robots.some(r => r.robot_code === prev)) sel.value = prev;
  renderFleetDots();
}

function renderFleetDots() {
  const wrap = document.getElementById('fleet-dots');
  if (!wrap) return;
  wrap.innerHTML = _robots.map(r => {
    const conn = rosConnections[r.robot_code];
    const on = conn?.connected;
    const mode = conn?.mode || '';
    const modeIcon = mode.includes('Cloud') ? 'â˜ï¸' : (on ? 'ðŸ”—' : '');
    return `<div style="display:flex;align-items:center;gap:3px;cursor:pointer" title="${esc(r.robot_code)} â€” ${on ? (mode || 'Connected') : 'Offline'}${r.ip_address ? ' ('+esc(r.ip_address)+')' : ''}" onclick="document.getElementById('amr-robot-select').value='${esc(r.robot_code)}';switchActiveRobot('${esc(r.robot_code)}')">
      <div class="ros-dot${on ? ' on' : ''}" style="width:6px;height:6px"></div>
      <span style="font-family:var(--mono);font-size:9px;color:${on ? 'var(--green)' : 'var(--muted)'}">${modeIcon} ${esc(r.robot_code)}</span>
    </div>`;
  }).join('');
}

function switchActiveRobot(code) {
  activeRobotCode = code || null;
  const robot = _robots.find(r => r.robot_code === code);
  // Fill IP from DB
  document.getElementById('ros-ip').value = robot?.ip_address ?? '';

  // Switch active ros connection
  const conn = rosConnections[code];
  if (conn?.connected) {
    ros = conn.ros;
    rosConnected = true;
    rosSetStatus('Connected â€” ' + (robot?.ip_address ?? code), true);
    setupTopics();
    initAMRMap();
  } else {
    ros = null;
    rosConnected = false;
    rosSetStatus(code ? 'Not connected' : 'Select a robot', false);
  }
  renderFleetDots();
}

// â”€â”€ ROS connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function rosConnect() {
  const code = activeRobotCode;
  if (!code) { toast('Select a robot first', 'err'); return; }
  const ip = document.getElementById('ros-ip').value.trim();
  if (!ip) { toast('Enter IP address', 'err'); return; }

  // Save IP back to DB if changed
  const robot = _robots.find(r => r.robot_code === code);
  if (robot && robot.ip_address !== ip) {
    api('/robots/' + robot.id, { method: 'PUT', body: JSON.stringify({ ip_address: ip }) }).catch(() => {});
    robot.ip_address = ip;
  }

  ensureRosLibs(() => {
    // Close existing connection for this robot if any
    if (rosConnections[code]?.ros) {
      try { rosConnections[code].ros.close(); } catch(e) {}
    }

    rosSetStatus('Connectingâ€¦', false);
    // Connect via server-side proxy instead of directly to the Pi
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const proxyUrl = wsProto + '//' + location.host + '/ros-proxy?robot=' + encodeURIComponent(code);
    const newRos = new ROSLIB.Ros({ url: proxyUrl });

    rosConnections[code] = { ros: newRos, connected: false, ip };

    newRos.on('connection', () => {
      rosConnections[code].connected = true;
      // Detect connection mode (Cloud Bridge vs LAN)
      fetch(API + '/robot-agents').then(r => r.json()).then(agents => {
        const mode = agents[code] ? 'â˜ï¸ Cloud Bridge' : 'ðŸ”— LAN';
        rosConnections[code].mode = mode;
        if (activeRobotCode === code) {
          rosSetStatus(mode + ' â€” ' + ip, true);
        }
        renderFleetDots();
      }).catch(() => renderFleetDots());
      if (activeRobotCode === code) {
        ros = newRos;
        rosConnected = true;
        rosSetStatus('Connected â€” ' + ip, true);
        setupTopics();
        initAMRMap();
        initPIDCharts();
        buildPresets();
      }
    });
    newRos.on('error', () => {
      rosConnections[code].connected = false;
      if (activeRobotCode === code) {
        rosConnected = false;
        rosSetStatus('Connection error', false);
      }
      renderFleetDots();
    });
    newRos.on('close', () => {
      rosConnections[code].connected = false;
      if (activeRobotCode === code) {
        ros = null;
        rosConnected = false;
        rosSetStatus('Disconnected', false);
      }
      renderFleetDots();
    });
  });
}

function rosDisconnect() {
  const code = activeRobotCode;
  if (code && rosConnections[code]?.ros) {
    try { rosConnections[code].ros.close(); } catch(e) {}
    rosConnections[code] = { ros: null, connected: false, ip: rosConnections[code]?.ip };
  }
  ros = null;
  rosConnected = false;
  if (mapListRetryTimer) {
    clearInterval(mapListRetryTimer);
    mapListRetryTimer = null;
  }
  mapListLoaded = false;
  localizationReady = false;
  localizationRequested = false;
  initPosePending = false;
  isDragging = false;
  dragStart = null;
  dragCurrent = null;
  if (localizationWaitTimer) {
    clearTimeout(localizationWaitTimer);
    localizationWaitTimer = null;
  }
  rosSetStatus('Disconnected', false);
  renderFleetDots();
}

function rosSetStatus(msg, online) {
  document.getElementById('ros-status-txt').textContent = msg;
  document.getElementById('ros-dot').className = 'ros-dot' + (online ? ' on' : '');
}

// â”€â”€ Setup all ROS topics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function setupTopics() {
  // cmd_vel
  topicCmdVel = new ROSLIB.Topic({ ros, name: '/cmd_vel', messageType: 'geometry_msgs/Twist' });
  topicCmdVel.advertise();

  // goal_pose
  topicGoal = new ROSLIB.Topic({ ros, name: '/goal_pose', messageType: 'geometry_msgs/PoseStamped' });
  topicGoal.advertise();

  // initialpose
  topicInitPose = new ROSLIB.Topic({ ros, name: '/initialpose', messageType: 'geometry_msgs/PoseWithCovarianceStamped' });
  topicInitPose.advertise();

  // PID
  topicPID = new ROSLIB.Topic({ ros, name: '/pid_command', messageType: 'std_msgs/String' });
  topicPID.advertise();

  // â”€â”€ amcl_pose â†’ robot position + history
  const poseTopic = new ROSLIB.Topic({ ros, name: '/amcl_pose', messageType: 'geometry_msgs/PoseWithCovarianceStamped' });
  poseTopic.subscribe(msg => {
    const nextX = msg.pose.pose.position.x;
    const nextY = msg.pose.pose.position.y;
    const qz = msg.pose.pose.orientation.z;
    const qw = msg.pose.pose.orientation.w;
    const nextYaw = 2 * Math.atan2(qz, qw);

    robotX = nextX;
    robotY = nextY;
    robotYaw = nextYaw;

    // Trajectory history
    if (histVisible) {
      poseHistory.push({ x: robotX, y: robotY });
      if (poseHistory.length > MAX_HISTORY) poseHistory.shift();
    }

    updateIMUDisplay();
    updateNavStatus();

    redrawMap();

    if (localizationRequested) {
      localizationRequested = false;
      localizationReady = true;
      if (localizationWaitTimer) {
        clearTimeout(localizationWaitTimer);
        localizationWaitTimer = null;
      }
      toast('Localization acquired from nav2_amcl. Navigation enabled.', 'ok');
    }
  });

  // â”€â”€ IMU
  const imuTopic = new ROSLIB.Topic({ ros, name: '/imu/data', messageType: 'sensor_msgs/msg/Imu' });
  imuTopic.subscribe(msg => {
    const yaw = 2 * Math.atan2(msg.orientation.z, msg.orientation.w);
    document.getElementById('imu-yaw-deg').textContent = (yaw * 180 / Math.PI).toFixed(2) + 'Â°';
    document.getElementById('imu-yaw-rad').textContent = yaw.toFixed(3);
  });

  // â”€â”€ /map â€” occupancy grid
  // Only render after the user explicitly starts SLAM or loads a saved map.
  mapLoadExpected = false;

  const mapTopic = new ROSLIB.Topic({
    ros,
    name: '/map',
    messageType: 'nav_msgs/msg/OccupancyGrid',
    qos: { durability: 1, reliability: 1, history: 1, depth: 1 },
  });
  mapTopic.subscribe(msg => {
    if (mapSwitchInProgress) {
      mapSwitchHasMapFrame = true;
      applyMapMsg(msg);
      if (mapSwitchNavConfirmed) {
        console.log('[MAP] Switch completed via /map topic:', mapSwitchTargetName || '(unknown)');
        completeMapSwitch('Loaded map "' + (mapSwitchTargetName || 'selected') + '"');
      } else if (!mapSwitchMapFrameTimer) {
        // Fallback: /map arrived but NAV status can lag or be missed over rosbridge.
        // Avoid false timeout while still giving status stream a short window to confirm.
        setMapListMeta('Map frame received, waiting NAV statusâ€¦');
        mapSwitchMapFrameTimer = setTimeout(() => {
          mapSwitchMapFrameTimer = null;
          if (!mapSwitchInProgress || !mapSwitchHasMapFrame || mapSwitchNavConfirmed) return;
          console.log('[MAP] Completing switch from /map fallback (NAV status delayed)');
          completeMapSwitch('Loaded map from /map (NAV status delayed)');
        }, 2500);
      }
    } else {
      applyMapMsg(msg);   // live SLAM updates or continuous map_server republish
    }
  });

  // â”€â”€ /scan â€” LiDAR
  const scanTopic = new ROSLIB.Topic({ ros, name: '/scan', messageType: 'sensor_msgs/msg/LaserScan' });
  let lastScanTime = 0;
  scanTopic.subscribe(msg => {
    if (mapSwitchInProgress) return;
    if (Date.now() - lastScanTime < 100) return;   // 10 Hz cap
    lastScanTime = Date.now();
    if (robotX === null) return;

    lidarPoints = [];
    const step = Math.max(1, Math.floor(msg.ranges.length / MAX_LIDAR_PTS));
    for (let i = 0; i < msg.ranges.length; i += step) {
      const r = msg.ranges[i];
      if (r >= msg.range_min && r <= msg.range_max) {
        const angle = robotYaw + msg.angle_min + i * msg.angle_increment;
        lidarPoints.push({
          x: robotX + r * Math.cos(angle),
          y: robotY + r * Math.sin(angle),
        });
      }
    }
    if (lidarVisible) redrawMap();
  });

  // â”€â”€ /plan â€” global path
  const planTopic = new ROSLIB.Topic({ ros, name: '/plan', messageType: 'nav_msgs/msg/Path' });
  planTopic.subscribe(msg => {
    globalPath = msg.poses.map(p => ({ x: p.pose.position.x, y: p.pose.position.y }));
    if (pathVisible) redrawMap();
  });

  // â”€â”€ navigation status
  const navStatus = new ROSLIB.Topic({ ros, name: '/navigate_to_pose/_action/status', messageType: 'action_msgs/msg/GoalStatusArray' });
  navStatus.subscribe(msg => {
    if (!msg.status_list || !msg.status_list.length) return;
    const s = msg.status_list[msg.status_list.length - 1].status;
    if (s === 4) {   // SUCCEEDED
      if (missionActive) advanceMission();
      else setNavState('SUCCESS');
      globalPath = [];
    } else if (s === 6) {  // ABORTED
      missionActive = false;
      setNavState('FAILED');
      globalPath = [];
    }
  });

  // â”€â”€ /odom for PID chart actual wheel speeds
  const odomTopic = new ROSLIB.Topic({ ros, name: '/odom', messageType: 'nav_msgs/msg/Odometry' });
  odomTopic.subscribe(msg => {
    const v = msg.twist.twist.linear.x;
    const w = msg.twist.twist.angular.z;
    pidActL = v - (w * WHEEL_BASE / 2);
    pidActR = v + (w * WHEEL_BASE / 2);
  });

  // â”€â”€ SLAM control topics
  topicSlamCmd = new ROSLIB.Topic({ ros, name: '/slam/command', messageType: 'std_msgs/String' });
  topicSlamCmd.advertise();   // pre-advertise so rosbridge creates the publisher immediately (DDS discovery)
  topicSlamStatus = new ROSLIB.Topic({ ros, name: '/slam/status', messageType: 'std_msgs/String' });
  topicSlamStatus.subscribe(msg => {
    console.log('[SLAM] Status received:', msg.data);
    updateSlamUI(msg.data);
  });
  topicSlamMapList = new ROSLIB.Topic({
    ros,
    name: '/slam/map_list',
    messageType: 'std_msgs/String',
  });
  topicSlamMapList.subscribe(msg => {
    console.log('[SLAM] ðŸ”” map_list RECEIVED:', msg);
    console.log('[SLAM]   msg.data:', msg?.data);
    console.log('[SLAM]   typeof msg.data:', typeof msg?.data);
    console.log('[SLAM]   msg keys:', Object.keys(msg || {}));
    populateMapList(msg, 'ROS');
  });
  mapListLoaded = false;
  requestSlamMapList();
  // rosbridge/DDS discovery can lag briefly after WebSocket connect.
  // Re-issue shortly after setup to guarantee command delivery.
  setTimeout(() => requestSlamMapList(), 500);
  setTimeout(() => requestSlamMapList(), 1500);
  if (mapListRetryTimer) clearInterval(mapListRetryTimer);
  mapListRetryTimer = setInterval(() => {
    if (!rosConnected || mapListLoaded) {
      clearInterval(mapListRetryTimer);
      mapListRetryTimer = null;
      return;
    }
    requestSlamMapList();
  }, 1200);
}

function requestSlamMapList() {
  if (!rosConnected || !topicSlamCmd) return;
  console.log('[SLAM] ðŸ“¢ Requesting map list via /slam/command');
  setMapListMeta('Requesting saved mapsâ€¦');
  topicSlamCmd.publish(new ROSLIB.Message({ data: 'list_map' }));
}

// â”€â”€ Map initialisation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function initAMRMap() {
  const wrap = document.getElementById('amr-map-wrap');
  wrap.innerHTML = '';   // clear placeholder text

  mapCanvas = document.createElement('canvas');
  mapCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  wrap.appendChild(mapCanvas);
  mapCtx = mapCanvas.getContext('2d');

  resizeMapCanvas();
  window.addEventListener('resize', resizeMapCanvas);

  // Mouse interactions
  wrap.addEventListener('mousedown',   onMapMouseDown);
  wrap.addEventListener('mousemove',   onMapMouseMove);
  wrap.addEventListener('mouseup',     onMapMouseUp);
  wrap.addEventListener('mouseleave',  onMapMouseUp);
  wrap.addEventListener('wheel',       onMapWheel, { passive: false });
  // Touch support
  wrap.addEventListener('touchstart',  onMapTouchStart, { passive: false });
  wrap.addEventListener('touchmove',   onMapTouchMove,  { passive: false });
  wrap.addEventListener('touchend',    onMapTouchEnd);

  buildPresets();
}

function resizeMapCanvas() {
  if (!mapCanvas) return;
  const wrap = document.getElementById('amr-map-wrap');
  mapCanvas.width  = wrap.clientWidth;
  mapCanvas.height = wrap.clientHeight;
  redrawMap();
}

function fitMapToCanvas() {
  if (!mapCanvas || !mapWidth || !mapHeight) return;
  const cw = mapCanvas.width, ch = mapCanvas.height;
  const scaleX = cw / (mapWidth  * mapResolution);
  const scaleY = ch / (mapHeight * mapResolution);
  mapScale = Math.min(scaleX, scaleY) * 0.9;
  // Centre the map
  mapPanOffset.x = (cw  - mapWidth  * mapResolution * mapScale) / 2;
  mapPanOffset.y = (ch  - mapHeight * mapResolution * mapScale) / 2;
}

// â”€â”€ Coordinate conversion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function worldToCanvas(wx, wy) {
  const cx = (wx - mapOriginX) * mapScale + mapPanOffset.x;
  const cy = (mapHeight * mapResolution - (wy - mapOriginY)) * mapScale + mapPanOffset.y;
  return { x: cx, y: cy };
}

function canvasToWorld(cx, cy) {
  const wx = (cx - mapPanOffset.x) / mapScale + mapOriginX;
  const wy = mapOriginY + mapHeight * mapResolution - (cy - mapPanOffset.y) / mapScale;
  return { x: wx, y: wy };
}

// â”€â”€ Map drawing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let rafPending = false;
function redrawMap() {
  if (!mapCtx || rafPending) return;
  rafPending = true;
  requestAnimationFrame(_doRedraw);
}

function _doRedraw() {
  rafPending = false;
  const W = mapCanvas.width, H = mapCanvas.height;
  mapCtx.clearRect(0, 0, W, H);
  mapCtx.fillStyle = '#1a2535';
  mapCtx.fillRect(0, 0, W, H);

  if (occupancyCachedCanvas) drawOccupancyGrid();
  if (histVisible   && poseHistory.length > 1) drawPoseHistory();
  if (pathVisible   && globalPath.length  > 1) drawGlobalPath();
  if (lidarVisible  && lidarPoints.length  > 0) drawLiDAR();
  drawWaypointMarkers();
  drawGoalArrow();
  if (robotX !== null) drawRobot();
  if (isDragging && dragStart && dragCurrent) drawDragArrow();
  if (initPosePending && dragStart && dragCurrent) drawInitialPoseMarker();
}

function buildOccupancyCache() {
  if (!occupancyData || !mapWidth || !mapHeight) return;
  occupancyCachedCanvas = document.createElement('canvas');
  occupancyCachedCanvas.width  = mapWidth;
  occupancyCachedCanvas.height = mapHeight;
  const octx = occupancyCachedCanvas.getContext('2d');
  const img  = octx.createImageData(mapWidth, mapHeight);
  for (let gy = 0; gy < mapHeight; gy++) {
    for (let gx = 0; gx < mapWidth; gx++) {
      const val = occupancyData[gy * mapWidth + gx];
      let r, g, b, a;
      if (val === -1)      { r=80;  g=90;  b=100; a=200; }
      else if (val === 0)  { r=230; g=235; b=240; a=255; }
      else                 { r=20;  g=25;  b=30;  a=255; }
      const pi = ((mapHeight - 1 - gy) * mapWidth + gx) * 4;
      img.data[pi]   = r;
      img.data[pi+1] = g;
      img.data[pi+2] = b;
      img.data[pi+3] = a;
    }
  }
  octx.putImageData(img, 0, 0);
}

function drawOccupancyGrid() {
  if (!occupancyCachedCanvas) return;
  const ctx = mapCtx;
  const dw  = mapWidth  * mapResolution * mapScale;
  const dh  = mapHeight * mapResolution * mapScale;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(occupancyCachedCanvas, mapPanOffset.x, mapPanOffset.y, dw, dh);
  ctx.imageSmoothingEnabled = true;
}

function drawPoseHistory() {
  const ctx = mapCtx;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(52,152,219,0.5)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  const p0 = worldToCanvas(poseHistory[0].x, poseHistory[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < poseHistory.length; i++) {
    const p = worldToCanvas(poseHistory[i].x, poseHistory[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawGlobalPath() {
  const ctx = mapCtx;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(46,204,113,0.75)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  const p0 = worldToCanvas(globalPath[0].x, globalPath[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < globalPath.length; i++) {
    const p = worldToCanvas(globalPath[i].x, globalPath[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawLiDAR() {
  const ctx = mapCtx;
  ctx.fillStyle = 'rgba(231,76,60,0.65)';
  const dotR = Math.max(1.5, mapScale * mapResolution * 0.7);
  for (const pt of lidarPoints) {
    const c = worldToCanvas(pt.x, pt.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRobot() {
  if (robotX === null || robotY === null || robotYaw === null) return;
  const ctx = mapCtx;
  const c = worldToCanvas(robotX, robotY);
  const r = Math.max(8, mapScale * 0.18);

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(-robotYaw);  // canvas Y is inverted

  // Body
  ctx.fillStyle = '#34495e';
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth = 1.5;
  const bw = r * 1.8, bh = r * 2.0;
  ctx.beginPath();
  ctx.roundRect(-bw/2, -bh/2, bw, bh, r*0.15);
  ctx.fill(); ctx.stroke();

  // Direction arrow
  ctx.fillStyle = '#f1c40f';
  ctx.beginPath();
  ctx.moveTo(bw/2 + r*0.2, 0);
  ctx.lineTo(bw/2 - r*0.25, -r*0.35);
  ctx.lineTo(bw/2 - r*0.25,  r*0.35);
  ctx.closePath();
  ctx.fill();

  // LiDAR dome
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-r*0.15, 0, r*0.3, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#f1c40f';
  ctx.beginPath(); ctx.arc(-r*0.15, 0, r*0.12, 0, Math.PI*2); ctx.fill();

  ctx.restore();
}

function drawWaypointMarkers() {
  const ctx = mapCtx;
  // Presets
  PRESETS.forEach((p, i) => {
    const c = worldToCanvas(p.x, p.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 7, 0, Math.PI*2);
    ctx.fillStyle = p.color + 'cc';
    ctx.fill();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // Mission waypoints
  missionWaypoints.forEach((wp, i) => {
    const c = worldToCanvas(wp.x, wp.y);
    const done = missionActive && i < missionIndex;
    const active = missionActive && i === missionIndex;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 8, 0, Math.PI*2);
    ctx.fillStyle = done ? 'rgba(74,98,120,0.6)' : active ? 'rgba(46,204,113,0.85)' : 'rgba(245,166,35,0.85)';
    ctx.fill();
    ctx.strokeStyle = active ? '#2ecc71' : '#f5a623';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Number label
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.max(8, mapScale*0.12)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, c.x, c.y);

    // Orientation arrow if yaw defined
    if (wp.yaw !== undefined) {
      const len = 14;
      const ex = c.x + len * Math.cos(-wp.yaw);
      const ey = c.y + len * Math.sin(-wp.yaw);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = active ? '#2ecc71' : '#f5a623';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });

  // Shelf mapping points (saved from DB)
  squareWaypoints.forEach((wp, i) => {
    const c = worldToCanvas(wp.x, wp.y);
    ctx.beginPath();
    ctx.rect(c.x - 8, c.y - 8, 16, 16);
    ctx.fillStyle = 'rgba(155, 89, 182, 0.25)';
    ctx.fill();
    ctx.strokeStyle = '#8e44ad';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#8e44ad';
    ctx.font = `bold ${Math.max(8, mapScale*0.11)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`S${i + 1}`, c.x, c.y - 10);
  });

  // Draft shelf points (not saved yet)
  draftWaypoints.forEach((wp, i) => {
    const c = worldToCanvas(wp.x, wp.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52, 152, 219, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#3498db';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#3498db';
    ctx.font = `bold ${Math.max(8, mapScale*0.11)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`D${i + 1}`, c.x, c.y - 10);
  });
}

function drawGoalArrow() {
  if (goalX === null || navState !== 'NAVIGATING') return;
  const ctx = mapCtx;
  const c = worldToCanvas(goalX, goalY);
  ctx.beginPath();
  ctx.arc(c.x, c.y, 9, 0, Math.PI*2);
  ctx.strokeStyle = '#9b59b6';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawDragArrow() {
  if (!dragStart || !dragCurrent) return;
  const ctx = mapCtx;
  const s = worldToCanvas(dragStart.x, dragStart.y);
  const e = worldToCanvas(dragCurrent.x, dragCurrent.y);
  const angle = Math.atan2(e.y - s.y, e.x - s.x);
  const len = Math.sqrt((e.x-s.x)**2 + (e.y-s.y)**2);

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(angle);

  // Shaft
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len - 8, 0);
  ctx.strokeStyle = '#9b59b6';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(len, 0);
  ctx.lineTo(len - 10, -5);
  ctx.lineTo(len - 10,  5);
  ctx.closePath();
  ctx.fillStyle = '#9b59b6';
  ctx.fill();

  // Origin dot
  ctx.restore();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 5, 0, Math.PI*2);
  ctx.fillStyle = '#9b59b6';
  ctx.fill();
}

function drawInitialPoseMarker() {
  if (!dragStart || !dragCurrent) return;
  const ctx = mapCtx;
  const s = worldToCanvas(dragStart.x, dragStart.y);
  const e = worldToCanvas(dragCurrent.x, dragCurrent.y);
  const angle = Math.atan2(e.y - s.y, e.x - s.x);
  const len = Math.sqrt((e.x - s.x) ** 2 + (e.y - s.y) ** 2);

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len - 8, 0);
  ctx.strokeStyle = '#2ecc71';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(len, 0);
  ctx.lineTo(len - 11, -6);
  ctx.lineTo(len - 11,  6);
  ctx.closePath();
  ctx.fillStyle = '#2ecc71';
  ctx.fill();

  ctx.restore();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#2ecc71';
  ctx.fill();
}

// â”€â”€ Map mouse / touch handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getCanvasPos(e) {
  const rect = mapCanvas.getBoundingClientRect();
  const touch = e.touches ? e.touches[0] : e;
  return {
    x: (touch.clientX - rect.left) * (mapCanvas.width  / rect.width),
    y: (touch.clientY - rect.top)  * (mapCanvas.height / rect.height),
  };
}

function onMapMouseDown(e) {
  e.preventDefault();
  const cp = getCanvasPos(e);
  const wp = canvasToWorld(cp.x, cp.y);

  // Shelf point mode should capture click-to-save regardless of active map tool.
  if (isMultiWpMode) {
    draftWaypoints.push({ x: wp.x, y: wp.y, yaw: 0 });
    updateDynamicWaypointsList();
    redrawMap();
    toast(`Draft shelf point added (${wp.x.toFixed(2)}, ${wp.y.toFixed(2)})`, 'ok');
    return;
  }

  if (activeTool === 'pan' || e.button === 1) {
    isPanning = true;
    panStart = { x: e.clientX - mapPanOffset.x, y: e.clientY - mapPanOffset.y };
    return;
  }
  if (activeTool === 'nav') {
    isDragging = true;
    dragStart   = { x: wp.x, y: wp.y };
    dragCurrent = { x: wp.x, y: wp.y };
    return;
  }
  if (activeTool === 'wp') {
    // Single click adds waypoint
    addMissionWaypoint(wp.x, wp.y, 0);
    redrawMap();
    return;
  }

  if (activeTool === 'init') {
    isDragging = true;
    initPosePending = true;
    dragStart = { x: wp.x, y: wp.y };
    dragCurrent = { x: wp.x, y: wp.y };
    redrawMap();
    return;
  }

}

function onMapMouseMove(e) {
  if (!mapCanvas) return;
  const cp = getCanvasPos(e);
  const wp = canvasToWorld(cp.x, cp.y);
  document.getElementById('map-coord-cur').textContent =
    `Map X: ${wp.x.toFixed(3)} Â· Y: ${wp.y.toFixed(3)}`;

  if (isPanning) {
    mapPanOffset.x = e.clientX - panStart.x;
    mapPanOffset.y = e.clientY - panStart.y;
    redrawMap();
    return;
  }
  if (isDragging && activeTool === 'nav') {
    dragCurrent = { x: wp.x, y: wp.y };
    redrawMap();
  }
  if (isDragging && activeTool === 'init') {
    dragCurrent = { x: wp.x, y: wp.y };
    redrawMap();
  }
}

function onMapMouseUp(e) {
  if (isPanning) { isPanning = false; return; }
  if (isDragging && activeTool === 'init') {
    isDragging = false;
    if (dragStart && dragCurrent) {
      const dx = dragCurrent.x - dragStart.x;
      const dy = dragCurrent.y - dragStart.y;
      const yaw = Math.hypot(dx, dy) < 0.02 ? (Number.isFinite(robotYaw) ? robotYaw : 0) : Math.atan2(dy, dx);
      publishInitialPose(dragStart.x, dragStart.y, yaw);
    }
    initPosePending = false;
    dragStart = null;
    dragCurrent = null;
    activeTool = 'nav';
    setTool('nav');
    redrawMap();
    return;
  }
  if (isDragging && activeTool === 'nav') {
    isDragging = false;
    if (dragStart) {
      const dx = dragCurrent.x - dragStart.x;
      const dy = dragCurrent.y - dragStart.y;
      const yaw = Math.atan2(dy, dx);   // ROS uses CCW
      sendNavGoal(dragStart.x, dragStart.y, yaw);
      dragStart = null; dragCurrent = null;
    }
    redrawMap();
  }
}

function onMapWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  mapZoom(factor, getCanvasPos(e));
}

function onMapTouchStart(e) { e.preventDefault(); onMapMouseDown(e); }
function onMapTouchMove(e)  { e.preventDefault(); onMapMouseMove(e); }
function onMapTouchEnd(e)   { onMapMouseUp(e); }

// â”€â”€ Map utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function mapZoom(factor, about) {
  const cx = about ? about.x : mapCanvas.width  / 2;
  const cy = about ? about.y : mapCanvas.height / 2;
  mapPanOffset.x = cx - (cx - mapPanOffset.x) * factor;
  mapPanOffset.y = cy - (cy - mapPanOffset.y) * factor;
  mapScale *= factor;
  redrawMap();
}

function mapResetView() { fitMapToCanvas(); redrawMap(); }

function setTool(tool) {
  activeTool = tool;
  ['nav','wp','pan','init'].forEach(t => {
    const btn = document.getElementById('tool-' + t);
    if (btn) btn.classList.toggle('active', t === tool);
  });
  const hints = {
    nav:  'Click & drag on map to set goal + orientation',
    wp:   'Click map to add mission waypoints',
    pan:  'Click & drag to pan the map view',
    init: 'Click-drag on the map like RViz: origin = robot position, arrow = robot heading',
  };
  document.getElementById('map-hint').textContent = hints[tool];
  if (mapCanvas) mapCanvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
}

function toggleLayer(layer, on) {
  if (layer === 'lidar') lidarVisible = on;
  if (layer === 'path')  pathVisible  = on;
  if (layer === 'hist')  histVisible  = on;
  redrawMap();
}

// â”€â”€ SLAM Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function applyMapMsg(msg) {
  if (!mapLoadExpected) { console.log('[MAP] Ignored (no load requested yet)'); return; }
  const dimChanged = (msg.info.width !== mapWidth || msg.info.height !== mapHeight);
  mapResolution = msg.info.resolution;
  mapWidth      = msg.info.width;
  mapHeight     = msg.info.height;
  mapOriginX    = msg.info.origin.position.x;
  mapOriginY    = msg.info.origin.position.y;
  occupancyData = new Int8Array(msg.data);
  buildOccupancyCache();
  if (dimChanged) fitMapToCanvas();
  redrawMap();
  document.getElementById('map-overlay-msg').style.display = 'none';
}

function startSlamMapPolling() {
  console.log('[SLAM] Using live /map updates from rosbridge');
  mapLoadExpected = true;
  occupancyData = null;
  occupancyCachedCanvas = null;
  redrawMap();
  const overlay = document.getElementById('map-overlay-msg');
  if (overlay) overlay.style.display = 'none';
}

function stopSlamMapPolling() {
  console.log('[SLAM] Stopped live map view updates');
}

function listMaps() {
  console.log('[SLAM] listMaps() clicked', {
    rosConnected,
    hasRos: !!ros,
    hasTopicSlamCmd: !!topicSlamCmd,
    activeRobotCode,
  });
  if (!rosConnected) {
    toast('Not connected to ROS', 'err');
    return;
  }
  console.log('[SLAM] listMaps() â€” requesting via ROS topic');
  requestSlamMapList();
}

function loadMap() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  const sel = document.getElementById('slam-map-select');
  const mapname = sel.value;
  if (!mapname) { toast('Select a map first', 'err'); return; }

  // Start a new guarded load request and clear stale visuals immediately.
  mapLoadRequestToken += 1;
  mapSwitchInProgress = true;
  mapSwitchNavConfirmed = false;
  mapSwitchHasMapFrame = false;
  if (mapSwitchMapFrameTimer) {
    clearTimeout(mapSwitchMapFrameTimer);
    mapSwitchMapFrameTimer = null;
  }
  mapSwitchTargetName = mapname;
  mapLoadExpected = true;
  localizationReady = false;
  localizationRequested = false;
  initPosePending = false;
  isDragging = false;
  dragStart = null;
  dragCurrent = null;
  if (localizationWaitTimer) {
    clearTimeout(localizationWaitTimer);
    localizationWaitTimer = null;
  }
  occupancyData = null;
  occupancyCachedCanvas = null;
  lidarPoints = [];
  globalPath = [];
  redrawMap();

  const overlay = document.getElementById('map-overlay-msg');
  if (overlay) overlay.style.display = 'flex';
  setMapListMeta('Loading map "' + mapname + '"â€¦');

  topicSlamCmd.publish(new ROSLIB.Message({ data: 'load_map:' + mapname }));
  toast('Loading map "' + mapname + '"â€¦');

  // Wait for /map topic to deliver the newly loaded map.
  if (mapSwitchTimeoutTimer) clearTimeout(mapSwitchTimeoutTimer);
  const token = mapLoadRequestToken;
  mapSwitchTimeoutTimer = setTimeout(() => {
    if (!mapSwitchInProgress || token !== mapLoadRequestToken) return;
    mapSwitchInProgress = false;
    mapSwitchNavConfirmed = false;
    mapSwitchHasMapFrame = false;
    if (mapSwitchMapFrameTimer) {
      clearTimeout(mapSwitchMapFrameTimer);
      mapSwitchMapFrameTimer = null;
    }
    setMapListMeta('Timed out waiting for /map after loading "' + mapname + '"', true);
    toast('Map switch timed out. Check Nav2/map_server status.', 'err');
  }, 15000);
}

function stopNav() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  console.log('[SLAM] Sending command: stop_nav (current state:', slamState, ')');
  topicSlamCmd.publish(new ROSLIB.Message({ data: 'stop_nav' }));
  toast('Stopping navigationâ€¦');
}

function startSlam() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (slamState === 'MAPPING') { toast('SLAM already running', 'err'); return; }
  mapLoadExpected = true;
  console.log('[SLAM] Sending command: start_slam');
  topicSlamCmd.publish(new ROSLIB.Message({ data: 'start_slam' }));
  toast('Starting SLAMâ€¦');
  // Start live map view after a short startup delay
  setTimeout(startSlamMapPolling, 3000);
}

function stopSlam() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  console.log('[SLAM] Sending command: stop_slam (current state:', slamState, ')');
  stopSlamMapPolling();
  topicSlamCmd.publish(new ROSLIB.Message({ data: 'stop_slam' }));
  toast('Stopping SLAMâ€¦');
}

function saveMap() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (slamState !== 'MAPPING') { toast('Start SLAM first before saving', 'err'); return; }
  const name = document.getElementById('slam-map-name').value.trim();
  if (!name) { toast('Enter a map name', 'err'); return; }
  console.log('[SLAM] Sending command: save_map:' + name, '(state:', slamState, ')');
  topicSlamCmd.publish(new ROSLIB.Message({ data: 'save_map:' + name }));
  toast('Saving map "' + name + '"â€¦');
}

function setMapListMeta(text, isError = false) {
  const el = document.getElementById('slam-map-list-meta');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--red)' : 'var(--muted)';
}

function parseMapListPayload(payload) {
  console.log('[SLAM] ðŸ” parseMapListPayload() START - input:', payload);
  const queue = [payload];
  let depth = 0;
  while (queue.length) {
    const v = queue.shift();
    depth++;
    console.log(`[SLAM]   [depth ${depth}] value:`, v, 'type:', typeof v);
    if (v == null) continue;

    if (Array.isArray(v)) {
      const result = v
        .map(x => String(x ?? '').trim())
        .filter(Boolean);
      console.log('[SLAM] âœ“ Found array result:', result);
      return result;
    }

    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      try {
        console.log('[SLAM]   Trying JSON.parse on string:', s);
        queue.push(JSON.parse(s));
        continue;
      } catch (e) {
        console.log('[SLAM]   JSON.parse failed:', e.message, '- trying fallback parsing');
        const cleaned = s.replace(/^\[/, '').replace(/\]$/, '');
        const parts = cleaned.split(/[\n,]/)
          .map(p => p.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
          .filter(Boolean);
        if (parts.length) {
          console.log('[SLAM] âœ“ Found fallback result:', parts);
          return parts;
        }
      }
      continue;
    }

    if (typeof v === 'object') {
      console.log('[SLAM]   Object detected. Keys:', Object.keys(v));
      if (Array.isArray(v.maps)) {
        const result = v.maps.map(x => String(x ?? '').trim()).filter(Boolean);
        console.log('[SLAM] âœ“ Found v.maps result:', result);
        return result;
      }
      if (Array.isArray(v.list)) {
        const result = v.list.map(x => String(x ?? '').trim()).filter(Boolean);
        console.log('[SLAM] âœ“ Found v.list result:', result);
        return result;
      }
      if ('data' in v) {
        console.log('[SLAM]   Found .data field, unwrapping...');
        queue.push(v.data);
      }
      if ('msg' in v) {
        console.log('[SLAM]   Found .msg field, unwrapping...');
        queue.push(v.msg);
      }
      if ('value' in v) {
        console.log('[SLAM]   Found .value field, unwrapping...');
        queue.push(v.value);
      }
    }
  }
  console.log('[SLAM] âœ— parseMapListPayload() - No valid format found, returning []');
  return [];
}

function populateMapList(rawPayload, source = '') {
  console.log('[SLAM] ðŸ“ populateMapList() START - source:', source);
  const maps = parseMapListPayload(rawPayload);
  console.log('[SLAM] ðŸ“ parseMapListPayload returned:', maps, 'count:', maps.length);
  mapListLoaded = true;
  const sel = document.getElementById('slam-map-select');
  if (!sel) {
    console.log('[SLAM] âœ— Select element #slam-map-select not found!');
    return;
  }
  const prev = sel.value;
  console.log('[SLAM] ðŸ“ Previous selection:', prev);
  sel.innerHTML = maps.length
    ? maps.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
    : '<option value="">â€” no saved maps â€”</option>';
  console.log('[SLAM] ðŸ“ Dropdown updated with', maps.length, 'options');
  // Restore previous selection if still available
  if (prev && maps.includes(prev)) sel.value = prev;
  if (maps.length) {
    console.log('[SLAM] âœ“ SUCCESS - Found', maps.length, 'map(s):', maps);
    setMapListMeta((source ? source + ': ' : '') + maps.length + ' map(s) found');
  } else {
    console.log('[SLAM] âœ— No maps found');
    setMapListMeta((source ? source + ': ' : '') + 'No saved maps received yet');
  }
}

function updateSlamUI(state) {
  slamState = state;
  const badge   = document.getElementById('slam-mode-badge');
  const startB  = document.getElementById('slam-start-btn');
  const stopB   = document.getElementById('slam-stop-btn');
  const saveB   = document.getElementById('slam-save-btn');
  const loadB   = document.getElementById('slam-load-btn');
  const stopNB  = document.getElementById('slam-stopnav-btn');
  const statusT = document.getElementById('slam-status-text');

  const isMapping  = state === 'MAPPING';
  const isSaving   = state === 'SAVING';
  const isNav      = state.startsWith('NAV:');
  const isLoading  = state.startsWith('LOADING:');
  const isSaved    = state.startsWith('SAVED:');
  const isError    = state.startsWith('ERROR:');
  const isBusy     = isSaving || isLoading;
  if (mapSwitchInProgress && isNav) {
    const requestedNorm = normalizeMapName(mapSwitchTargetName);
    const navMapRaw = navStateMapName(state);
    const navNorm = normalizeMapName(navMapRaw);
    const nameMatches = requestedNorm && navNorm && requestedNorm === navNorm;

    mapSwitchNavConfirmed = true;
    if (mapSwitchHasMapFrame) {
      if (nameMatches) {
        completeMapSwitch('Loaded map "' + mapSwitchTargetName + '"');
      } else {
        completeMapSwitch(
          'Loaded /map, but Nav reports "' + (navMapRaw || '?') + '" (requested "' + mapSwitchTargetName + '")'
        );
      }
    } else {
      if (nameMatches) {
        setMapListMeta('Nav started for "' + mapSwitchTargetName + '", waiting for /mapâ€¦');
      } else {
        setMapListMeta(
          'Nav started with "' + (navMapRaw || '?') + '"; waiting for /mapâ€¦',
          true
        );
      }
    }
  }
  if (mapSwitchInProgress && isError) {
    mapSwitchInProgress = false;
    mapSwitchNavConfirmed = false;
    mapSwitchHasMapFrame = false;
    if (mapSwitchMapFrameTimer) {
      clearTimeout(mapSwitchMapFrameTimer);
      mapSwitchMapFrameTimer = null;
    }
    if (mapSwitchTimeoutTimer) {
      clearTimeout(mapSwitchTimeoutTimer);
      mapSwitchTimeoutTimer = null;
    }
    setMapListMeta('Map load failed: ' + state.substring(6), true);
  }

  // SLAM process may still be running during SAVING, SAVED, and ERROR states
  const slamActive = isMapping || isSaving || isSaved || isError;

  // Badge
  if (isMapping)        { badge.textContent = 'MAPPING';    badge.className = 'ns-val nav'; }
  else if (isLoading)   { badge.textContent = 'LOADING';    badge.className = 'ns-val nav'; }
  else if (isNav)       { badge.textContent = 'NAVIGATING'; badge.className = 'ns-val ok'; }
  else if (isSaving)    { badge.textContent = 'SAVING';     badge.className = 'ns-val nav'; }
  else if (isSaved)     { badge.textContent = 'SAVED';      badge.className = 'ns-val ok'; }
  else if (isError)     { badge.textContent = 'ERROR';      badge.className = 'ns-val err'; }
  else                  { badge.textContent = 'IDLE';       badge.className = 'ns-val idle'; }

  // SLAM buttons
  startB.disabled = slamActive || isBusy || isNav || isLoading;
  stopB.disabled  = !slamActive;   // enabled during MAPPING, SAVING, SAVED, ERROR
  saveB.disabled  = !isMapping;    // only during active MAPPING

  // Navigation buttons
  loadB.disabled  = slamActive || isBusy || isLoading;
  stopNB.disabled = !isNav && !isLoading;

  // Disable nav auto-mode while SLAM is mapping
  const navMode = document.getElementById('amr-mode-auto');
  if (navMode) navMode.disabled = isMapping;

  // Status text
  if (isNav)                            statusT.textContent = 'ðŸ—ºï¸ Navigating with map: ' + state.substring(4);
  else if (isLoading)                   statusT.textContent = 'â³ Loading map: ' + state.substring(8) + 'â€¦';
  else if (state.startsWith('SAVED:'))  statusT.textContent = 'âœ“ Map saved: ' + state.substring(6);
  else if (state.startsWith('ERROR:'))  statusT.textContent = 'âœ— ' + state.substring(6);
  else if (isMapping)                   statusT.textContent = 'SLAM active â€” drive the robot to build the map';
  else if (isSaving)                    statusT.textContent = 'Saving mapâ€¦';
  else                                  statusT.textContent = '';
}

// â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function sendNavGoal(x, y, yaw) {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (amrMode !== 'auto') { toast('Switch to Auto Mode to navigate', 'err'); return; }
  if (!localizationReady) {
    toast('Localization not ready. Load map, then click Set Initial Pose.', 'err');
    return;
  }

  const qz = Math.sin(yaw / 2), qw = Math.cos(yaw / 2);
  topicGoal.publish(new ROSLIB.Message({
    header: { frame_id: 'map' },
    pose: {
      position: { x, y, z: 0 },
      orientation: { x: 0, y: 0, z: qz, w: qw }
    }
  }));

  goalX = x; goalY = y;
  goalInitX = robotX; // for progress calc
  goalInitY = robotY; // for progress calc
  setNavState('NAVIGATING');
  document.getElementById('ns-gx').textContent = x.toFixed(3);
  document.getElementById('ns-gy').textContent = y.toFixed(3);
}

function setNavState(state) {
  navState = state;
  const el = document.getElementById('nav-state-badge');
  el.textContent = state;
  el.className = 'ns-val ' + state.toLowerCase();
  updateNavStatus();
}

function updateNavStatus() {
  if (robotX !== null && robotY !== null) {
    document.getElementById('map-coord-robot').textContent =
      `Robot: ${robotX.toFixed(3)} Â· ${robotY.toFixed(3)}  Â·  Yaw: ${(robotYaw*180/Math.PI).toFixed(1)}Â°`;
  }
  if (goalX !== null && robotX !== null) {
    const dist = Math.sqrt((goalX-robotX)**2 + (goalY-robotY)**2);
    document.getElementById('ns-dist').textContent = dist.toFixed(2) + ' m';
    // Simple progress: % of initial distance covered
    if (goalInitX !== null && goalInitY !== null) {
      const initDist = Math.sqrt((goalX-goalInitX)**2 + (goalY-goalInitY)**2) || dist;
      const prog = Math.max(0, Math.min(100, (1 - dist / Math.max(initDist, 0.01)) * 100));
      document.getElementById('ns-prog').textContent = prog.toFixed(0) + '%';
    }
  }
}

function publishInitialPose(x, y, yaw) {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (!occupancyData) {
    toast('Load map first before localizing', 'err');
    return;
  }

  localizationReady = false;
  localizationRequested = true;
  if (localizationWaitTimer) clearTimeout(localizationWaitTimer);

  const qz = Math.sin(yaw / 2), qw = Math.cos(yaw / 2);
  topicInitPose.publish(new ROSLIB.Message({
    header: { frame_id: 'map' },
    pose: {
      pose: {
        position: { x, y, z: 0 },
        orientation: { x: 0, y: 0, z: qz, w: qw }
      },
      covariance: [0.25,0,0,0,0,0, 0,0.25,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0.3]
    }
  }));

  // Do not override the robot position in the UI until AMCL publishes the new pose.
  updateNavStatus();
  redrawMap();

  localizationWaitTimer = setTimeout(() => {
    if (!localizationReady) {
      localizationRequested = false;
      toast('Localization timeout: AMCL pose not received yet.', 'err');
    }
  }, 12000);

  toast('Initial pose sent. Waiting for AMCL localizationâ€¦', 'ok');
}

function setInitialPose() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (!occupancyData) {
    toast('Load map first before localizing', 'err');
    return;
  }
  initPosePending = false;
  dragStart = null;
  dragCurrent = null;
  setTool('init');
  toast('Click-drag on the map to set the initial pose like RViz', 'ok');
}

// â”€â”€ Emergency stop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function emergencyStop() {
  if (teleopInterval) { clearInterval(teleopInterval); teleopInterval = null; }
  missionActive = false;
  missionIndex  = 0;
  setNavState('IDLE');
  goalX = null; goalY = null;
  globalPath = [];

  if (rosConnected) {
    const zero = new ROSLIB.Message({ linear:{x:0,y:0,z:0}, angular:{x:0,y:0,z:0} });
    updatePidTargetsFromCmd(0, 0);
    for (let i = 0; i < 5; i++) setTimeout(() => topicCmdVel.publish(zero), i * 50);
  }
  toast('â›” EMERGENCY STOP â€” Robot halted', 'err');
  redrawMap();
}

// â”€â”€ Teleop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function teleopStart(linDir, angDir) {
  if (amrMode !== 'manual') { toast('Switch to Manual Mode', 'err'); return; }
  if (!rosConnected) return;
  const lin = parseFloat(document.getElementById('sl-linear').value);
  const ang = parseFloat(document.getElementById('sl-angular').value);
  teleopLinear  = lin * linDir;
  teleopAngular = ang * angDir;
  if (teleopInterval) clearInterval(teleopInterval);
  teleopInterval = setInterval(() => {
    updatePidTargetsFromCmd(teleopLinear, teleopAngular);
    topicCmdVel.publish(new ROSLIB.Message({
      linear:  { x: teleopLinear,  y: 0, z: 0 },
      angular: { x: 0, y: 0,       z: teleopAngular }
    }));
  }, 100);
}

function teleopStop() {
  clearInterval(teleopInterval); teleopInterval = null;
  if (rosConnected) {
    updatePidTargetsFromCmd(0, 0);
    topicCmdVel.publish(new ROSLIB.Message({ linear:{x:0,y:0,z:0}, angular:{x:0,y:0,z:0} }));
  }
}

function updatePidTargetsFromCmd(v, w) {
  pidTarL = v - (w * WHEEL_BASE / 2);
  pidTarR = v + (w * WHEEL_BASE / 2);
}

function updateSpeedLabel() {
  document.getElementById('lbl-linear').textContent  = parseFloat(document.getElementById('sl-linear').value).toFixed(2);
  document.getElementById('lbl-angular').textContent = parseFloat(document.getElementById('sl-angular').value).toFixed(2);
}

// â”€â”€ Mode switching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function setMode(mode) {
  amrMode = mode;
  document.getElementById('mode-manual-btn').className = 'mode-btn' + (mode==='manual' ? ' active-manual' : '');
  document.getElementById('mode-auto-btn').className   = 'mode-btn' + (mode==='auto'   ? ' active-auto'   : '');
  document.getElementById('teleop-mode-lbl').textContent = mode === 'manual' ? 'ACTIVE' : 'DISABLED';
  document.getElementById('teleop-mode-lbl').style.color = mode === 'manual' ? 'var(--green)' : 'var(--red)';

  // Disable teleop buttons when in auto mode
  const tBtns = document.querySelectorAll('.t-btn');
  tBtns.forEach(b => { b.disabled = (mode === 'auto'); });

  if (mode === 'manual') teleopStop();
  toast(mode === 'manual' ? 'ðŸŽ® Manual Mode active' : 'ðŸ¤– Auto Navigation active', 'ok');
}

// â”€â”€ Mission planner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function addMissionWaypoint(x, y, yaw = 0) {
  missionWaypoints.push({ x, y, yaw });
  renderWaypointList();
}

function clearWaypoints() {
  missionWaypoints = [];
  missionActive = false;
  missionIndex  = 0;
  renderWaypointList();
  redrawMap();
  setNavState('IDLE');
}

function renderWaypointList() {
  const list = document.getElementById('wp-list');
  document.getElementById('wp-count-lbl').textContent = missionWaypoints.length + ' point' + (missionWaypoints.length !== 1 ? 's' : '');
  if (!missionWaypoints.length) {
    list.innerHTML = `<div style="text-align:center;padding:16px;color:var(--muted);font-family:var(--mono);font-size:10px">Switch to ðŸ“Œ Add Waypoint mode then click the map</div>`;
    return;
  }
  list.innerHTML = missionWaypoints.map((wp, i) => {
    const done   = missionActive && i < missionIndex;
    const active = missionActive && i === missionIndex;
    return `<div class="wp-item${active?' active-wp':''}${done?' done-wp':''}">
      <div class="wp-num">${i+1}</div>
      <div class="wp-coords">X ${wp.x.toFixed(2)} Â· Y ${wp.y.toFixed(2)}</div>
      <button class="wp-del" onclick="removeMissionWaypoint(${i})" title="Remove">âœ•</button>
    </div>`;
  }).join('');
}

function removeMissionWaypoint(i) {
  missionWaypoints.splice(i, 1);
  renderWaypointList();
  redrawMap();
}

function startMission() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  if (!missionWaypoints.length) { toast('No waypoints defined', 'err'); return; }
  if (amrMode !== 'auto') { setMode('auto'); }
  missionActive = true;
  missionIndex  = 0;
  document.getElementById('mission-start-btn').disabled = true;
  document.getElementById('mission-stop-btn').disabled  = false;
  renderWaypointList();
  navigateToCurrentMissionPoint();
}

function stopMission() {
  missionActive = false;
  emergencyStop();
  document.getElementById('mission-start-btn').disabled = false;
  document.getElementById('mission-stop-btn').disabled  = true;
  renderWaypointList();
}

function navigateToCurrentMissionPoint() {
  if (!missionActive || missionIndex >= missionWaypoints.length) return;
  const wp = missionWaypoints[missionIndex];
  sendNavGoal(wp.x, wp.y, wp.yaw || 0);
  renderWaypointList();
}

function advanceMission() {
  missionIndex++;
  if (missionIndex < missionWaypoints.length) {
    setTimeout(() => {
      if (missionActive) navigateToCurrentMissionPoint();
    }, 1200);
  } else {
    missionActive = false;
    setNavState('SUCCESS');
    document.getElementById('mission-start-btn').disabled = false;
    document.getElementById('mission-stop-btn').disabled  = true;
    renderWaypointList();
    toast('âœ… Mission complete â€” all waypoints reached', 'ok');
  }
}

function shelfLabelFromCode(code) {
  const s = String(code || '').trim();
  if (!s) return 'Shelf';
  const parts = s.split('_');
  return parts[0] || s;
}

function updateDynamicWaypointsList() {
  const list = document.getElementById('dynamic-waypoints-list');
  if (!list) return;

  if (!draftWaypoints.length && !squareWaypoints.length) {
    list.innerHTML = `<div style="text-align:center;padding:12px;color:var(--muted);font-family:var(--mono);font-size:10px">No shelf points yet.</div>`;
    return;
  }

  const draftHtml = draftWaypoints.map((wp, i) => `
    <div class="wp-item" style="border-left:3px solid #3498db">
      <div class="wp-num" style="background:#3498db">D${i + 1}</div>
      <div class="wp-coords">Draft Â· X ${wp.x.toFixed(2)} Â· Y ${wp.y.toFixed(2)}</div>
      <button class="wp-del" onclick="draftWaypoints.splice(${i},1);updateDynamicWaypointsList();redrawMap()" title="Remove draft">âœ•</button>
    </div>
  `).join('');

  const savedHtml = squareWaypoints.map((wp, i) => `
    <div class="wp-item" style="border-left:3px solid #8e44ad">
      <div class="wp-num" style="background:#8e44ad">S${i + 1}</div>
      <div class="wp-coords">${esc(wp.name || 'Shelf')} Â· X ${wp.x.toFixed(2)} Â· Y ${wp.y.toFixed(2)}</div>
      <div style="margin-left:auto;font-size:10px;color:var(--muted)">DB</div>
    </div>
  `).join('');

  list.innerHTML = `${draftHtml}${savedHtml}`;
}

function syncSavedShelfWaypoints(locations) {
  const next = (locations || [])
    .filter(l => l.loc_x != null && l.loc_y != null)
    .map(l => ({
      id: l.id,
      x: Number(l.loc_x),
      y: Number(l.loc_y),
      yaw: l.loc_yaw != null ? Number(l.loc_yaw) : 0,
      name: shelfLabelFromCode(l.location_code),
      code: l.location_code,
    }));
  squareWaypoints = next;
  updateDynamicWaypointsList();
  redrawMap();
}

function toggleMultiWaypointMode() {
  isMultiWpMode = !isMultiWpMode;
  const btn = document.getElementById('btn-multi-wp');
  if (btn) {
    btn.textContent = isMultiWpMode ? 'ðŸ“ Point Mode: ON (Click map)' : 'ðŸ“ 1. Enable Point Mode';
    btn.classList.toggle('amr-btn-green', isMultiWpMode);
    btn.classList.toggle('amr-btn-ghost', !isMultiWpMode);
  }
  if (isMultiWpMode && activeTool !== 'pan') {
    setTool('pan');
  }
  toast(isMultiWpMode ? 'Shelf point mode enabled' : 'Shelf point mode disabled', 'ok');
}

function clearDraftPoints() {
  draftWaypoints = [];
  updateDynamicWaypointsList();
  redrawMap();
}

async function saveAllDraftWaypoints() {
  if (!draftWaypoints.length) {
    toast('No draft shelf points to save', 'err');
    return;
  }

  const baseName = (prompt('Shelf code prefix (example: SHELF_A)') || '').trim().toUpperCase();
  if (!baseName) {
    toast('Save cancelled: shelf code prefix required', 'err');
    return;
  }

  try {
    const startIdx = _locations.length + 1;
    for (let i = 0; i < draftWaypoints.length; i++) {
      const wp = draftWaypoints[i];
      const code = `${baseName}_${String(startIdx + i).padStart(2, '0')}`;
      await api('/locations', {
        method: 'POST',
        body: JSON.stringify({
          location_code: code,
          rack: baseName,
          slot: String(startIdx + i).padStart(2, '0'),
          loc_x: wp.x,
          loc_y: wp.y,
          loc_yaw: wp.yaw || 0,
        }),
      });
    }
    draftWaypoints = [];
    await loadCrud();
    toast('Shelf points saved to Locations', 'ok');
  } catch (e) {
    console.error(e);
    toast('Failed to save shelf points: ' + e.message, 'err');
  }
}

async function clearAllSavedWaypoints() {
  if (!squareWaypoints.length) {
    clearDraftPoints();
    return;
  }

  const ok = confirm('Delete all saved shelf locations that contain map coordinates? This cannot be undone.');
  if (!ok) return;

  try {
    for (const wp of squareWaypoints) {
      await api(`/locations/${wp.id}`, { method: 'DELETE' });
    }
    draftWaypoints = [];
    squareWaypoints = [];
    await loadCrud();
    toast('Saved shelf locations removed', 'ok');
  } catch (e) {
    console.error(e);
    toast('Failed to clear saved shelves: ' + e.message, 'err');
  }
}

// â”€â”€ Preset nav buttons â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildPresets() {
  const list = document.getElementById('preset-list');
  if (!PRESETS.length) {
    list.innerHTML = `<div style="text-align:center;padding:10px;color:var(--muted);font-family:var(--mono);font-size:10px">No fixed presets. Use saved runtime points.</div>`;
    return;
  }
  list.innerHTML = PRESETS.map((p, i) => `
    <div class="wp-preset" onclick="sendNavGoal(${p.x},${p.y},${p.yaw})">
      <div class="wp-preset-dot" style="background:${p.color}"></div>
      <span>${p.name}</span>
      <span style="margin-left:auto;font-family:var(--mono);font-size:9px;color:var(--muted)">${p.x.toFixed(2)},${p.y.toFixed(2)}</span>
    </div>`).join('');
}

// â”€â”€ IMU display â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function updateIMUDisplay() {
  if (robotX !== null) {
    document.getElementById('imu-px').textContent = robotX.toFixed(3);
    document.getElementById('imu-py').textContent = robotY.toFixed(3);
  }
}

// â”€â”€ PID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function sendPID() {
  if (!rosConnected) { toast('Not connected to ROS', 'err'); return; }
  const kp = document.getElementById('pid-kp').value;
  const ki = document.getElementById('pid-ki').value;
  topicPID.publish(new ROSLIB.Message({ data: `PID,${parseFloat(kp).toFixed(2)},${parseFloat(ki).toFixed(2)}\n` }));
  toast(`PID uploaded â€” Kp=${kp} Ki=${ki}`, 'ok');
}

function pidTestRun() {
  if (amrMode !== 'manual') { toast('Switch to Manual Mode', 'err'); return; }
  const spd = parseFloat(document.getElementById('test-speed-amr').value);
  teleopStart(1, 0);
  teleopLinear = spd;
}

function pidTestStop() { teleopStop(); }

function initPIDCharts() {
  const opts = {
    animation: false, responsive: true, maintainAspectRatio: false,
    scales: {
      y: { min: -0.5, max: 0.5, grid: { color: '#1a2636' }, ticks: { color: '#4a6278', stepSize: 0.25 } },
      x: { display: false }
    },
    plugins: { legend: { display: false } },
    layout: { padding: { top: 18 } }
  };
  const mkData = () => ({
    labels: Array(MAX_CHART_PTS).fill(''),
    datasets: [
      { borderColor: '#e74c3c', data: Array(MAX_CHART_PTS).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
      { borderColor: '#3b9eff', data: Array(MAX_CHART_PTS).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
    ]
  });

  const cL = document.getElementById('chartAMR-L');
  const cR = document.getElementById('chartAMR-R');
  if (!cL || !cR) return;
  if (amrChartL) { amrChartL.destroy(); amrChartR.destroy(); }
  amrChartL = new Chart(cL.getContext('2d'), { type:'line', data: mkData(), options: opts });
  amrChartR = new Chart(cR.getContext('2d'), { type:'line', data: mkData(), options: opts });

  if (window._pidChartInterval) clearInterval(window._pidChartInterval);
  window._pidChartInterval = setInterval(() => {
    if (!amrChartL) return;
    const push = (chart, tar, act) => {
      chart.data.datasets[0].data.shift(); chart.data.datasets[0].data.push(tar);
      chart.data.datasets[1].data.shift(); chart.data.datasets[1].data.push(act);
      chart.update('none');
    };
    push(amrChartL, pidTarL, pidActL);
    push(amrChartR, pidTarR, pidActR);
  }, 100);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ORDERS â€” CRUD & PICK WORKFLOW
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
let _orders = [];
let _openOrderId = null;   // track which order detail panel is open

async function loadOrders() {
  try {
    _orders = await api('/orders');
    renderOrders(_orders);
    // If detail panel is open, silently refresh it to reflect latest statuses
    if (_openOrderId !== null) {
      const panel = document.getElementById('order-detail-panel');
      if (panel && panel.style.display !== 'none') viewOrder(_openOrderId, true);
    }
  } catch(e) { console.error('Orders load:', e); }
}

function renderOrders(data) {
  setCount('cnt-orders', data.length);
  const tb = document.getElementById('body-orders');
  if (!data.length) { emptyRow(tb, 8); return; }
  // Capture which rows were previously not COMPLETED so we can flash new completions
  const prevStatuses = {};
  tb.querySelectorAll('tr[data-order-id]').forEach(row => {
    prevStatuses[row.dataset.orderId] = row.dataset.status;
  });
  tb.innerHTML = data.map(r => {
    const pct = r.item_count ? Math.round((r.picked_count / r.item_count) * 100) : 0;
    return `<tr data-order-id="${r.id}" data-status="${r.status}">
      <td class="id">${esc(r.id)}</td>
      <td class="code" style="cursor:pointer;color:var(--blue)" onclick="viewOrder(${r.id})">${esc(r.order_code)}</td>
      <td>${esc(r.assigned_robot ?? 'â€”')}</td>
      <td><span class="order-status ${r.status}">${r.status}</span></td>
      <td>${r.picked_count}/${r.item_count}</td>
      <td><div class="order-progress"><div class="order-progress-fill" style="width:${pct}%"></div></div>${pct}%</td>
      <td class="time">${esc(r.created_at ?? 'â€”')}</td>
      <td class="acts">
        ${r.status === 'PENDING' ? `<button class="btn btn-primary btn-sm" onclick="dispatchOrder(${r.id})">â–¶ Dispatch</button>` : ''}
        ${['PENDING','COMPLETED','CANCELLED'].includes(r.status) ? `<button class="btn btn-danger btn-sm" onclick="deleteOrder(${r.id},'${esc(r.order_code)}')">Del</button>` : ''}
        ${r.status === 'IN_PROGRESS' ? `<button class="btn btn-ghost btn-sm" onclick="loadOrderToMission(${r.id})">ðŸ“ Load to AMR</button>` : ''}
        ${r.status === 'IN_PROGRESS' ? `<button class="btn btn-danger btn-sm" onclick="cancelOrder(${r.id},'${esc(r.order_code)}')">Cancel</button>` : ''}
      </td></tr>`;
  }).join('');
  // Flash rows that just became COMPLETED
  data.forEach(r => {
    if (r.status === 'COMPLETED' && prevStatuses[r.id] && prevStatuses[r.id] !== 'COMPLETED') {
      const row = tb.querySelector(`tr[data-order-id="${r.id}"]`);
      if (row) {
        row.style.transition = 'background .2s';
        row.style.background = 'rgba(46,204,113,.25)';
        setTimeout(() => { row.style.background = ''; }, 2000);
      }
    }
  });
}

async function viewOrder(oid, silent = false, silent = false) {
  try {
    _openOrderId = oid;
    const d = await api('/orders/' + oid);
    const panel = document.getElementById('order-detail-panel');
    // Title with coloured status badge
    document.getElementById('order-detail-title').innerHTML =
      `Order #${esc(String(d.id))} &mdash; ${esc(d.order_code)} <span class="order-status ${d.status}" style="margin-left:8px">${d.status}</span>`;
    let html = '';

    // Items summary
    html += `<div style="margin:12px 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Order Items</div>`;
    html += `<table style="width:100%;font-size:12px"><thead><tr><th>Product</th><th>Qty</th><th>Picked</th><th>Status</th></tr></thead><tbody>`;
    (d.items || []).forEach(it => {
      html += `<tr><td>${esc(it.product_code ?? '')} ${esc(it.product_name ?? '')}</td><td>${it.quantity}</td><td>${it.picked_qty}</td><td><span class="order-status ${it.status}">${it.status ?? 'PENDING'}</span></td></tr>`;
    });
    html += `</tbody></table>`;

    // Pick tasks route
    html += `<div style="margin:16px 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Pick Route (${(d.pick_tasks||[]).length} stops)</div>`;
    (d.pick_tasks || []).forEach(pt => {
      html += `<div class="pick-task-row">
        <div class="pick-task-seq ${pt.status}">${pt.seq}</div>
        <div class="pick-task-info">
          <div><strong>${esc(pt.location_code ?? '?')}</strong> â€” ${esc(pt.product_name ?? '')} Ã—${pt.quantity}</div>
          <div style="color:var(--muted);font-family:var(--mono);font-size:10px">
            x=${pt.nav_x?.toFixed(3)} y=${pt.nav_y?.toFixed(3)} yaw=${pt.nav_yaw?.toFixed(3)}
          </div>
        </div>
        <div class="pick-task-status"><span class="order-status ${pt.status}">${pt.status}</span></div>
      </div>`;
    });

    document.getElementById('order-detail-body').innerHTML = html;
    panel.style.display = 'block';
    if (!silent) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch(e) { if (!silent) toast(e.message, 'err'); }
}

function closeOrderDetail() {
  document.getElementById('order-detail-panel').style.display = 'none';
  _openOrderId = null;
}

/* â”€â”€ Create Order Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function openCreateOrder() {
  modalCtx = { table: '_order', mode: 'add' };
  document.getElementById('modal-title').textContent = 'Create Pick Order';
  const pOpts = _products.map(p => `<option value="${p.id}">${esc(p.product_code)} â€” ${esc(p.name ?? '')}</option>`).join('');
  const rOpts = _robots.filter(r => r.status === 'IDLE' || r.status === 'CHARGING').map(r => `<option value="${esc(r.robot_code)}">${esc(r.robot_code)} â€” ${esc(r.description ?? '')}</option>`).join('');
  document.getElementById('modal-body').innerHTML = `
    <div class="form-grid one">
      <div class="field"><label>Order Code *</label><input id="f-oc" placeholder="ORD-001"/></div>
      <div class="field"><label>Assigned Robot</label><select id="f-ar"><option value="">Auto-assign</option>${rOpts}</select></div>
    </div>
    <div style="margin:10px 0 4px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">
      Items <button class="btn btn-ghost btn-sm" onclick="addOrderItemRow()" style="margin-left:8px">+ Add Item</button>
    </div>
    <div id="order-create-items"></div>
  `;
  addOrderItemRow();
  document.getElementById('modal-save').textContent = 'Create Order';
  document.getElementById('modal-save').onclick = submitCreateOrder;
  document.getElementById('form-modal').classList.add('open');
}

let _ocItemCounter = 0;
function addOrderItemRow() {
  _ocItemCounter++;
  const pOpts = _products.map(p => `<option value="${p.id}">${esc(p.product_code)} â€” ${esc(p.name ?? '')}</option>`).join('');
  const container = document.getElementById('order-create-items');
  const row = document.createElement('div');
  row.className = 'oc-item-row';
  row.id = 'oc-row-' + _ocItemCounter;
  row.innerHTML = `
    <select class="oc-prod"><option value="">â€” product â€”</option>${pOpts}</select>
    <input type="number" class="oc-qty" min="1" value="1" placeholder="Qty"/>
    <button onclick="this.parentElement.remove()">âœ•</button>
  `;
  container.appendChild(row);
}

async function submitCreateOrder() {
  const code = getv('f-oc');
  const robot = getv('f-ar');
  if (!code) { toast('Order Code required', 'err'); return; }
  const rows = document.querySelectorAll('.oc-item-row');
  const items = [];
  for (const r of rows) {
    const pid = r.querySelector('.oc-prod').value;
    const qty = r.querySelector('.oc-qty').value;
    if (pid && qty && +qty > 0) items.push({ product_id: +pid, quantity: +qty });
  }
  if (!items.length) { toast('Add at least one item', 'err'); return; }

  try {
    await api('/orders', {
      method: 'POST',
      body: JSON.stringify({ order_code: code, assigned_robot: robot || null, items }),
    });
    toast('Order created');
    closeModal('form-modal');
    // Restore default save handler
    document.getElementById('modal-save').onclick = saveRecord;
    loadOrders();
  } catch(e) { toast(e.message, 'err'); }
}

/* â”€â”€ Dispatch & Delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function dispatchOrder(oid) {
  try {
    const d = await api('/orders/' + oid + '/dispatch', { method: 'POST' });
    toast('Order dispatched â€” ' + (d.pick_tasks?.length ?? 0) + ' pick stops');
    loadOrders();
  } catch(e) { toast(e.message, 'err'); }
}

async function deleteOrder(oid, label) {
  if (!confirm('Delete order ' + label + '?')) return;
  try {
    await api('/orders/' + oid, { method: 'DELETE' });
    toast('Order deleted');
    loadOrders();
    closeOrderDetail();
  } catch(e) { toast(e.message, 'err'); }
}

/* â”€â”€ Load order pick tasks into AMR Mission Planner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function loadOrderToMission(oid) {
  try {
    const d = await api('/orders/' + oid);
    if (!d.pick_tasks?.length) { toast('No pick tasks', 'err'); return; }
    // Clear existing waypoints and any active navigation state.
    clearWaypoints();
    goalX = null;
    goalY = null;
    goalInitX = null;
    globalPath = [];
    setNavState('IDLE');
    // Add each pick task as a waypoint for the mission planner only.
    d.pick_tasks.forEach(pt => {
      if (pt.status === 'PICKED') return; // skip already picked
      missionWaypoints.push({
        x: pt.nav_x, y: pt.nav_y, yaw: pt.nav_yaw,
        label: pt.location_code ?? ('Stop ' + pt.seq),
      });
    });
    renderWaypointList();
    redrawMap();
    // Switch to AMR tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="amr"]').classList.add('active');
    document.getElementById('tab-amr').classList.add('active');
    toast('Loaded ' + missionWaypoints.length + ' waypoints from order');
  } catch(e) { toast(e.message, 'err'); }
}

async function cancelOrder(oid, code) {
  if (!confirm(`Cancel order "${code}"? This will stop the robot and mark the order as cancelled.`)) return;
  try {
    await api('/orders/' + oid + '/cancel', { method: 'POST' });
    toast('Order cancelled');
    loadOrders();
  } catch(e) { toast(e.message, 'err'); }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SIMULATION TAB â€” Three.js + URDF
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

let simScene, simCamera, simRenderer, simControls, simClock;
let simRobotGroup = null;       // current URDF robot mesh group
let simGridHelper = null;
let simAxesHelper = null;
let simMapMesh = null;          // occupancy grid as 3D plane
let simGoalMode = false;
let simFollowing = false;
let simInitialized = false;
let simAnimating = false;
let simRaycaster, simMouse;
let simGoalMarker = null;
let simRobotMarkers = {};       // { robotCode: meshGroup }
let simFrameCount = 0;
let simLastFpsTime = 0;
const SIM_ROBOT_HEIGHT = 0.15;  // z-offset to keep robot above ground

// 3D overlay objects
let simLidarPoints = null;      // THREE.Points for LiDAR cloud
let simPathLine = null;         // THREE.Line for nav path
let simWaypointMarkers = [];    // array of THREE.Mesh for mission waypoints
let simLidarOn = true, simPathOn = true, simWaypointsOn = true;

// Deferred loader â€” load Three.js + URDFLoader on first tab visit
let simLibsLoaded = false;
let simLibsLoading = false;

function ensureSimLibs(cb) {
  if (simLibsLoaded) { cb(); return; }
  if (simLibsLoading) { const iv = setInterval(() => { if (simLibsLoaded) { clearInterval(iv); cb(); } }, 100); return; }
  simLibsLoading = true;

  const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0';
  loadScript(THREE_CDN + '/build/three.min.js', () => {
    // OrbitControls as global
    loadScript(THREE_CDN + '/examples/js/controls/OrbitControls.js', () => {
      // URDFLoader
      loadScript('https://cdn.jsdelivr.net/npm/urdf-loader@0.12.4/src/URDFLoader.js', () => {
        simLibsLoaded = true;
        cb();
      });
    });
  });
}

// â”€â”€ Init 3D scene â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simInit() {
  if (simInitialized) return;
  simInitialized = true;

  const canvas = document.getElementById('sim-canvas');
  const container = canvas.parentElement;

  // Renderer
  simRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  simRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  simRenderer.shadowMap.enabled = true;
  simRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  simRenderer.outputColorSpace = THREE.SRGBColorSpace;
  simRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  simRenderer.toneMappingExposure = 1.0;

  // Scene
  simScene = new THREE.Scene();
  simScene.background = new THREE.Color(0x0d1117);
  simScene.fog = new THREE.FogExp2(0x0d1117, 0.035);

  // Camera
  simCamera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.05, 200);
  simCamera.position.set(3, 3, 3);
  simCamera.lookAt(0, 0, 0);

  // Controls
  simControls = new THREE.OrbitControls(simCamera, simRenderer.domElement);
  simControls.enableDamping = true;
  simControls.dampingFactor = 0.08;
  simControls.minDistance = 0.5;
  simControls.maxDistance = 50;
  simControls.maxPolarAngle = Math.PI / 2 + 0.1;
  simControls.target.set(0, 0, 0);

  // Clock
  simClock = new THREE.Clock();

  // Raycaster
  simRaycaster = new THREE.Raycaster();
  simMouse = new THREE.Vector2();

  // â”€â”€ Lights â”€â”€
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  simScene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 30;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  simScene.add(dirLight);

  const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x362a28, 0.5);
  simScene.add(hemiLight);

  // â”€â”€ Ground plane (subtle) â”€â”€
  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x151b26, roughness: 0.95 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.005;
  ground.receiveShadow = true;
  ground.name = 'ground';
  simScene.add(ground);

  // â”€â”€ Grid â”€â”€
  simGridHelper = new THREE.GridHelper(20, 40, 0x1a2944, 0x111a2a);
  simScene.add(simGridHelper);

  // â”€â”€ Axes â”€â”€
  simAxesHelper = new THREE.AxesHelper(2);
  simScene.add(simAxesHelper);

  // â”€â”€ Goal marker (hidden initially) â”€â”€
  const goalGeo = new THREE.CylinderGeometry(0.05, 0.15, 0.3, 8);
  const goalMat = new THREE.MeshStandardMaterial({ color: 0x00e0ff, emissive: 0x00e0ff, emissiveIntensity: 0.5 });
  simGoalMarker = new THREE.Mesh(goalGeo, goalMat);
  simGoalMarker.visible = false;
  simGoalMarker.position.y = 0.15;
  simScene.add(simGoalMarker);

  // â”€â”€ Events â”€â”€
  window.addEventListener('resize', simResize);
  new ResizeObserver(simResize).observe(container);
  canvas.addEventListener('click', simOnClick);
  canvas.addEventListener('mousemove', simOnMouseMove);

  // â”€â”€ URDF drag-and-drop â”€â”€
  const drop = document.getElementById('sim-urdf-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) simLoadUrdfFile(file);
  });
  document.getElementById('sim-urdf-input').addEventListener('change', e => {
    if (e.target.files[0]) simLoadUrdfFile(e.target.files[0]);
  });

  simResize();
  simAnimate();
}

function simResize() {
  if (!simRenderer) return;
  const container = simRenderer.domElement.parentElement;
  const w = container.clientWidth, h = container.clientHeight;
  simCamera.aspect = w / h;
  simCamera.updateProjectionMatrix();
  simRenderer.setSize(w, h, false);
}

// â”€â”€ Animation loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simAnimate() {
  if (!simAnimating) { simAnimating = true; }
  requestAnimationFrame(simAnimate);

  const delta = simClock.getDelta();
  simControls.update();

  // FPS counter
  simFrameCount++;
  const now = performance.now();
  if (now - simLastFpsTime >= 1000) {
    document.getElementById('sim-fps-hud').textContent = 'FPS: ' + simFrameCount;
    simFrameCount = 0;
    simLastFpsTime = now;
  }

  // Follow robot
  if (simFollowing && robotX !== null && simRobotGroup) {
    const target = new THREE.Vector3(robotX, SIM_ROBOT_HEIGHT, -robotY);
    simControls.target.lerp(target, 0.05);
  }

  // Update robot model pose from ROS data
  if (simRobotGroup && robotX !== null) {
    simRobotGroup.position.set(robotX, SIM_ROBOT_HEIGHT, -robotY);
    simRobotGroup.rotation.y = robotYaw || 0;
    document.getElementById('sim-pose-x').textContent = robotX.toFixed(3);
    document.getElementById('sim-pose-y').textContent = robotY.toFixed(3);
    document.getElementById('sim-pose-yaw').textContent = ((robotYaw || 0) * 180 / Math.PI).toFixed(1) + 'Â°';
  }

  // Pulse goal marker
  if (simGoalMarker && simGoalMarker.visible) {
    simGoalMarker.material.emissiveIntensity = 0.3 + 0.3 * Math.sin(now * 0.005);
  }

  // Update 3D overlays
  if (simLidarOn)     simUpdateLidar();
  if (simPathOn)      simUpdatePath();
  if (simWaypointsOn) simUpdateWaypoints();

  simRenderer.render(simScene, simCamera);
}

// â”€â”€ URDF Loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simLoadUrdfFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const urdfText = e.target.result;
    document.getElementById('sim-urdf-name').textContent = 'âœ“ ' + file.name;
    simParseAndLoadUrdf(urdfText, file.name);
  };
  reader.readAsText(file);
}

function simLoadUrdfFromUrl() {
  const url = document.getElementById('sim-urdf-url').value.trim();
  if (!url) return;
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(text => {
      document.getElementById('sim-urdf-name').textContent = 'âœ“ Loaded from URL';
      simParseAndLoadUrdf(text, 'robot.urdf');
    })
    .catch(err => toast('Failed to load URDF: ' + err, 'err'));
}

function simParseAndLoadUrdf(urdfText, filename) {
  // Remove old robot
  if (simRobotGroup) {
    simScene.remove(simRobotGroup);
    simRobotGroup = null;
  }

  try {
    // Parse URDF XML
    const parser = new DOMParser();
    const urdfDoc = parser.parseFromString(urdfText, 'text/xml');
    const robotEl = urdfDoc.querySelector('robot');
    if (!robotEl) { toast('Invalid URDF: no <robot> element', 'err'); return; }

    const robotName = robotEl.getAttribute('name') || 'robot';

    // Build simple visual representation from URDF links
    simRobotGroup = new THREE.Group();
    simRobotGroup.name = robotName;

    const links = urdfDoc.querySelectorAll('link');
    let hasVisual = false;

    links.forEach(link => {
      const visual = link.querySelector('visual');
      if (!visual) return;
      hasVisual = true;

      const geometry = visual.querySelector('geometry');
      if (!geometry) return;

      let mesh = null;
      const box = geometry.querySelector('box');
      const cylinder = geometry.querySelector('cylinder');
      const sphere = geometry.querySelector('sphere');

      if (box) {
        const size = (box.getAttribute('size') || '0.1 0.1 0.1').split(' ').map(Number);
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size[0], size[2], size[1]),
          new THREE.MeshStandardMaterial({ color: 0x3b9eff, roughness: 0.4, metalness: 0.3 })
        );
      } else if (cylinder) {
        const r = parseFloat(cylinder.getAttribute('radius') || 0.05);
        const l = parseFloat(cylinder.getAttribute('length') || 0.1);
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, l, 16),
          new THREE.MeshStandardMaterial({ color: 0x3b9eff, roughness: 0.4, metalness: 0.3 })
        );
      } else if (sphere) {
        const r = parseFloat(sphere.getAttribute('radius') || 0.05);
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(r, 16, 16),
          new THREE.MeshStandardMaterial({ color: 0x3b9eff, roughness: 0.4, metalness: 0.3 })
        );
      }

      if (mesh) {
        // Apply color from material
        const matEl = visual.querySelector('material');
        if (matEl) {
          const colorEl = matEl.querySelector('color');
          if (colorEl) {
            const rgba = (colorEl.getAttribute('rgba') || '0.5 0.5 0.5 1').split(' ').map(Number);
            mesh.material.color.setRGB(rgba[0], rgba[1], rgba[2]);
            if (rgba[3] < 1) { mesh.material.transparent = true; mesh.material.opacity = rgba[3]; }
          }
        }

        // Apply origin transform
        const origin = visual.querySelector('origin');
        if (origin) {
          const xyz = (origin.getAttribute('xyz') || '0 0 0').split(' ').map(Number);
          const rpy = (origin.getAttribute('rpy') || '0 0 0').split(' ').map(Number);
          mesh.position.set(xyz[0], xyz[2], -xyz[1]);
          mesh.rotation.set(rpy[0], rpy[2], -rpy[1]);
        }

        mesh.castShadow = true;
        mesh.receiveShadow = true;
        simRobotGroup.add(mesh);
      }
    });

    // If no visual elements, create a placeholder
    if (!hasVisual) {
      simBuildPlaceholderRobot(simRobotGroup);
    }

    simRobotGroup.position.y = SIM_ROBOT_HEIGHT;
    simScene.add(simRobotGroup);
    toast('Loaded robot: ' + robotName);

  } catch (err) {
    toast('URDF parse error: ' + err.message, 'err');
  }
}

// â”€â”€ Built-in TurtleBot3-style robot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simLoadDefaultRobot() {
  if (simRobotGroup) {
    simScene.remove(simRobotGroup);
    simRobotGroup = null;
  }

  simRobotGroup = new THREE.Group();
  simRobotGroup.name = 'TurtleBot3';

  // Body â€” flat cylinder
  const bodyGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.06, 24);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.03;
  body.castShadow = true;
  simRobotGroup.add(body);

  // Top plate
  const plateGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.005, 24);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x00e0ff, roughness: 0.3, metalness: 0.6 });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.y = 0.065;
  plate.castShadow = true;
  simRobotGroup.add(plate);

  // LiDAR tower
  const lidarBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12),
    new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.5 })
  );
  lidarBase.position.y = 0.088;
  lidarBase.castShadow = true;
  simRobotGroup.add(lidarBase);

  const lidarTop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.035, 0.015, 12),
    new THREE.MeshStandardMaterial({ color: 0x00e0ff, emissive: 0x00e0ff, emissiveIntensity: 0.3 })
  );
  lidarTop.position.y = 0.115;
  simRobotGroup.add(lidarTop);

  // Wheels (left & right)
  const wheelGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.025, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  [-1, 1].forEach(side => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0, side * 0.14);
    wheel.castShadow = true;
    simRobotGroup.add(wheel);
  });

  // Caster ball
  const caster = new THREE.Mesh(
    new THREE.SphereGeometry(0.015, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.3, metalness: 0.7 })
  );
  caster.position.set(-0.11, -0.015, 0);
  simRobotGroup.add(caster);

  // Direction arrow
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.06);
  arrowShape.lineTo(-0.03, -0.02);
  arrowShape.lineTo(0.03, -0.02);
  arrowShape.closePath();
  const arrowGeo = new THREE.ShapeGeometry(arrowShape);
  const arrowMat = new THREE.MeshStandardMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.4 });
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.y = 0.068;
  simRobotGroup.add(arrow);

  simRobotGroup.position.y = SIM_ROBOT_HEIGHT;
  simScene.add(simRobotGroup);
  document.getElementById('sim-urdf-name').textContent = 'âœ“ TurtleBot3 (built-in)';
  toast('Loaded TurtleBot3 model');
}

function simBuildPlaceholderRobot(group) {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.1, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x3b9eff, roughness: 0.4 })
  );
  body.position.y = 0.05;
  body.castShadow = true;
  group.add(body);

  // Direction indicator
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.08, 8),
    new THREE.MeshStandardMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.3 })
  );
  arrow.rotation.z = -Math.PI / 2;
  arrow.position.set(0.16, 0.05, 0);
  group.add(arrow);
}

// â”€â”€ Scene toggles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let simGridOn = true, simAxesOn = true, simMapOn = false;

function simToggleGrid() {
  simGridOn = !simGridOn;
  if (simGridHelper) simGridHelper.visible = simGridOn;
  document.getElementById('sim-grid-btn').textContent = 'Grid: ' + (simGridOn ? 'ON' : 'OFF');
}

function simToggleAxes() {
  simAxesOn = !simAxesOn;
  if (simAxesHelper) simAxesHelper.visible = simAxesOn;
  document.getElementById('sim-axes-btn').textContent = 'Axes: ' + (simAxesOn ? 'ON' : 'OFF');
}

function simSetBg(hex) {
  if (simScene) {
    simScene.background = new THREE.Color(hex);
    simScene.fog.color = new THREE.Color(hex);
  }
}

function simResetCamera() {
  simFollowing = false;
  simCamera.position.set(3, 3, 3);
  simControls.target.set(0, 0, 0);
}

function simTopView() {
  simFollowing = false;
  const tx = robotX || 0, ty = robotY || 0;
  simCamera.position.set(tx, 8, -ty);
  simControls.target.set(tx, 0, -ty);
}

function simFollowRobot() {
  simFollowing = !simFollowing;
  document.getElementById('sim-mode-txt').textContent = simFollowing ? 'Follow' : 'Orbit';
}

// â”€â”€ Occupancy map as 3D floor texture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simToggleMap() {
  simMapOn = !simMapOn;
  document.getElementById('sim-map-btn').textContent = 'Map: ' + (simMapOn ? 'ON' : 'OFF');

  if (simMapOn) {
    simBuildMap();
  } else if (simMapMesh) {
    simScene.remove(simMapMesh);
    simMapMesh = null;
  }
}

function simBuildMap() {
  if (simMapMesh) { simScene.remove(simMapMesh); simMapMesh = null; }
  if (!occupancyData || !mapWidth || !mapHeight) {
    toast('No map data â€” load a map in AMR tab first', 'err');
    simMapOn = false;
    document.getElementById('sim-map-btn').textContent = 'Map: OFF';
    return;
  }

  // Create texture from occupancy data
  const w = mapWidth, h = mapHeight;
  const imgData = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = occupancyData[i];
    let r, g, b, a;
    if (v === -1 || v === 255) {
      r = 26; g = 37; b = 53; a = 180;   // unknown â€” dark blue-gray
    } else if (v > 50) {
      r = 40; g = 40; b = 50; a = 255;   // occupied â€” dark
    } else {
      r = 200; g = 210; b = 220; a = 200; // free â€” light
    }
    // Flip Y for Three.js texture
    const row = h - 1 - Math.floor(i / w);
    const col = i % w;
    const idx = (row * w + col) * 4;
    imgData[idx] = r; imgData[idx+1] = g; imgData[idx+2] = b; imgData[idx+3] = a;
  }

  const texture = new THREE.DataTexture(imgData, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.NearestFilter;

  const worldW = w * mapResolution;
  const worldH = h * mapResolution;
  const geo = new THREE.PlaneGeometry(worldW, worldH);
  const mat = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.95, side: THREE.DoubleSide });
  simMapMesh = new THREE.Mesh(geo, mat);
  simMapMesh.rotation.x = -Math.PI / 2;
  simMapMesh.position.set(
    mapOriginX + worldW / 2,
    0.002,
    -(mapOriginY + worldH / 2)
  );
  simScene.add(simMapMesh);
}

// â”€â”€ 3D LiDAR point cloud â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simUpdateLidar() {
  // Remove previous
  if (simLidarPoints) { simScene.remove(simLidarPoints); simLidarPoints = null; }
  if (!lidarPoints || !lidarPoints.length) return;

  const count = lidarPoints.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const p = lidarPoints[i];
    positions[i * 3]     = p.x;
    positions[i * 3 + 1] = 0.08;   // slightly above ground
    positions[i * 3 + 2] = -p.y;   // ROS Y â†’ Three.js -Z

    // Color: close points warm, far points cool
    const dist = robotX !== null
      ? Math.sqrt((p.x - robotX) ** 2 + (p.y - robotY) ** 2)
      : 1;
    const t = Math.min(dist / 4, 1);
    colors[i * 3]     = 1 - t * 0.7;       // R
    colors[i * 3 + 1] = 0.2 + t * 0.6;     // G
    colors[i * 3 + 2] = 0.2 + t * 0.8;     // B
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.04,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
  });

  simLidarPoints = new THREE.Points(geo, mat);
  simScene.add(simLidarPoints);
}

// â”€â”€ 3D navigation path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simUpdatePath() {
  if (simPathLine) { simScene.remove(simPathLine); simPathLine = null; }
  if (!globalPath || globalPath.length < 2) return;

  const points = globalPath.map(p => new THREE.Vector3(p.x, 0.05, -p.y));
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x00e0ff, linewidth: 2, transparent: true, opacity: 0.7 });
  simPathLine = new THREE.Line(geo, mat);
  simScene.add(simPathLine);
}

// â”€â”€ 3D waypoint markers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simUpdateWaypoints() {
  // Remove old markers
  simWaypointMarkers.forEach(m => simScene.remove(m));
  simWaypointMarkers = [];
  if (!missionWaypoints || !missionWaypoints.length) return;

  missionWaypoints.forEach((wp, i) => {
    const geo = new THREE.SphereGeometry(0.06, 12, 12);
    const isActive = missionActive && i === missionIndex;
    const isPast = missionActive && i < missionIndex;
    const color = isActive ? 0x00ff88 : isPast ? 0x555555 : 0xf39c12;
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: isActive ? 0x00ff88 : color,
      emissiveIntensity: isActive ? 0.6 : 0.2,
    });
    const marker = new THREE.Mesh(geo, mat);
    marker.position.set(wp.x, 0.12, -wp.y);
    marker.castShadow = true;
    simScene.add(marker);
    simWaypointMarkers.push(marker);

    // Vertical line from marker to ground
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(wp.x, 0, -wp.y),
      new THREE.Vector3(wp.x, 0.12, -wp.y),
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 });
    const line = new THREE.Line(lineGeo, lineMat);
    simScene.add(line);
    simWaypointMarkers.push(line);
  });
}

function simToggleLidar() {
  simLidarOn = !simLidarOn;
  document.getElementById('sim-lidar-btn').textContent = 'LiDAR: ' + (simLidarOn ? 'ON' : 'OFF');
  if (!simLidarOn && simLidarPoints) { simScene.remove(simLidarPoints); simLidarPoints = null; }
}

function simTogglePath() {
  simPathOn = !simPathOn;
  document.getElementById('sim-path-btn').textContent = 'Path: ' + (simPathOn ? 'ON' : 'OFF');
  if (!simPathOn && simPathLine) { simScene.remove(simPathLine); simPathLine = null; }
}

function simToggleWaypoints() {
  simWaypointsOn = !simWaypointsOn;
  document.getElementById('sim-wp-btn').textContent = 'Waypts: ' + (simWaypointsOn ? 'ON' : 'OFF');
  if (!simWaypointsOn) { simWaypointMarkers.forEach(m => simScene.remove(m)); simWaypointMarkers = []; }
}

// â”€â”€ Click-to-set-goal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simToggleGoalMode() {
  simGoalMode = !simGoalMode;
  const btn = document.getElementById('sim-goal-btn');
  const crosshair = document.getElementById('sim-crosshair');
  if (simGoalMode) {
    btn.textContent = 'âœ• Cancel Goal Mode';
    btn.className = 'sim-btn sim-btn-danger';
    crosshair.style.display = 'block';
    document.getElementById('sim-mode-txt').textContent = 'Set Goal';
    simRenderer.domElement.style.cursor = 'crosshair';
  } else {
    btn.textContent = 'ðŸŽ¯ Click to Set Goal';
    btn.className = 'sim-btn sim-btn-green';
    crosshair.style.display = 'none';
    document.getElementById('sim-mode-txt').textContent = simFollowing ? 'Follow' : 'Orbit';
    simRenderer.domElement.style.cursor = 'default';
  }
}

function simOnClick(e) {
  if (!simGoalMode) return;

  const rect = simRenderer.domElement.getBoundingClientRect();
  simMouse.x =  ((e.clientX - rect.left) / rect.width) * 2 - 1;
  simMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  simRaycaster.setFromCamera(simMouse, simCamera);
  const ground = simScene.getObjectByName('ground');
  if (!ground) return;
  const hits = simRaycaster.intersectObject(ground);
  if (hits.length === 0) return;

  const pt = hits[0].point;
  const worldX = pt.x;
  const worldY = -pt.z;   // Three.js Z â†’ ROS Y

  // Place goal marker
  simGoalMarker.position.set(pt.x, 0.15, pt.z);
  simGoalMarker.visible = true;

  // Send nav goal (default yaw toward robot or 0)
  let yaw = 0;
  if (robotX !== null) {
    yaw = Math.atan2(worldY - robotY, worldX - robotX);
  }

  if (typeof sendNavGoal === 'function' && rosConnected) {
    sendNavGoal(worldX, worldY, yaw);
    toast('Goal sent: (' + worldX.toFixed(2) + ', ' + worldY.toFixed(2) + ')');
  } else {
    toast('Connect to robot in AMR tab to send goals', 'err');
  }

  simToggleGoalMode(); // exit goal mode
}

function simOnMouseMove(e) {
  const rect = simRenderer.domElement.getBoundingClientRect();
  const mx =  ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  simRaycaster.setFromCamera(new THREE.Vector2(mx, my), simCamera);
  const ground = simScene.getObjectByName('ground');
  if (!ground) return;
  const hits = simRaycaster.intersectObject(ground);
  if (hits.length > 0) {
    const p = hits[0].point;
    document.getElementById('sim-cursor-hud').textContent =
      'World: ' + p.x.toFixed(2) + ' , ' + (-p.z).toFixed(2);
  }
}

// â”€â”€ Multi-robot fleet visualization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function simUpdateFleetList() {
  const list = document.getElementById('sim-robot-list');
  if (!_robots || !_robots.length) {
    list.innerHTML = '<div style="color:var(--muted);font-family:var(--mono);font-size:10px;padding:8px;text-align:center">Connect to robots in AMR tab first</div>';
    return;
  }
  list.innerHTML = _robots.map(r => {
    const conn = rosConnections[r.robot_code];
    const on = conn?.connected;
    return `<div class="sim-robot-item">
      <div class="sim-robot-dot" style="background:${on ? 'var(--green)' : 'var(--muted)'}"></div>
      <span style="flex:1;color:${on ? 'var(--text)' : 'var(--muted)'}">${esc(r.robot_code)}</span>
      <span style="font-size:9px;color:var(--muted)">${on ? 'Online' : 'Offline'}</span>
    </div>`;
  }).join('');
}

// â”€â”€ Tab activation hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Initialize simulation on first tab visit
const simTabBtn = document.querySelector('[data-tab="sim"]');
if (simTabBtn) {
  simTabBtn.addEventListener('click', () => {
    ensureSimLibs(() => {
      simInit();
      simUpdateFleetList();
      // Rebuild map if available
      if (simMapOn && occupancyData) simBuildMap();
    });
  });
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   BOOT
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
connectWS();   // start WebSocket â€” handles live view
loadCrud();    // load all CRUD tables once
loadOrders();  // load orders

