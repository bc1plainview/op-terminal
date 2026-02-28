/* ============================================================
   OP Terminal v6 — OPNet Network Explorer (Production)
   Full chain history, contract catalog, block pagination,
   progressive loading, gas analytics, wallet portfolio
   ============================================================ */

const RPC = 'https://testnet.opnet.org/api/v1/json-rpc';
const POLL_MS = 10_000;
const RECENT_BLOCKS = 50;
const BLOCKS_PER_PAGE = 30;
const CHART_BLOCKS = 30;
const LOAD_BATCH = 20;
const LOAD_CONCURRENCY = 10;
const CIRC = 2 * Math.PI * 52;

/* ===== State ===== */
const state = {
  height: null,
  blocks: [],
  allBlocks: [],
  latestTxs: [],
  pendingTxs: [],
  wallet: null,
  walletUTXOs: [],
  walletActivity: [],
  online: false,
  gasHistory: [],
  epoch: null,
  activeTab: 'overview',
  txFilter: 'all',
  hoveredBar: -1,
  chartBars: [],
  pollCountdown: POLL_MS / 1000,
  prevHeights: new Set(),
  contracts: {},
  blockPage: 0,
  totalHeight: 0,
  bgLoading: false,
  bgLoaded: 0,
  bgTotal: 0,
  explorerCache: {},
  tokenContracts: {},
  tokenBalances: {},
  tokensLoading: false,
};

/* ===== IndexedDB Block Cache ===== */
var DB_NAME = 'op_terminal';
var DB_VER = 2; // Bump version to clear stale caches from v1

function openDB() {
  return new Promise(function(resolve, reject) {
    if (!window.indexedDB) { reject(new Error('No IDB')); return; }
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      // Delete old stores on upgrade
      if (db.objectStoreNames.contains('blocks')) db.deleteObjectStore('blocks');
      db.createObjectStore('blocks', { keyPath: '_height' });
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function() { reject(req.error); };
  });
}

function cacheBlocks(blocks) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('blocks', 'readwrite');
      var store = tx.objectStore('blocks');
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i]._height) store.put(blocks[i]);
      }
      tx.oncomplete = resolve;
      tx.onerror = function() { reject(tx.error); };
    });
  }).catch(function(e) { console.warn('cacheBlocks:', e); });
}

function loadCachedBlocks() {
  // Race against 3s timeout to prevent hanging on slow/blocked IndexedDB
  return Promise.race([
    openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('blocks', 'readonly');
        var req = tx.objectStore('blocks').getAll();
        req.onsuccess = function() { resolve(req.result || []); };
        req.onerror = function() { reject(req.error); };
      });
    }),
    new Promise(function(resolve) { setTimeout(function() { resolve([]); }, 3000); }),
  ]).catch(function() { return []; });
}

/* ===== Balance Parsing ===== */
function parseBalance(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') return hex(val);
  if (val && typeof val === 'object') {
    if (val.confirmed !== undefined) return hex(String(val.confirmed)) + hex(String(val.unconfirmed || '0'));
    if (val.balance !== undefined) return hex(String(val.balance));
    if (val.total !== undefined) return hex(String(val.total));
  }
  return 0;
}

var heroAnim = {
  blockHeight:  { val: 0, target: 0, anim: null, cur: 0 },
  gasBase:      { val: 0, target: 0, anim: null, cur: 0 },
  mempoolCount: { val: 0, target: 0, anim: null, cur: 0 },
  feeMed:       { val: 0, target: 0, anim: null, cur: 0 },
};

/* ===== RPC ===== */
var rpcId = 1;
var activeRpcCount = 0;

async function rpc(method, params) {
  activeRpcCount++;
  updateActivity();
  try {
    var res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params: params || [] }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    if (json.error) throw new Error(json.error.message || 'RPC error');
    return json.result;
  } finally {
    activeRpcCount--;
    updateActivity();
  }
}

function updateActivity() {
  var el = $('netActivity');
  if (el) el.classList.toggle('loading', activeRpcCount > 0);
}

/* ===== Helpers ===== */
function $(id) { return document.getElementById(id); }

function hex(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  return v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString();
}

function fmtCompact(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return fmt(n);
}

function satsToBtc(sats) { return (sats / 1e8).toFixed(8); }

function shortAddr(a) {
  if (!a || a.length < 20) return a || '--';
  return a.slice(0, 12) + '\u2026' + a.slice(-8);
}

function shortHash(h) {
  if (!h || h.length < 20) return h || '--';
  return h.slice(0, 10) + '\u2026' + h.slice(-8);
}

function timeAgo(ts) {
  if (!ts) return '--';
  var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5)     return 'just now';
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function fullDate(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString();
}

function escHtml(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function tryDecodeBase64(b64) {
  try {
    var raw = atob(b64);
    var printable = true;
    for (var i = 0; i < Math.min(raw.length, 50); i++) {
      var c = raw.charCodeAt(i);
      if (c < 32 && c !== 10 && c !== 13 && c !== 9) { printable = false; break; }
    }
    if (printable && raw.length < 500) return raw;
    var h = '';
    for (var j = 0; j < raw.length; j++) h += raw.charCodeAt(j).toString(16).padStart(2, '0');
    return '0x' + h;
  } catch (e) { return b64; }
}

/* ===== Bech32 Decoder ===== */
function bech32Decode(addr) {
  var CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var lower = addr.toLowerCase();
  var sep = lower.lastIndexOf('1');
  if (sep < 1) return null;
  var data = [];
  for (var i = sep + 1; i < lower.length; i++) {
    var c = CH.indexOf(lower.charAt(i));
    if (c === -1) return null;
    data.push(c);
  }
  data = data.slice(0, data.length - 6);
  var prog5 = data.slice(1);
  var acc = 0, bits = 0, result = [];
  for (var j = 0; j < prog5.length; j++) {
    acc = (acc << 5) | prog5[j];
    bits += 5;
    while (bits >= 8) { bits -= 8; result.push((acc >> bits) & 0xff); }
  }
  return result;
}

function bytesToHex(bytes) {
  var h = '';
  for (var i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

function b64ToHex(b64) {
  try {
    var raw = atob(b64);
    var h = '0x';
    for (var i = 0; i < raw.length; i++) h += raw.charCodeAt(i).toString(16).padStart(2, '0');
    return h;
  } catch(e) { return null; }
}

/* ===== OP20 Token Querying ===== */
var OP20_SEL = {
  name: '1581f81c', symbol: '25967ca5', decimals: 'bb844440',
  totalSupply: 'a368022e', balanceOf: '5b46f8f6',
};

/* Pre-verified popular tokens on OPNet testnet — always checked regardless of block scanning */
var KNOWN_TOKENS = [
  { hexAddr: '0xfd4473840751d58d9f8b73bdd57d6c5260453d5518bd7cd02d0a4cf3df9bf4dd', name: 'Motoswap', symbol: 'MOTO', decimals: 18 },
  { hexAddr: '0xb09fc29c112af8293539477e23d8df1d3126639642767d707277131352040cbb', name: 'Orange Pill', symbol: 'PILL', decimals: 18 },
  { hexAddr: '0x351912cae92e8e7ccabca1a8acd98f148d764466bc3e511a9412618523e93180', name: 'BASED MOTO', symbol: 'basedMOTO', decimals: 8 },
];

function ensureKnownTokens() {
  for (var i = 0; i < KNOWN_TOKENS.length; i++) {
    var kt = KNOWN_TOKENS[i];
    // Add to tokenContracts directly (skip RPC detection — we already know the metadata)
    if (!state.tokenContracts[kt.hexAddr]) {
      state.tokenContracts[kt.hexAddr] = {
        hexAddr: kt.hexAddr, optAddr: null, name: kt.name,
        symbol: kt.symbol, decimals: kt.decimals,
      };
    }
    // Also ensure they're in contracts map so detectTokens doesn't re-check
    if (!state.contracts[kt.hexAddr]) {
      state.contracts[kt.hexAddr] = { address: kt.hexAddr, hexAddr: kt.hexAddr, firstSeen: 0, lastSeen: 0, interactions: 0, deployTx: null, events: [] };
    }
  }
}

function callContract(hexAddr, calldataHex) {
  return rpc('btc_call', [hexAddr, calldataHex]);
}

function extractCallResult(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    if (typeof res.result === 'string') return res.result;
    if (typeof res.data === 'string') return res.data;
  }
  return null;
}

function decodeOP20String(b64) {
  try {
    var raw = atob(b64);
    if (raw.length < 4) return null;
    var len = (raw.charCodeAt(0) << 24) | (raw.charCodeAt(1) << 16) | (raw.charCodeAt(2) << 8) | raw.charCodeAt(3);
    if (len <= 0 || len > raw.length - 4 || len > 200) return null;
    var s = raw.slice(4, 4 + len);
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 32 || c > 126) return null; }
    return s;
  } catch(e) { return null; }
}

function decodeOP20Uint8(b64) {
  try { var raw = atob(b64); return raw.length >= 1 ? raw.charCodeAt(0) : null; } catch(e) { return null; }
}

function decodeOP20Uint256(b64) {
  try {
    var raw = atob(b64);
    if (!raw.length) return 0n;
    var result = 0n;
    for (var i = 0; i < raw.length; i++) result = (result << 8n) | BigInt(raw.charCodeAt(i));
    return result;
  } catch(e) { return 0n; }
}

function formatTokenAmount(balance, decimals) {
  if (balance === 0n) return '0';
  var divisor = 10n ** BigInt(decimals);
  var whole = balance / divisor;
  var frac = balance % divisor;
  if (frac === 0n) return whole.toLocaleString();
  var fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fracStr.length > 6) fracStr = fracStr.slice(0, 6);
  return whole.toLocaleString() + '.' + fracStr;
}

async function detectTokens() {
  if (state.tokensLoading) return;
  state.tokensLoading = true;
  ensureKnownTokens();
  var contracts = Object.values(state.contracts);
  var newTokens = 0;

  for (var i = 0; i < contracts.length; i += 5) {
    var batch = contracts.slice(i, i + 5);
    var proms = batch.map(function(c) {
      if (!c.hexAddr || state.tokenContracts[c.hexAddr]) return Promise.resolve();
      return callContract(c.hexAddr, '0x' + OP20_SEL.name).then(function(res) {
        var b64 = extractCallResult(res);
        if (!b64) return;
        var name = decodeOP20String(b64);
        if (!name) return;
        return Promise.all([
          callContract(c.hexAddr, '0x' + OP20_SEL.symbol).catch(function() { return null; }),
          callContract(c.hexAddr, '0x' + OP20_SEL.decimals).catch(function() { return null; }),
        ]).then(function(arr) {
          var symB64 = arr[0] ? extractCallResult(arr[0]) : null;
          var decB64 = arr[1] ? extractCallResult(arr[1]) : null;
          var symbol = symB64 ? decodeOP20String(symB64) : null;
          var decimals = decB64 ? decodeOP20Uint8(decB64) : null;
          state.tokenContracts[c.hexAddr] = {
            hexAddr: c.hexAddr, optAddr: c.address, name: name,
            symbol: symbol || name, decimals: decimals != null ? decimals : 18,
          };
          newTokens++;
        });
      }).catch(function() { /* not a token */ });
    });
    await Promise.all(proms);
  }

  state.tokensLoading = false;
  if (newTokens > 0) {
    updateTokenHoldings();
    if (state.wallet) loadTokenBalances();
  }
}

async function loadTokenBalances() {
  if (!state.wallet || !Object.keys(state.tokenContracts).length) { updateTokenHoldings(); return; }

  // Collect all candidate 32-byte hex addresses to try for balanceOf
  var candidates = [];

  // 1. Bech32 decode of wallet address (witness program = tweaked public key)
  var addrBytes = bech32Decode(state.wallet.address);
  if (addrBytes && addrBytes.length >= 20) {
    while (addrBytes.length < 32) addrBytes.unshift(0);
    candidates.push({ src: 'bech32', hex: bytesToHex(addrBytes) });
  }

  // 2. Wallet public key (may be Schnorr compressed or MLDSA)
  if (state.wallet.publicKey) {
    var pk = state.wallet.publicKey.replace(/^0x/i, '');
    if (pk.length === 66) {
      // 33-byte compressed Schnorr → strip prefix → 32-byte x-only
      candidates.push({ src: 'pubkey-xonly', hex: pk.slice(2) });
    } else if (pk.length === 64) {
      candidates.push({ src: 'pubkey-32', hex: pk });
    }
    // For MLDSA keys (very long), try SHA256 hash as address identifier
    if (pk.length > 128) {
      // Use first 64 hex chars (32 bytes) as a potential address
      candidates.push({ src: 'pubkey-prefix', hex: pk.slice(0, 64) });
    }
  }

  if (!candidates.length) {
    console.warn('loadTokenBalances: no address candidates for', state.wallet.address);
    updateTokenHoldings();
    return;
  }

  console.log('loadTokenBalances: trying', candidates.length, 'address candidates:', candidates.map(function(c) { return c.src + '=' + c.hex.slice(0,16) + '...'; }));

  // Try first candidate; if ALL balances are 0, try next candidate
  var tokens = Object.values(state.tokenContracts);
  var foundNonZero = false;

  for (var ci = 0; ci < candidates.length && !foundNonZero; ci++) {
    var addrHex = candidates[ci].hex;
    var tempBalances = {};

    for (var i = 0; i < tokens.length; i += 5) {
      var batch = tokens.slice(i, i + 5);
      var proms = batch.map(function(token) {
        var cd = '0x' + OP20_SEL.balanceOf + addrHex;
        return callContract(token.hexAddr, cd).then(function(res) {
          var b64 = extractCallResult(res);
          if (b64) {
            var val = decodeOP20Uint256(b64);
            tempBalances[token.hexAddr] = val;
            if (val > 0n) foundNonZero = true;
          }
        }).catch(function(e) { console.warn('balanceOf failed for', token.symbol, '(' + candidates[ci].src + '):', e.message); });
      });
      await Promise.all(proms);
    }

    // Apply results from this candidate
    if (foundNonZero || ci === candidates.length - 1) {
      Object.keys(tempBalances).forEach(function(k) { state.tokenBalances[k] = tempBalances[k]; });
      console.log('loadTokenBalances: using', candidates[ci].src, 'address, foundNonZero:', foundNonZero);
    }
  }

  updateTokenHoldings();
}

function updateTokenHoldings() {
  var container = $('wpTokenList');
  if (!container) return;

  if (!state.wallet) { container.innerHTML = '<span class="wp-empty">Connect wallet to view tokens</span>'; $('wpTokenCount').textContent = '0'; return; }
  if (state.tokensLoading) { container.innerHTML = '<span class="wp-empty">Scanning contracts\u2026</span>'; return; }

  // Show ALL known tokens — held tokens highlighted, zero-balance tokens dimmed
  var allTokens = Object.values(state.tokenContracts);
  if (!allTokens.length) { container.innerHTML = '<span class="wp-empty">No tokens tracked</span>'; $('wpTokenCount').textContent = '0'; return; }

  // Sort: held tokens first (by balance desc), then zero-balance alphabetically
  allTokens.sort(function(a, b) {
    var balA = state.tokenBalances[a.hexAddr] || 0n;
    var balB = state.tokenBalances[b.hexAddr] || 0n;
    if (balA > 0n && balB === 0n) return -1;
    if (balA === 0n && balB > 0n) return 1;
    if (balA > balB) return -1;
    if (balA < balB) return 1;
    return a.symbol.localeCompare(b.symbol);
  });

  var heldCount = allTokens.filter(function(t) { var b = state.tokenBalances[t.hexAddr]; return b !== undefined && b > 0n; }).length;
  var countEl = $('wpTokenCount');
  if (countEl) countEl.textContent = heldCount + '/' + allTokens.length;

  var html = '';
  for (var i = 0; i < allTokens.length; i++) {
    var t = allTokens[i];
    var bal = state.tokenBalances[t.hexAddr];
    var hasBalance = bal !== undefined && bal > 0n;
    var balStr = hasBalance ? formatTokenAmount(bal, t.decimals) : (bal !== undefined ? '0' : '\u2014');
    var activeCls = hasBalance ? ' wp-token--active' : '';
    html += '<div class="wp-token' + activeCls + '" data-addr="' + escHtml(t.optAddr || t.hexAddr) + '">' +
      '<div class="wp-token__left"><span class="wp-token__icon">' + escHtml(t.symbol.slice(0,2)) + '</span><div><div class="wp-token__sym">' + escHtml(t.symbol) + '</div><div class="wp-token__name">' + escHtml(t.name) + '</div></div></div>' +
      '<span class="wp-token__bal mono">' + escHtml(balStr) + '</span></div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.wp-token').forEach(function(el) {
    el.addEventListener('click', function() {
      var addr = el.dataset.addr;
      if (addr) { $('searchInput').value = addr; switchTab('explorer'); search(); }
    });
  });
}

/* ===== Animated Counter ===== */
function animateValue(key, newVal, formatter, elId) {
  var hs = heroAnim[key];
  if (!hs) return;
  var el = $(elId);
  if (!el) return;
  if (hs.anim) cancelAnimationFrame(hs.anim);
  var from = hs.cur;
  var to = newVal;
  if (Math.abs(from - to) < 0.5) { el.textContent = formatter(to); hs.val = to; hs.cur = to; return; }
  if (from !== 0) pulse(el);
  var start = performance.now();
  var dur = 700;
  function step(now) {
    var t = Math.min((now - start) / dur, 1);
    var ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    var cur = from + (to - from) * ease;
    hs.cur = cur;
    el.textContent = formatter(cur);
    if (t < 1) { hs.anim = requestAnimationFrame(step); }
    else { hs.val = to; hs.cur = to; hs.anim = null; }
  }
  hs.target = to;
  hs.anim = requestAnimationFrame(step);
}

function pulse(el) {
  el.classList.remove('val-pulse');
  void el.offsetWidth;
  el.classList.add('val-pulse');
}

/* ===== Event Classification ===== */
var EVT_MAP = {
  'Transferred':'Transfer','Transfer':'Transfer','Approved':'Approve','Approval':'Approve',
  'Synced':'Sync','Swapped':'Swap','SwapExecuted':'Swap Exec','Swap':'Swap',
  'Minted':'Mint','Mint':'Mint','Burned':'Burn','Burn':'Burn',
  'PoolCreated':'Pool Created','LiquidityAdded':'LP Added','LiquidityReserved':'LP Reserved',
  'LiquidityRemoved':'LP Removed','ReservationCreated':'Reservation','ProviderConsumed':'Provider',
  'MarketCreated':'Market Created','MarketResolved':'Market Resolved','MarketDescription':'Market Desc',
  'Pause':'Pause','Unpause':'Unpause','VaultCreated':'Vault Created',
  'Claimed':'Claimed','SpinResult':'Spin Result','DocumentSigned':'Doc Signed',
};
var EVT_COLORS = {
  Transfer:'evt--transfer',Approve:'evt--approve',Sync:'evt--swap',Swap:'evt--swap',
  'Swap Exec':'evt--swap',Mint:'evt--lp',Burn:'evt--lp','Pool Created':'evt--lp',
  'LP Added':'evt--lp','LP Reserved':'evt--lp','LP Removed':'evt--lp',
  Reservation:'evt--lp',Provider:'evt--lp','Market Created':'evt--market',
  'Market Resolved':'evt--market','Market Desc':'evt--market',Pause:'evt--admin',
  Unpause:'evt--admin','Vault Created':'evt--admin',Claimed:'evt--transfer',
  'Spin Result':'evt--other','Doc Signed':'evt--admin',
};

function classifyEvent(type) {
  if (!type) return { cls: 'evt--other', label: 'Event' };
  var label = EVT_MAP[type];
  if (label) return { cls: EVT_COLORS[label] || 'evt--other', label: label };
  var lower = type.toLowerCase();
  if (lower.includes('transfer'))  return { cls: 'evt--transfer', label: type };
  if (lower.includes('approv'))    return { cls: 'evt--approve',  label: type };
  if (lower.includes('swap'))      return { cls: 'evt--swap',     label: type };
  if (lower.includes('liquid') || lower.includes('pool') || lower.includes('mint') || lower.includes('burn'))
    return { cls: 'evt--lp', label: type };
  if (lower.includes('market'))    return { cls: 'evt--market',   label: type };
  if (lower.includes('pause') || lower.includes('admin') || lower.includes('owner') || lower.includes('changed') || lower.includes('signed'))
    return { cls: 'evt--admin', label: type };
  return { cls: 'evt--other', label: type };
}

function renderEventBadges(events) {
  if (!events || !events.length) return '';
  return events.map(function(e) {
    var info = classifyEvent(e.type);
    return '<span class="evt ' + info.cls + '">' + escHtml(info.label) + '</span>';
  }).join('');
}

/* ===== Tab System ===== */
function initTabs() {
  $('tabNav').addEventListener('click', function(e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    e.preventDefault();
    switchTab(tab.dataset.tab);
  });
}

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('#tabNav .tab').forEach(function(t) {
    t.classList.toggle('tab--active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.classList.toggle('active', p.id === 'panel-' + name);
  });
  document.querySelectorAll('#mobileNav .mobile-nav__item').forEach(function(m) {
    m.classList.toggle('mobile-nav__item--active', m.dataset.tab === name);
  });
  if (name === 'explorer') setTimeout(function() { $('searchInput').focus(); }, 50);
  if (name === 'profile') { updateWalletPortfolio(); updateTokenHoldings(); }
  try { history.replaceState(null, '', '#' + name); } catch(e) {}
  setTimeout(applyRevealClasses, 50);
}

function initTxSubTabs() {
  document.querySelectorAll('.txs-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var sub = btn.dataset.sub;
      document.querySelectorAll('.txs-tab').forEach(function(b) {
        b.classList.toggle('txs-tab--active', b.dataset.sub === sub);
      });
      document.querySelectorAll('.txs-sub').forEach(function(p) {
        p.classList.toggle('active', p.id === 'sub-' + sub);
      });
    });
  });
}

function initTxFilters() {
  var container = $('txFilters');
  if (!container) return;
  container.addEventListener('click', function(e) {
    var btn = e.target.closest('.tx-filter');
    if (!btn) return;
    state.txFilter = btn.dataset.filter;
    container.querySelectorAll('.tx-filter').forEach(function(b) {
      b.classList.toggle('tx-filter--active', b.dataset.filter === state.txFilter);
    });
    updateLatestTxs();
  });
}

/* ===== Network Status ===== */
function setNetwork(online) {
  state.online = online;
  var badge = $('netBadge');
  var label = $('netLabel');
  if (online) {
    badge.className = 'topbar__network online';
    label.textContent = 'OPNet Testnet';
  } else {
    badge.className = 'topbar__network';
    label.textContent = 'Connecting\u2026';
  }
}

/* ===== Data Fetching ===== */
function fetchHeight()      { return rpc('btc_blockNumber'); }
function fetchGas()         { return rpc('btc_gas'); }
function fetchMempool()     { return rpc('btc_getMempoolInfo'); }
function fetchBalance(a)    { return rpc('btc_getBalance', [a, true]); }
function fetchBlock(n, pf)  { return rpc('btc_getBlockByNumber', [n, !!pf]); }
function fetchTx(hash)      { return rpc('btc_getTransactionByHash', [hash]); }
function fetchReceipt(hash) { return rpc('btc_getTransactionReceipt', [hash]); }
function fetchCode(addr)    { return rpc('btc_getCode', [addr, true]); }
function fetchPending()     { return rpc('btc_getLatestPendingTransactions'); }
function fetchEpoch()       { return rpc('btc_getEpochTemplate'); }
function fetchUTXOs(a)      { return rpc('btc_getUTXOs', [a, false, true, true]); }

/* ===== Overview Updates ===== */
function updateHeroStats(height, gas, mempool) {
  animateValue('blockHeight', height, function(v) { return fmt(Math.round(v)); }, 'blockHeight');
  $('topBlock').textContent = fmt(height);
  animateValue('gasBase', hex(gas.baseGas), function(v) { return fmtCompact(Math.round(v)); }, 'gasBase');
  if (mempool) animateValue('mempoolCount', mempool.count || 0, function(v) { return fmt(Math.round(v)); }, 'mempoolCount');
  if (gas.bitcoin && gas.bitcoin.recommended) {
    var med = parseFloat(gas.bitcoin.recommended.medium);
    animateValue('feeMed', med, function(v) { return v.toFixed(1); }, 'feeMedTop');
  }
}

function updateEpoch(epoch) {
  if (!epoch) return;
  state.epoch = epoch;
  var el = $('epochNum');
  var prev = el.textContent;
  var next = epoch.epochNumber != null ? String(epoch.epochNumber) : '--';
  el.textContent = next;
  if (prev !== '--' && prev !== next) pulse(el);
}

function updateGasCard(gas) {
  var used  = hex(gas.gasUsed);
  var limit = hex(gas.gasLimit);
  var pct   = limit > 0 ? (used / limit) * 100 : 0;
  var offset = CIRC - (CIRC * Math.min(pct, 100) / 100);
  var arc = $('utilArc');
  arc.setAttribute('stroke-dashoffset', offset);
  arc.setAttribute('stroke', pct > 80 ? 'var(--c-red)' : pct > 50 ? 'var(--c-amber)' : 'var(--c-blue)');
  setAndPulse('utilPct',   pct.toFixed(1) + '%');
  setAndPulse('gasUsed',   fmtCompact(used));
  setAndPulse('gasLimit',  fmtCompact(limit));
  setAndPulse('gasTarget', fmtCompact(hex(gas.targetGasLimit)));
  setAndPulse('gasPerSat', fmt(hex(gas.gasPerSat)));
  setAndPulse('gasEma',    fmt(hex(gas.ema)));
}

function setAndPulse(id, newText) {
  var el = $(id);
  if (!el) return;
  if (el.textContent !== newText && el.textContent !== '--') pulse(el);
  el.textContent = newText;
}

function updateFeeCard(gas) {
  if (!gas.bitcoin) return;
  var r = gas.bitcoin.recommended, c = gas.bitcoin.conservative;
  var low = parseFloat(r.low), med = parseFloat(r.medium), high = parseFloat(r.high);
  var max = Math.max(high * 1.2, 5);
  setAndPulse('feeLow',  low.toFixed(1));
  setAndPulse('feeMed',  med.toFixed(1));
  setAndPulse('feeHigh', high.toFixed(1));
  setAndPulse('feeCons', parseFloat(c).toFixed(1) + ' sat/vB');
  $('feeBarLow').style.width  = (low  / max * 100) + '%';
  $('feeBarMed').style.width  = (med  / max * 100) + '%';
  $('feeBarHigh').style.width = (high / max * 100) + '%';
}

function updateMempoolCard(mp) {
  if (!mp) return;
  var total = mp.count || 0, opnet = mp.opnetCount || 0, size = mp.size || 0;
  var ratio = total > 0 ? ((opnet / total) * 100) : 0;
  setAndPulse('mpTotal', fmt(total));
  setAndPulse('mpOpnet', fmt(opnet));
  setAndPulse('mpSize',  (size / 1024).toFixed(1));
  setAndPulse('mpRatio', ratio.toFixed(0) + '%');
}

/* ===== Gas Chart ===== */
function drawGasChart() {
  var canvas = $('gasChart');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.parentElement.getBoundingClientRect();
  var newW = Math.round(rect.width * dpr), newH = Math.round(rect.height * dpr);
  if (canvas.width !== newW || canvas.height !== newH) { canvas.width = newW; canvas.height = newH; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  var data = state.gasHistory;
  if (data.length < 2) {
    ctx.fillStyle = 'rgba(160,160,184,.3)';
    ctx.font = '12px Poppins, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data\u2026', w / 2, h / 2);
    state.chartBars = [];
    return;
  }

  var maxGas = 1;
  for (var i = 0; i < data.length; i++) { if (data[i].gasUsed > maxGas) maxGas = data[i].gasUsed; }
  var padBottom = 20, padTop = 8;
  var chartH = h - padBottom - padTop;
  var gap = Math.max(2, Math.min(5, w / data.length * 0.08));
  var barW = Math.max(((w - (data.length - 1) * gap) / data.length), 4);
  var bars = [];

  ctx.strokeStyle = 'rgba(255,255,255,.03)';
  ctx.lineWidth = 1;
  for (var g = 1; g <= 3; g++) {
    var gy = padTop + chartH * (1 - g / 4);
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
  }

  if (state.hoveredBar >= 0 && state.hoveredBar < data.length) {
    var hx = state.hoveredBar * (barW + gap);
    ctx.fillStyle = 'rgba(6,182,212,.05)';
    ctx.fillRect(hx - gap / 2, 0, barW + gap, h);
  }

  for (var j = 0; j < data.length; j++) {
    var d = data[j];
    var barH = Math.max((d.gasUsed / maxGas) * chartH * 0.92, 3);
    var x = j * (barW + gap), y = padTop + chartH - barH;
    var hovered = j === state.hoveredBar;
    bars.push({ x: x, y: y, w: barW, h: barH, idx: j });
    ctx.save();
    if (hovered) {
      ctx.shadowColor = 'rgba(6,182,212,.5)'; ctx.shadowBlur = 20;
      var gg = ctx.createLinearGradient(x, y, x, padTop + chartH);
      gg.addColorStop(0, 'rgba(6,182,212,1)'); gg.addColorStop(0.35, 'rgba(59,130,246,.9)'); gg.addColorStop(1, 'rgba(59,130,246,.3)');
      ctx.fillStyle = gg;
    } else {
      ctx.shadowColor = 'transparent';
      var gr = ctx.createLinearGradient(x, y, x, padTop + chartH);
      gr.addColorStop(0, 'rgba(6,182,212,.6)'); gr.addColorStop(0.5, 'rgba(59,130,246,.35)'); gr.addColorStop(1, 'rgba(59,130,246,.06)');
      ctx.fillStyle = gr;
    }
    ctx.beginPath();
    var r = Math.min(3, barW / 2, barH / 2);
    ctx.moveTo(x + r, y); ctx.lineTo(x + barW - r, y);
    ctx.arcTo(x + barW, y, x + barW, y + r, r); ctx.lineTo(x + barW, padTop + chartH);
    ctx.lineTo(x, padTop + chartH); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath(); ctx.fill();
    if (hovered) {
      ctx.shadowColor = 'transparent'; ctx.strokeStyle = 'rgba(6,182,212,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + barW - r, y); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = hovered ? 'rgba(6,182,212,.9)' : 'rgba(160,160,184,.4)';
    ctx.font = (hovered ? '600 ' : '') + '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    if (barW > 18) ctx.fillText('#' + d.height, x + barW / 2, h - 4);
  }
  state.chartBars = bars;
}

function initGasChartHover() {
  var canvas = $('gasChart');
  if (!canvas) return;
  canvas.addEventListener('mousemove', function(e) {
    if (!state.chartBars.length) return;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var hit = -1, bars = state.chartBars;
    for (var k = 0; k < bars.length; k++) {
      var le = k === 0 ? 0 : (bars[k-1].x + bars[k-1].w + bars[k].x) / 2;
      var re = k === bars.length-1 ? rect.width : (bars[k].x + bars[k].w + bars[k+1].x) / 2;
      if (mx >= le && mx < re) { hit = k; break; }
    }
    if (hit >= 0 && my > rect.height - 14) hit = -1;
    if (hit !== state.hoveredBar) {
      state.hoveredBar = hit;
      drawGasChart();
      if (hit >= 0) showGasTooltip(hit, e.clientX, e.clientY);
      else hideGasTooltip();
    } else if (hit >= 0) positionGasTooltip(e.clientX, e.clientY);
  });
  canvas.addEventListener('mouseleave', function() {
    if (state.hoveredBar !== -1) { state.hoveredBar = -1; drawGasChart(); hideGasTooltip(); }
  });
  canvas.addEventListener('click', function() {
    if (state.hoveredBar >= 0 && state.gasHistory[state.hoveredBar]) {
      var block = state.gasHistory[state.hoveredBar].block;
      if (block) { switchTab('blocks'); setTimeout(function() { showBlockDetail(block); }, 100); }
    }
  });
}

function showGasTooltip(barIdx, cx, cy) {
  var tip = $('gasTooltip'), d = state.gasHistory[barIdx];
  if (!tip || !d) return;
  var block = d.block, txCount = block ? (block.txCount || 0) : 0;
  var opnet = block ? countOpnetTxs(block) : 0;
  var maxGas = 1;
  for (var i = 0; i < state.gasHistory.length; i++) if (state.gasHistory[i].gasUsed > maxGas) maxGas = state.gasHistory[i].gasUsed;
  var pct = ((d.gasUsed / maxGas) * 100).toFixed(1);
  var baseGas = block ? fmtCompact(hex(block.baseGas || '0')) : '--';
  tip.innerHTML =
    '<div class="gas-tooltip__title">Block #' + fmt(d.height) + '</div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">Gas Used</span><span class="gas-tooltip__val gas-tooltip__val--blue">' + fmtCompact(d.gasUsed) + '</span></div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">% of Peak</span><span class="gas-tooltip__val">' + pct + '%</span></div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">Transactions</span><span class="gas-tooltip__val">' + txCount + '</span></div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">OPNet Txs</span><span class="gas-tooltip__val gas-tooltip__val--blue">' + opnet + '</span></div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">Base Gas</span><span class="gas-tooltip__val">' + baseGas + '</span></div>' +
    '<div class="gas-tooltip__row"><span class="gas-tooltip__lbl">Age</span><span class="gas-tooltip__val">' + (block ? timeAgo(block.time) : '--') + '</span></div>' +
    '<div class="gas-tooltip__bar"><div class="gas-tooltip__bar-fill" style="width:' + pct + '%"></div></div>';
  tip.classList.add('visible');
  positionGasTooltip(cx, cy);
}

function positionGasTooltip(cx, cy) {
  var tip = $('gasTooltip');
  if (!tip) return;
  var tw = tip.offsetWidth || 190, th = tip.offsetHeight || 180;
  var x = cx + 14, y = cy - 10;
  if (x + tw > window.innerWidth - 8) x = cx - tw - 14;
  if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
  if (y < 8) y = 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

function hideGasTooltip() { var t = $('gasTooltip'); if (t) t.classList.remove('visible'); }

/* ===== Block Activity Viz ===== */
function updateBlockViz() {
  var c = $('blockViz');
  if (!c || !state.blocks.length) { if (c) c.innerHTML = '<span style="color:var(--c-t3);font-size:12px">Loading...</span>'; return; }
  var blocks = state.blocks.slice(0, 8), html = '';
  blocks.forEach(function(b) {
    var isNew = !state.prevHeights.has(b._height);
    var txs = b.transactions && Array.isArray(b.transactions) ? b.transactions : [];
    var dots = '';
    txs.forEach(function(tx) {
      var type = tx.OPNetType || 'Generic';
      var color = type === 'Interaction' ? 'var(--c-blue)' : type === 'Deployment' ? 'var(--c-purple)' : 'var(--c-t3)';
      dots += '<span class="bv-dot" style="background:' + color + '" title="' + escHtml(type) + '"></span>';
    });
    if (!dots) dots = '<span style="font-size:9px;color:var(--c-t3)">Empty</span>';
    html += '<div class="bv-block' + (isNew ? ' bv-block--new' : '') + '" data-height="' + b._height + '">' +
      '<div class="bv-num">#' + fmt(b._height) + '</div><div class="bv-dots">' + dots + '</div>' +
      '<div class="bv-info"><span>' + (b.txCount || 0) + '</span> txs \u00b7 <span>' + countOpnetTxs(b) + '</span> OPNet \u00b7 ' + timeAgo(b.time) + '</div></div>';
  });
  c.innerHTML = html;
  c.querySelectorAll('.bv-block').forEach(function(el) {
    el.addEventListener('click', function() {
      var h = parseInt(el.dataset.height, 10);
      var block = state.blocks.find(function(b) { return b._height === h; });
      if (block) { switchTab('blocks'); setTimeout(function() { showBlockDetail(block); }, 100); }
    });
  });
  blocks.forEach(function(b) { state.prevHeights.add(b._height); });
}

/* ===== Block Table (Paginated) ===== */
function updateBlockTable() {
  var tbody = $('blockTbody');
  if (!tbody) return;

  var all = state.allBlocks;
  if (!all.length) { tbody.innerHTML = '<tr class="dtable__empty"><td colspan="6">Fetching blocks\u2026</td></tr>'; return; }

  var start = state.blockPage * BLOCKS_PER_PAGE;
  var page = all.slice(start, start + BLOCKS_PER_PAGE);
  var maxGas = 1;
  for (var i = 0; i < page.length; i++) if (page[i]._gasUsed > maxGas) maxGas = page[i]._gasUsed;

  tbody.innerHTML = '';
  for (var j = 0; j < page.length; j++) {
    var b = page[j];
    var opnet = countOpnetTxs(b);
    var barW = Math.max((b._gasUsed / maxGas) * 60, 2);
    var isNew = !state.prevHeights.has(b._height);
    var tr = document.createElement('tr');
    tr.dataset.height = b._height;
    if (isNew) tr.className = 'row-new';
    tr.innerHTML =
      '<td class="td-blue">#' + fmt(b._height) + '</td>' +
      '<td class="td-dim">' + shortHash(b.hash || '') + '</td>' +
      '<td>' + (b.txCount || 0) + '</td>' +
      '<td>' + opnet + '</td>' +
      '<td><span class="td-bar" style="width:' + barW + 'px"></span>' + fmtCompact(b._gasUsed) + '</td>' +
      '<td class="td-dim">' + timeAgo(b.time) + '</td>';
    (function(block) { tr.addEventListener('click', function() { showBlockDetail(block); }); })(b);
    tbody.appendChild(tr);
  }

  // Update pagination info
  var totalPages = Math.ceil(all.length / BLOCKS_PER_PAGE);
  var info = $('blockPageInfo');
  if (info) info.textContent = 'Page ' + (state.blockPage + 1) + ' of ' + totalPages + ' \u00b7 ' + all.length + ' blocks loaded';
  var prevBtn = $('blockPrev'), nextBtn = $('blockNext');
  if (prevBtn) prevBtn.disabled = state.blockPage === 0;
  if (nextBtn) nextBtn.disabled = start + BLOCKS_PER_PAGE >= all.length;
}

function countOpnetTxs(block) {
  if (!block.transactions || !Array.isArray(block.transactions)) return 0;
  var c = 0;
  for (var i = 0; i < block.transactions.length; i++) {
    var t = block.transactions[i].OPNetType;
    if (t === 'Interaction' || t === 'Deployment') c++;
  }
  return c;
}

/* ===== Block Detail ===== */
function showBlockDetail(block) {
  // If block has no tx data and it's a header-only block, fetch full data
  if ((!block.transactions || !block.transactions.length) && block.txCount > 0) {
    fetchBlock(block._height, true).then(function(full) {
      if (full) {
        full._height = typeof full.height === 'string' ? parseInt(full.height, 10) : (full.height || block._height);
        full._gasUsed = typeof full.gasUsed === 'number' ? full.gasUsed : hex(full.gasUsed || '0');
        trackContracts(full);
        renderBlockDetail(full);
      }
    }).catch(function() { renderBlockDetail(block); });
    return;
  }
  renderBlockDetail(block);
}

function renderBlockDetail(block) {
  var panel = $('blockDetail'), title = $('blockDetailTitle'), meta = $('blockDetailMeta'), txs = $('blockDetailTxs');
  title.textContent = 'Block #' + fmt(block._height);
  var fields = [
    { lbl: 'Hash', val: block.hash || '--', copy: block.hash },
    { lbl: 'Height', val: fmt(block._height) },
    { lbl: 'Timestamp', val: fullDate(block.time) },
    { lbl: 'Transactions', val: String(block.txCount || 0) },
    { lbl: 'Gas Used', val: fmtCompact(block._gasUsed) },
    { lbl: 'Base Gas', val: fmtCompact(hex(block.baseGas || '0')) },
    { lbl: 'EMA', val: fmt(hex(block.ema || '0')) },
    { lbl: 'Size', val: fmt(block.size || 0) + ' bytes' },
    { lbl: 'Weight', val: fmt(block.weight || 0) },
    { lbl: 'Merkle Root', val: shortHash(block.merkleRoot || ''), copy: block.merkleRoot },
    { lbl: 'Prev Block', val: shortHash(block.previousBlockHash || ''), copy: block.previousBlockHash },
    { lbl: 'Storage Root', val: shortHash(block.storageRoot || ''), copy: block.storageRoot },
  ];
  meta.innerHTML = fields.map(function(f) {
    var cls = f.copy ? 'bd-meta__val copyable' : 'bd-meta__val';
    var attr = f.copy ? ' data-copy="' + escHtml(f.copy) + '"' : '';
    return '<div class="bd-meta"><span class="bd-meta__lbl">' + escHtml(f.lbl) + '</span><span class="' + cls + '"' + attr + '>' + escHtml(f.val) + '</span></div>';
  }).join('');

  if (block.transactions && block.transactions.length > 0) {
    txs.innerHTML = '<h4 style="font-size:13px;font-weight:600;color:var(--c-t2);margin:12px 0 8px">Transactions (' + block.transactions.length + ')</h4>' +
      block.transactions.map(function(tx) { return renderTxCard(tx, false); }).join('');
    initTxCardInteractions(txs);
  } else if (block.txCount > 0) {
    txs.innerHTML = '<p style="color:var(--c-t3);font-size:12px;padding:12px 0">Loading transaction data\u2026</p>';
  } else {
    txs.innerHTML = '<p style="color:var(--c-t3);font-size:12px;padding:12px 0">No transactions in this block.</p>';
  }
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideBlockDetail() { $('blockDetail').style.display = 'none'; }

/* ===== TX Card ===== */
function renderTxCard(tx, isPending) {
  var hash = tx.hash || tx.id || '';
  var opType = tx.OPNetType || tx.transactionType || 'Generic';
  var badgeCls = 'badge--generic', label = opType;
  if (isPending) { badgeCls = 'badge--pending'; label = 'Pending'; }
  else if (opType === 'Interaction') badgeCls = 'badge--interaction';
  else if (opType === 'Deployment') badgeCls = 'badge--deployment';

  var events = tx.events || [];
  var gasUsed = tx.gasUsed ? fmtCompact(hex(tx.gasUsed)) : '';
  var contract = tx.contractAddress ? shortAddr(tx.contractAddress) : '';
  var from = tx.from || tx.fromLegacy || '';
  var burned = tx.burnedBitcoin ? hex(tx.burnedBitcoin) : 0;

  var info = [];
  if (gasUsed) info.push('<span>Gas: ' + gasUsed + '</span>');
  if (contract) info.push('<span>Contract: ' + escHtml(contract) + '</span>');
  if (burned > 0) info.push('<span>Burned: ' + satsToBtc(burned) + ' BTC</span>');
  if (from) info.push('<span>From: ' + escHtml(shortAddr(from)) + '</span>');
  if (isPending && tx.firstSeen) info.push('<span>' + timeAgo(tx.firstSeen) + '</span>');
  if (!isPending && tx.blockNumber) info.push('<span>Block #' + fmt(hex(tx.blockNumber)) + '</span>');

  var evtHtml = renderEventBadges(events);
  var chevron = '<svg class="tx-card__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

  var detail = '';
  if (hash) {
    detail = '<div class="tx-card__expand"><div class="tx-card__detail">';
    detail += '<div class="tx-card__detail-row"><span class="tx-card__detail-lbl">Full Hash</span><span class="tx-card__detail-val copyable" data-copy="' + escHtml(hash) + '">' + escHtml(hash) + '</span></div>';
    if (tx.contractAddress) detail += '<div class="tx-card__detail-row"><span class="tx-card__detail-lbl">Contract</span><span class="tx-card__detail-val copyable" data-copy="' + escHtml(tx.contractAddress) + '">' + escHtml(tx.contractAddress) + '</span></div>';
    if (tx.from) detail += '<div class="tx-card__detail-row"><span class="tx-card__detail-lbl">From (MLDSA)</span><span class="tx-card__detail-val" style="font-size:9px">' + escHtml(tx.from) + '</span></div>';
    if (tx.gasUsed) detail += '<div class="tx-card__detail-row"><span class="tx-card__detail-lbl">Gas Used</span><span class="tx-card__detail-val">' + fmt(hex(tx.gasUsed)) + '</span></div>';
    if (burned > 0) detail += '<div class="tx-card__detail-row"><span class="tx-card__detail-lbl">Burned BTC</span><span class="tx-card__detail-val" style="color:var(--c-btc)">' + satsToBtc(burned) + ' BTC</span></div>';
    if (events.length > 0) {
      detail += '<div class="tx-card__detail-events">';
      for (var i = 0; i < events.length; i++) {
        var evt = events[i], ei = classifyEvent(evt.type);
        detail += '<div class="tx-card__detail-evt"><span class="evt ' + ei.cls + '">' + escHtml(ei.label) + '</span><span class="mono">' + escHtml(shortAddr(evt.contractAddress || '')) + '</span></div>';
      }
      detail += '</div>';
    }
    if (/^[0-9a-fA-F]{64}$/.test(hash)) detail += '<a class="tx-card__more" data-explore="' + escHtml(hash) + '">View Full Details \u2192</a>';
    detail += '</div></div>';
  }

  return '<div class="tx-card" data-hash="' + escHtml(hash) + '" data-type="' + escHtml(opType) + '">' +
    '<div class="tx-card__top"><span class="badge ' + badgeCls + '">' + escHtml(label) + '</span>' +
    (isPending && opType !== 'Generic' ? '<span class="badge badge--' + (opType === 'Interaction' ? 'interaction' : opType === 'Deployment' ? 'deployment' : 'generic') + '">' + escHtml(opType) + '</span>' : '') +
    '<span class="tx-card__hash">' + escHtml(shortHash(hash)) + '</span>' + evtHtml + chevron + '</div>' +
    (info.length ? '<div class="tx-card__info">' + info.join('') + '</div>' : '') + detail + '</div>';
}

function initTxCardInteractions(container) {
  container.querySelectorAll('.tx-card').forEach(function(card) {
    card.addEventListener('click', function(e) {
      if (e.target.closest('.tx-card__more') || e.target.closest('.copyable')) return;
      card.classList.toggle('tx-card--expanded');
    });
  });
  container.querySelectorAll('.tx-card__more').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.stopPropagation();
      var hash = link.dataset.explore;
      if (hash) { $('searchInput').value = hash; switchTab('explorer'); search(); }
    });
  });
}

/* ===== TX Feeds ===== */
function updateLatestTxs() {
  var container = $('latestTxList');
  if (!container) return;
  var txs = [];
  for (var i = 0; i < state.blocks.length; i++) {
    var b = state.blocks[i];
    if (b.transactions && Array.isArray(b.transactions)) {
      for (var j = 0; j < b.transactions.length; j++) {
        var tx = b.transactions[j];
        tx._blockTime = b.time; tx._blockHeight = b._height;
        if (!tx.blockNumber) tx.blockNumber = '0x' + b._height.toString(16);
        txs.push(tx);
      }
    }
  }
  txs.sort(function(a, b) { return a._blockHeight !== b._blockHeight ? b._blockHeight - a._blockHeight : (b.index||0) - (a.index||0); });
  if (state.txFilter !== 'all') txs = txs.filter(function(tx) { return (tx.OPNetType || 'Generic') === state.txFilter; });

  // Update TX stats
  var totalTx = 0, interTx = 0, deployTx = 0, genericTx = 0;
  for (var s = 0; s < state.blocks.length; s++) {
    var bt = state.blocks[s];
    if (bt.transactions) {
      for (var t = 0; t < bt.transactions.length; t++) {
        totalTx++;
        var tp = bt.transactions[t].OPNetType || 'Generic';
        if (tp === 'Interaction') interTx++;
        else if (tp === 'Deployment') deployTx++;
        else genericTx++;
      }
    }
  }
  setAndPulse('txStatTotal', fmt(totalTx));
  setAndPulse('txStatInter', fmt(interTx));
  setAndPulse('txStatDeploy', fmt(deployTx));
  setAndPulse('txStatGeneric', fmt(genericTx));

  var display = txs.slice(0, 50);
  state.latestTxs = display;
  if (!display.length) {
    var msg = state.txFilter !== 'all' ? 'No ' + state.txFilter.toLowerCase() + ' transactions found.' : 'No transactions found.';
    container.innerHTML = '<div class="tx-list__empty">' + msg + '</div>'; return;
  }
  container.innerHTML = display.map(function(tx) { return renderTxCard(tx, false); }).join('');
  initTxCardInteractions(container);
}

function updatePendingTxs() {
  var container = $('pendingTxList');
  if (!container) return;
  var txs = state.pendingTxs;
  $('pendingCount').textContent = txs.length;
  if (!txs.length) { container.innerHTML = '<div class="tx-list__empty">No pending transactions.</div>'; return; }
  container.innerHTML = txs.map(function(tx) { return renderTxCard(tx, true); }).join('');
  initTxCardInteractions(container);
}

/* ===== Contract Tracking ===== */
function trackContracts(block) {
  if (!block.transactions) return;
  for (var i = 0; i < block.transactions.length; i++) {
    var tx = block.transactions[i];
    var ca = tx.contractAddress;
    if (!ca) continue;
    if (!state.contracts[ca]) {
      state.contracts[ca] = { address: ca, hexAddr: null, firstSeen: block._height, lastSeen: block._height, interactions: 0, deployTx: null, events: [] };
    }
    var c = state.contracts[ca];
    c.lastSeen = Math.max(c.lastSeen, block._height);
    c.firstSeen = Math.min(c.firstSeen, block._height);
    c.interactions++;
    if (tx.OPNetType === 'Deployment') c.deployTx = tx.hash;
    // Extract hex address for OP20 calls
    if (!c.hexAddr) {
      if (tx.contractPublicKey) c.hexAddr = b64ToHex(tx.contractPublicKey);
      if (!c.hexAddr && tx.events) {
        for (var e2 = 0; e2 < tx.events.length; e2++) {
          var ea = tx.events[e2].contractAddress;
          if (ea && ea.startsWith('0x') && ea.length === 66) { c.hexAddr = ea; break; }
        }
      }
    }
    if (tx.events) {
      for (var e = 0; e < tx.events.length; e++) {
        var type = tx.events[e].type;
        if (type && c.events.indexOf(type) === -1) c.events.push(type);
      }
    }
  }
}

function updateContractCatalog() {
  var container = $('contractCatalog');
  if (!container) return;
  var list = Object.values(state.contracts);
  list.sort(function(a, b) { return b.interactions - a.interactions; });

  $('contractCount').textContent = list.length;

  if (!list.length) { container.innerHTML = '<div class="tx-list__empty">No contracts discovered yet.</div>'; return; }

  var html = '';
  for (var i = 0; i < Math.min(list.length, 30); i++) {
    var c = list[i];
    var evtBadges = c.events.slice(0, 4).map(function(e) {
      var info = classifyEvent(e);
      return '<span class="evt ' + info.cls + '" style="font-size:9px">' + escHtml(info.label) + '</span>';
    }).join('');
    html += '<div class="contract-card" data-addr="' + escHtml(c.address) + '">' +
      '<div class="cc-top"><span class="cc-addr mono copyable" data-copy="' + escHtml(c.address) + '">' + escHtml(shortAddr(c.address)) + '</span>' +
      '<span class="cc-count">' + c.interactions + ' calls</span></div>' +
      '<div class="cc-meta">Blocks #' + c.firstSeen + ' \u2013 #' + c.lastSeen + '</div>' +
      (evtBadges ? '<div class="cc-events">' + evtBadges + '</div>' : '') +
    '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.contract-card').forEach(function(el) {
    el.addEventListener('click', function() {
      var addr = el.dataset.addr;
      if (addr) { $('searchInput').value = addr; switchTab('explorer'); search(); }
    });
  });
}

/* ===== Network Stats ===== */
function updateNetworkStats() {
  if (state.allBlocks.length < 2) return;
  var recent = state.allBlocks.slice(0, 30);
  var times = [];
  for (var i = 0; i < recent.length - 1; i++) {
    var diff = recent[i].time - recent[i + 1].time;
    if (diff > 0) times.push(diff);
  }
  var avgMs = times.length > 0 ? times.reduce(function(a, b) { return a + b; }, 0) / times.length : 0;
  var sec = Math.round(avgMs / 1000);
  var avgStr = sec >= 60 ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's' : sec + 's';

  var totalTxs = 0, opnetTxs = 0, totalGas = 0;
  for (var j = 0; j < state.allBlocks.length; j++) {
    totalTxs += state.allBlocks[j].txCount || 0;
    opnetTxs += countOpnetTxs(state.allBlocks[j]);
    totalGas += state.allBlocks[j]._gasUsed || 0;
  }
  var avgGas = state.allBlocks.length > 0 ? totalGas / state.allBlocks.length : 0;
  setAndPulse('nsAvgTime', avgStr);
  setAndPulse('nsTotalTxs', fmt(totalTxs));
  setAndPulse('nsOpnetTxs', fmt(opnetTxs));
  setAndPulse('nsAvgGas', fmtCompact(Math.round(avgGas)));
  setAndPulse('nsContracts', Object.keys(state.contracts).length.toString());
}

/* ===== Explorer Search ===== */
function isAddress(input) { return /^(tb1|bc1|bcrt1|opt1)/.test(input); }
function isTxHash(input) { return /^[0-9a-fA-F]{64}$/.test(input); }
function isBlockNum(input) { return /^\d+$/.test(input) && parseInt(input, 10) > 0; }

async function search() {
  var raw = $('searchInput').value.trim();
  var resultEl = $('searchResult'), errorEl = $('searchError');
  resultEl.style.display = 'none'; errorEl.style.display = 'none';
  if (!raw) { errorEl.textContent = 'Enter an address, transaction hash, or block number.'; errorEl.style.display = 'block'; return; }
  saveSearchHistory(raw);
  if (isBlockNum(raw))        await searchBlock(parseInt(raw, 10), resultEl, errorEl);
  else if (isAddress(raw))    await searchAddress(raw, resultEl, errorEl);
  else if (isTxHash(raw))     await searchTx(raw, resultEl, errorEl);
  else { errorEl.textContent = 'Invalid input. Enter a Bitcoin address, 64-char hex tx hash, or block number.'; errorEl.style.display = 'block'; }
}

async function searchBlock(num, resultEl, errorEl) {
  try {
    var block = await fetchBlock(num, true);
    if (!block) { errorEl.textContent = 'Block #' + num + ' not found.'; errorEl.style.display = 'block'; return; }
    block._height = typeof block.height === 'string' ? parseInt(block.height, 10) : (block.height || num);
    block._gasUsed = typeof block.gasUsed === 'number' ? block.gasUsed : hex(block.gasUsed || '0');
    trackContracts(block);

    var txTypes = { Generic: 0, Interaction: 0, Deployment: 0 };
    if (block.transactions) block.transactions.forEach(function(tx) { txTypes[tx.OPNetType || 'Generic']++; });

    var html = '<div class="rc-head"><span class="badge badge--interaction">Block</span><span class="rc-id">#' + fmt(block._height) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Hash</span><span class="rc-val rc-val--dim copyable" data-copy="' + escHtml(block.hash) + '">' + escHtml(block.hash) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Time</span><span class="rc-val">' + fullDate(block.time) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Transactions</span><span class="rc-val">' + (block.txCount || 0) + ' (' + txTypes.Interaction + ' OPNet, ' + txTypes.Deployment + ' deploy)</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Gas Used</span><span class="rc-val rc-val--blue">' + fmtCompact(block._gasUsed) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Base Gas</span><span class="rc-val">' + fmtCompact(hex(block.baseGas || '0')) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Size</span><span class="rc-val">' + fmt(block.size || 0) + ' bytes</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Weight</span><span class="rc-val">' + fmt(block.weight || 0) + '</span></div>';

    if (block.transactions && block.transactions.length > 0) {
      html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--c-border)"><h4 style="font-size:12px;font-weight:600;color:var(--c-t2);margin-bottom:8px">Transactions</h4>';
      html += block.transactions.map(function(tx) { return renderTxCard(tx, false); }).join('');
      html += '</div>';
    }
    resultEl.innerHTML = html; resultEl.style.display = 'block';
    initTxCardInteractions(resultEl);
  } catch (err) { errorEl.textContent = 'Block lookup failed: ' + err.message; errorEl.style.display = 'block'; }
}

async function searchAddress(addr, resultEl, errorEl) {
  try {
    var isContract = addr.startsWith('opt1');
    var promises = [fetchBalance(addr)];
    if (isContract) promises.push(fetchCode(addr).catch(function() { return null; }));

    var results = await Promise.all(promises);
    var bal = results[0];
    var sats = parseBalance(bal);
    var code = results[1];
    var hasCode = code && code.bytecode && code.bytecode.length > 10;

    var html = '<div class="rc-head"><span class="badge ' + (hasCode ? 'badge--deployment' : 'badge--generic') + '">' + (hasCode ? 'Contract' : 'Address') + '</span><span class="rc-id copyable" data-copy="' + escHtml(addr) + '">' + escHtml(addr) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">BTC Balance</span><span class="rc-val rc-val--btc">' + satsToBtc(sats) + ' BTC</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Satoshis</span><span class="rc-val">' + fmt(sats) + '</span></div>';

    if (hasCode) {
      var bcLen = 0;
      try { bcLen = atob(code.bytecode).length; } catch(e) {}
      html += '<div class="rc-row"><span class="rc-lbl">Bytecode Size</span><span class="rc-val rc-val--blue">' + fmtCompact(bcLen) + ' bytes</span></div>';
      var cInfo = state.contracts[addr];
      if (cInfo) {
        html += '<div class="rc-row"><span class="rc-lbl">Interactions</span><span class="rc-val">' + cInfo.interactions + '</span></div>' +
          '<div class="rc-row"><span class="rc-lbl">Active Blocks</span><span class="rc-val">#' + cInfo.firstSeen + ' \u2013 #' + cInfo.lastSeen + '</span></div>';
        if (cInfo.events.length) html += '<div class="rc-row"><span class="rc-lbl">Event Types</span><span class="rc-val">' + cInfo.events.map(function(e) { var i = classifyEvent(e); return '<span class="evt ' + i.cls + '" style="font-size:9px">' + escHtml(i.label) + '</span>'; }).join(' ') + '</span></div>';
      }
    }

    // Scan loaded blocks for address activity
    var activity = [];
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      if (!b.transactions) continue;
      for (var j = 0; j < b.transactions.length; j++) {
        var tx = b.transactions[j];
        if (tx.contractAddress === addr || (tx.fromLegacy || '') === addr) {
          activity.push(tx);
        }
      }
    }
    if (activity.length > 0) {
      html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--c-border)"><h4 style="font-size:12px;font-weight:600;color:var(--c-t2);margin-bottom:8px">Recent Activity (' + activity.length + ')</h4>';
      html += activity.slice(0, 20).map(function(tx) { return renderTxCard(tx, false); }).join('');
      html += '</div>';
    }

    resultEl.innerHTML = html; resultEl.style.display = 'block';
    initTxCardInteractions(resultEl);
  } catch (err) { errorEl.textContent = 'Address lookup failed: ' + err.message; errorEl.style.display = 'block'; }
}

async function searchTx(hash, resultEl, errorEl) {
  try {
    var prom = [fetchTx(hash), fetchReceipt(hash).catch(function() { return null; })];
    var res = await Promise.all(prom);
    var tx = res[0], receipt = res[1];
    if (!tx) { errorEl.textContent = 'Transaction not found.'; errorEl.style.display = 'block'; return; }

    var typeCls = tx.OPNetType === 'Interaction' ? 'badge--interaction' : tx.OPNetType === 'Deployment' ? 'badge--deployment' : 'badge--generic';
    var burned = tx.burnedBitcoin ? hex(tx.burnedBitcoin) : 0;
    var events = tx.events || [];

    var html = '<div class="rc-head"><span class="badge ' + typeCls + '">' + escHtml(tx.OPNetType || 'Generic') + '</span><span class="rc-id copyable" data-copy="' + escHtml(hash) + '">' + escHtml(hash) + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Block</span><span class="rc-val rc-val--blue">' + (tx.blockNumber ? '#' + fmt(hex(tx.blockNumber)) : 'Pending') + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Gas Used</span><span class="rc-val">' + (tx.gasUsed ? fmtCompact(hex(tx.gasUsed)) : '0') + '</span></div>' +
      '<div class="rc-row"><span class="rc-lbl">Events</span><span class="rc-val">' + events.length + '</span></div>';

    if (receipt) {
      if (receipt.gasUsed) html += '<div class="rc-row"><span class="rc-lbl">Receipt Gas</span><span class="rc-val">' + fmtCompact(hex(receipt.gasUsed)) + '</span></div>';
      if (receipt.specialGasUsed) html += '<div class="rc-row"><span class="rc-lbl">Special Gas</span><span class="rc-val">' + fmtCompact(hex(receipt.specialGasUsed)) + '</span></div>';
    }
    if (burned > 0) html += '<div class="rc-row"><span class="rc-lbl">Burned BTC</span><span class="rc-val rc-val--btc">' + satsToBtc(burned) + ' BTC</span></div>';
    if (tx.contractAddress) html += '<div class="rc-row"><span class="rc-lbl">Contract</span><span class="rc-val rc-val--dim copyable" data-copy="' + escHtml(tx.contractAddress) + '">' + escHtml(tx.contractAddress) + '</span></div>';
    if (tx.from) html += '<div class="rc-row"><span class="rc-lbl">From (MLDSA)</span><span class="rc-val rc-val--dim copyable" data-copy="' + escHtml(tx.from) + '" style="font-size:10px">' + escHtml(tx.from) + '</span></div>';
    if (tx.fromLegacy) html += '<div class="rc-row"><span class="rc-lbl">From (Legacy)</span><span class="rc-val rc-val--dim copyable" data-copy="' + escHtml(tx.fromLegacy) + '">' + escHtml(shortAddr(tx.fromLegacy)) + '</span></div>';
    if (tx.inputs && tx.inputs.length) html += '<div class="rc-row"><span class="rc-lbl">Inputs</span><span class="rc-val">' + tx.inputs.length + '</span></div>';
    if (tx.outputs && tx.outputs.length) html += '<div class="rc-row"><span class="rc-lbl">Outputs</span><span class="rc-val">' + tx.outputs.length + '</span></div>';
    if (tx.priorityFee) html += '<div class="rc-row"><span class="rc-lbl">Priority Fee</span><span class="rc-val">' + fmt(hex(tx.priorityFee)) + '</span></div>';
    if (tx.wasCompressed !== undefined) html += '<div class="rc-row"><span class="rc-lbl">Compressed</span><span class="rc-val">' + (tx.wasCompressed ? 'Yes' : 'No') + '</span></div>';

    if (events.length > 0) {
      html += '<div class="rc-events"><div class="rc-events__title">Events (' + events.length + ')</div>';
      for (var i = 0; i < events.length; i++) {
        var evt = events[i], ei = classifyEvent(evt.type);
        html += '<div class="rc-event"><div class="rc-event__head"><span class="evt ' + ei.cls + '">' + escHtml(ei.label) + '</span><span class="rc-event__contract copyable" data-copy="' + escHtml(evt.contractAddress || '') + '">' + escHtml(shortAddr(evt.contractAddress || '')) + '</span></div>';
        if (evt.data) {
          var decoded = tryDecodeBase64(evt.data);
          html += '<div style="font-family:var(--mono);font-size:10px;color:var(--c-t3);margin-top:4px;word-break:break-all;max-height:60px;overflow:hidden">' + escHtml(decoded.slice(0, 300)) + (decoded.length > 300 ? '\u2026' : '') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    resultEl.innerHTML = html; resultEl.style.display = 'block';
  } catch (err) { errorEl.textContent = 'Transaction lookup failed: ' + err.message; errorEl.style.display = 'block'; }
}

/* ===== Copy / Keyboard / Toast ===== */
function initCopyable() {
  document.addEventListener('click', function(e) {
    var el = e.target.closest('.copyable');
    if (!el || !el.dataset.copy) return;
    navigator.clipboard.writeText(el.dataset.copy).then(function() { toast('Copied'); }).catch(function() {
      var ta = document.createElement('textarea'); ta.value = el.dataset.copy; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('Copied');
    });
  });
}

function initKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
    switch (e.key) {
      case '1': switchTab('overview'); break;
      case '2': switchTab('blocks'); break;
      case '3': switchTab('txs'); break;
      case '4': switchTab('explorer'); break;
      case '5': switchTab('profile'); break;
      case '/': e.preventDefault(); switchTab('explorer'); break;
      case 'Escape':
        hideBlockDetail();
        document.querySelectorAll('.tx-card--expanded').forEach(function(c) { c.classList.remove('tx-card--expanded'); });
        break;
    }
  });
}

function toast(msg) {
  var wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  var el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; wrap.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('show'); });
  setTimeout(function() { el.classList.remove('show'); setTimeout(function() { el.remove(); }, 250); }, 2500);
}

/* ===== Search History ===== */
function saveSearchHistory(q) {
  try { var h = JSON.parse(localStorage.getItem('op_search_history') || '[]'); h = h.filter(function(x) { return x !== q; }); h.unshift(q); if (h.length > 5) h = h.slice(0, 5); localStorage.setItem('op_search_history', JSON.stringify(h)); renderSearchHistory(); } catch(e) {}
}
function renderSearchHistory() {
  var c = $('searchHistory'); if (!c) return;
  try {
    var h = JSON.parse(localStorage.getItem('op_search_history') || '[]');
    if (!h.length) { c.innerHTML = ''; return; }
    c.innerHTML = '<span style="font-size:10px;color:var(--c-t3);margin-right:4px">Recent:</span>' +
      h.map(function(q) { var d = q.length > 20 ? q.slice(0,8)+'\u2026'+q.slice(-8) : q; return '<span class="sh-chip" data-query="'+escHtml(q)+'">'+escHtml(d)+'</span>'; }).join('');
    c.querySelectorAll('.sh-chip').forEach(function(chip) { chip.addEventListener('click', function() { $('searchInput').value = chip.dataset.query; search(); }); });
  } catch(e) {}
}

/* ===== Wallet ===== */
function hasOPWallet() { return typeof window !== 'undefined' && typeof window.opnet !== 'undefined'; }

async function connectWallet() {
  if (!hasOPWallet()) { toast('OP_WALLET not detected.'); return; }
  try {
    var accounts = await window.opnet.requestAccounts();
    if (!accounts || !accounts.length) { toast('No accounts.'); return; }
    var addr = typeof accounts[0] === 'string' ? accounts[0] : (accounts[0].address || String(accounts[0]));
    state.wallet = { address: addr, balance: null, publicKey: null };
    // Get public key from wallet (used for OP20 balanceOf calls)
    try { state.wallet.publicKey = await window.opnet.getPublicKey(); } catch(e) {}
    // Fetch BTC balance
    try { var bal = await fetchBalance(addr); state.wallet.balance = parseBalance(bal); } catch(e) { console.warn('Balance fetch:', e); }
    updateWalletUI();
    updateWalletPortfolio(); // Show BTC balance in profile immediately
    loadWalletPortfolio();   // Then async load UTXOs + tx history
    ensureKnownTokens();
    loadTokenBalances();
    try { localStorage.setItem('op_wallet_connected', '1'); } catch(e) {}
    toast('Wallet connected');
  } catch (err) { toast('Wallet: ' + (err.message || 'Connection refused')); }
}

function disconnectWallet() {
  state.wallet = null; state.walletUTXOs = []; state.walletActivity = []; state.tokenBalances = {};
  try { localStorage.removeItem('op_wallet_connected'); } catch(e) {}
  updateWalletUI(); updateWalletPortfolio(); updateTokenHoldings(); toast('Wallet disconnected.');
}

function updateWalletUI() {
  var btn = $('walletBtn'), label = $('walletBtnLabel'), empty = $('walletEmpty'), info = $('walletInfo');
  if (state.wallet) {
    btn.classList.add('connected'); label.textContent = shortAddr(state.wallet.address);
    empty.style.display = 'none'; info.style.display = 'flex';
    $('wAddr').textContent = state.wallet.address; $('wAddr').dataset.copy = state.wallet.address;
    var wBal = state.wallet.balance || 0;
    $('wBtc').textContent = satsToBtc(wBal); $('wSats').textContent = fmt(wBal) + ' sats';
  } else {
    btn.classList.remove('connected'); label.textContent = 'Connect';
    empty.style.display = 'flex'; info.style.display = 'none';
  }
}

/* ===== Wallet Portfolio ===== */
async function loadWalletPortfolio() {
  if (!state.wallet) { updateWalletPortfolio(); return; }

  // Fetch UTXOs
  try {
    var resp = await fetchUTXOs(state.wallet.address);
    var utxos = [];
    if (Array.isArray(resp)) utxos = resp;
    else if (resp && typeof resp === 'object') {
      if (Array.isArray(resp.confirmed)) utxos = utxos.concat(resp.confirmed);
      if (Array.isArray(resp.pending)) utxos = utxos.concat(resp.pending);
    }
    state.walletUTXOs = utxos;
  } catch(e) { state.walletUTXOs = []; }

  // Build activity from ALL loaded blocks that have tx data
  var activity = [], seen = {}, addr = state.wallet.address.toLowerCase();
  var sources = state.allBlocks.length > state.blocks.length ? state.allBlocks : state.blocks;
  for (var i = 0; i < sources.length; i++) {
    var b = sources[i]; if (!b.transactions) continue;
    for (var j = 0; j < b.transactions.length; j++) {
      var tx = b.transactions[j];
      if (seen[tx.hash]) continue;
      var involved = (tx.fromLegacy || '').toLowerCase() === addr;
      if (!involved && tx.inputs) for (var k = 0; k < tx.inputs.length; k++) if ((tx.inputs[k].address||'').toLowerCase() === addr) { involved = true; break; }
      if (!involved && tx.outputs) for (var k = 0; k < tx.outputs.length; k++) if ((tx.outputs[k].address||'').toLowerCase() === addr) { involved = true; break; }
      if (involved) {
        seen[tx.hash] = true;
        activity.push({ hash: tx.hash, type: tx.OPNetType||'Generic', blockHeight: b._height, time: b.time, from: tx.fromLegacy||tx.from||'', contractAddress: tx.contractAddress });
      }
    }
  }

  // Fetch actual transactions referenced by UTXOs (real on-chain history for this address)
  var utxoHashes = [];
  for (var u = 0; u < state.walletUTXOs.length; u++) {
    var txid = state.walletUTXOs[u].transactionId || state.walletUTXOs[u].txid || state.walletUTXOs[u].hash;
    if (txid && !seen[txid]) { utxoHashes.push(txid); seen[txid] = true; }
  }
  var discoveredContracts = false;
  if (utxoHashes.length > 0) {
    for (var ui = 0; ui < utxoHashes.length; ui += 5) {
      var batch = utxoHashes.slice(ui, ui + 5);
      var results = await Promise.all(batch.map(function(h) { return fetchTx(h).catch(function() { return null; }); }));
      for (var ri = 0; ri < results.length; ri++) {
        var rtx = results[ri];
        if (!rtx) continue;
        var bn = rtx.blockNumber ? hex(rtx.blockNumber) : 0;
        activity.push({ hash: rtx.hash || rtx.id || batch[ri], type: rtx.OPNetType || 'Generic', blockHeight: bn, time: null, from: rtx.fromLegacy || rtx.from || '', contractAddress: rtx.contractAddress });
        // Discover contract addresses from wallet transactions
        if (rtx.contractAddress && !state.contracts[rtx.contractAddress]) {
          var txHex = null;
          if (rtx.contractPublicKey) txHex = b64ToHex(rtx.contractPublicKey);
          if (!txHex && rtx.events) {
            for (var ei = 0; ei < rtx.events.length; ei++) {
              var ea = rtx.events[ei].contractAddress;
              if (ea && ea.startsWith('0x') && ea.length === 66) { txHex = ea; break; }
            }
          }
          if (txHex) {
            state.contracts[rtx.contractAddress] = { address: rtx.contractAddress, hexAddr: txHex, firstSeen: bn, lastSeen: bn, interactions: 1, deployTx: null, events: [] };
            discoveredContracts = true;
          }
        }
      }
    }
  }

  activity.sort(function(a, b) { return b.blockHeight - a.blockHeight; });
  state.walletActivity = activity;
  updateWalletPortfolio();

  // If we discovered new contracts from wallet txs, re-detect tokens
  if (discoveredContracts && !state.tokensLoading) setTimeout(detectTokens, 200);
}

function updateWalletPortfolio() {
  var p = $('walletPortfolio'), pe = $('profileEmpty');
  if (!p) return;
  if (!state.wallet) { p.style.display = 'none'; if (pe) pe.style.display = 'flex'; return; }
  p.style.display = 'block'; if (pe) pe.style.display = 'none';
  $('wpBtc').textContent = satsToBtc(state.wallet.balance || 0);
  $('wpSats').textContent = fmt(state.wallet.balance || 0) + ' sats';
  $('wpAddr').textContent = state.wallet.address; $('wpAddr').dataset.copy = state.wallet.address;

  $('wpUtxoCount').textContent = state.walletUTXOs.length;
  var utxoEl = $('wpUtxoList');
  if (!state.walletUTXOs.length) { utxoEl.innerHTML = '<span class="wp-empty">No UTXOs found</span>'; }
  else {
    var h = ''; var show = Math.min(state.walletUTXOs.length, 20);
    for (var i = 0; i < show; i++) {
      var u = state.walletUTXOs[i]; var txid = u.transactionId||u.txid||u.hash||'--';
      var val = typeof u.value === 'string' ? hex(u.value) : (u.value||u.amount||0);
      var vout = u.outputIndex !== undefined ? u.outputIndex : (u.vout !== undefined ? u.vout : '?');
      h += '<div class="wp-utxo"><span class="wp-utxo__hash copyable" data-copy="'+escHtml(txid)+'">'+escHtml(shortHash(txid))+':'+vout+'</span><span class="wp-utxo__val">'+satsToBtc(val)+' BTC</span></div>';
    }
    utxoEl.innerHTML = h;
  }

  var actEl = $('wpActivityList');
  if (!state.walletActivity.length) { actEl.innerHTML = '<span class="wp-empty">No transactions found</span>'; }
  else {
    var ah = '';
    for (var a = 0; a < state.walletActivity.length; a++) {
      var act = state.walletActivity[a];
      var isOut = (act.from||'').toLowerCase() === state.wallet.address.toLowerCase();
      var iconCls = act.type === 'Interaction' ? 'wp-act__icon--contract' : isOut ? 'wp-act__icon--out' : 'wp-act__icon--in';
      var iconCh = act.type === 'Interaction' ? '\u2699' : isOut ? '\u2191' : '\u2193';
      var tLabel = act.type === 'Interaction' ? 'Contract Call' : act.type === 'Deployment' ? 'Deployment' : isOut ? 'Sent' : 'Received';
      ah += '<div class="wp-act" data-hash="'+escHtml(act.hash||'')+'"><div class="wp-act__icon '+iconCls+'">'+iconCh+'</div>' +
        '<div class="wp-act__body"><div class="wp-act__type">'+tLabel+(act.contractAddress?' \u00b7 '+escHtml(shortAddr(act.contractAddress)):'')+'</div>' +
        '<div class="wp-act__hash">'+escHtml(shortHash(act.hash||''))+'</div></div>' +
        '<div class="wp-act__time"><div>Block #'+fmt(act.blockHeight)+'</div><div>'+timeAgo(act.time)+'</div></div></div>';
    }
    actEl.innerHTML = ah;
    actEl.querySelectorAll('.wp-act').forEach(function(el) { el.addEventListener('click', function() { var h = el.dataset.hash; if (h) { $('searchInput').value = h; switchTab('explorer'); search(); } }); });
  }
}

/* ===== Block Loading (Progressive) ===== */
function normalizeBlock(block, num) {
  block._height = typeof block.height === 'string' ? parseInt(block.height, 10) : (block.height || num);
  block._gasUsed = typeof block.gasUsed === 'number' ? block.gasUsed : hex(block.gasUsed || '0');
  return block;
}

async function loadRecentBlocks(currentHeight) {
  var start = Math.max(1, currentHeight - RECENT_BLOCKS + 1);
  var fetches = [];
  for (var h = currentHeight; h >= start; h--) {
    var exists = state.blocks.some(function(b) { return b._height === h; });
    if (!exists) {
      (function(num) {
        fetches.push(fetchBlock(num, true).then(function(b) { return b ? normalizeBlock(b, num) : null; }).catch(function() { return null; }));
      })(h);
    }
  }
  if (fetches.length > 0) {
    var results = await Promise.all(fetches);
    var freshBlocks = [];
    results.forEach(function(b) {
      if (b && !state.blocks.some(function(x) { return x._height === b._height; })) {
        state.blocks.push(b);
        trackContracts(b);
        freshBlocks.push(b);
      }
    });
    if (freshBlocks.length) cacheBlocks(freshBlocks);
  }
  state.blocks.sort(function(a, b) { return b._height - a._height; });
  if (state.blocks.length > RECENT_BLOCKS) state.blocks = state.blocks.slice(0, RECENT_BLOCKS);

  // Build gas history from recent blocks
  state.gasHistory = [];
  var chartSlice = state.blocks.slice(0, CHART_BLOCKS);
  for (var g = chartSlice.length - 1; g >= 0; g--) {
    state.gasHistory.push({ height: chartSlice[g]._height, gasUsed: chartSlice[g]._gasUsed, block: chartSlice[g] });
  }

  rebuildAllBlocks();
  updateBlockTable();
  drawGasChart();
  updateLatestTxs();
  updateBlockViz();
  updateNetworkStats();
  updateContractCatalog();
  state.blocks.forEach(function(b) { state.prevHeights.add(b._height); });
  // Ensure known tokens are always loaded, then detect more from tracked contracts
  ensureKnownTokens();
  if (state.wallet) loadTokenBalances();
  if (!state.tokensLoading) setTimeout(detectTokens, 500);
}

function rebuildAllBlocks() {
  // Merge blocks and allBlocks (allBlocks are header-only historical blocks)
  var map = {};
  state.allBlocks.forEach(function(b) { map[b._height] = b; });
  state.blocks.forEach(function(b) { map[b._height] = b; }); // Recent blocks overwrite headers
  state.allBlocks = Object.values(map);
  state.allBlocks.sort(function(a, b) { return b._height - a._height; });
}

async function startBackgroundLoad() {
  if (state.bgLoading || !state.totalHeight) return;
  state.bgLoading = true;
  var total = state.totalHeight;
  state.bgTotal = total;

  // Load all block headers in batches (without tx data)
  var loaded = new Set();
  state.allBlocks.forEach(function(b) { loaded.add(b._height); });

  var toLoad = [];
  for (var h = total; h >= 1; h--) {
    if (!loaded.has(h)) toLoad.push(h);
  }

  state.bgTotal = total;
  state.bgLoaded = total - toLoad.length;
  updateBgProgress();

  for (var i = 0; i < toLoad.length; i += LOAD_CONCURRENCY) {
    var batch = toLoad.slice(i, i + LOAD_CONCURRENCY);
    var results = await Promise.all(batch.map(function(num) {
      return fetchBlock(num, false).then(function(b) { return b ? normalizeBlock(b, num) : null; }).catch(function() { return null; });
    }));
    var newBg = [];
    results.forEach(function(b) {
      if (b && !state.allBlocks.some(function(x) { return x._height === b._height; })) {
        state.allBlocks.push(b);
        newBg.push(b);
      }
    });
    if (newBg.length) cacheBlocks(newBg);
    state.bgLoaded += batch.length;
    updateBgProgress();

    // Periodically sort and update UI
    if (i % 100 === 0 || i + LOAD_CONCURRENCY >= toLoad.length) {
      state.allBlocks.sort(function(a, b) { return b._height - a._height; });
      updateBlockTable();
      updateNetworkStats();
    }
    await new Promise(function(r) { setTimeout(r, 50); });
  }

  state.allBlocks.sort(function(a, b) { return b._height - a._height; });
  state.bgLoading = false;
  updateBgProgress();
  updateBlockTable();
  updateNetworkStats();
}

function updateBgProgress() {
  var el = $('loadProgress');
  if (!el) return;
  if (state.bgLoading) {
    var pct = state.bgTotal > 0 ? Math.round(state.bgLoaded / state.bgTotal * 100) : 0;
    el.textContent = pct + '%';
    el.title = state.bgLoaded + ' / ' + state.bgTotal + ' blocks';
  } else {
    var total = state.totalHeight || state.allBlocks.length;
    el.textContent = state.allBlocks.length + '/' + total;
    el.title = state.allBlocks.length >= total ? 'Synced (cached)' : state.allBlocks.length + ' blocks cached';
  }
  updateSyncStatus();
}

function updateSyncStatus() {
  var el = $('syncStatus'), item = $('syncItem');
  if (!el || !item) return;
  if (!state.totalHeight) {
    el.textContent = '--';
    item.className = 'meta-item meta-item--sync';
    return;
  }
  var loaded = state.allBlocks.length;
  var total = state.totalHeight;
  var synced = loaded >= total;
  if (synced) {
    el.textContent = 'Synced';
    item.className = 'meta-item meta-item--sync synced';
  } else if (state.bgLoading) {
    var pct = total > 0 ? Math.round(loaded / total * 100) : 0;
    el.textContent = pct + '%';
    item.className = 'meta-item meta-item--sync syncing';
  } else {
    el.textContent = loaded + '/' + total;
    item.className = 'meta-item meta-item--sync syncing';
  }
}

/* ===== Refresh Countdown ===== */
function startCountdown() {
  setInterval(function() {
    state.pollCountdown--;
    if (state.pollCountdown < 0) state.pollCountdown = 0;
    var el = $('refreshCountdown');
    if (el) el.textContent = state.pollCountdown + 's';
  }, 1000);
}

/* ===== Polling ===== */
async function poll() {
  state.pollCountdown = POLL_MS / 1000;
  try {
    var results = await Promise.all([
      fetchHeight(), fetchGas(),
      fetchMempool().catch(function() { return null; }),
      fetchEpoch().catch(function() { return null; }),
    ]);
    var height = hex(results[0]), gas = results[1], mempool = results[2], epoch = results[3];
    setNetwork(true);
    state.totalHeight = height;
    document.title = 'OP_TERMINAL \u00b7 Block #' + fmt(height);
    updateSyncStatus();
    updateHeroStats(height, gas, mempool);
    updateEpoch(epoch);
    updateGasCard(gas);
    updateFeeCard(gas);
    updateMempoolCard(mempool);

    if (state.height === null || height > state.height) await loadRecentBlocks(height);
    state.height = height;

    try { var pending = await fetchPending(); state.pendingTxs = (pending && pending.transactions) ? pending.transactions : []; } catch(e) { state.pendingTxs = []; }
    updatePendingTxs();

    if (state.wallet) {
      try { var bal = await fetchBalance(state.wallet.address); state.wallet.balance = parseBalance(bal); updateWalletUI(); } catch(e) { console.warn('Poll balance failed:', e); }
      loadWalletPortfolio();
      ensureKnownTokens();
      loadTokenBalances();
    }

    // Start background load on first successful poll
    if (!state.bgLoading && state.allBlocks.length < state.totalHeight) {
      setTimeout(startBackgroundLoad, 2000);
    }
  } catch (err) {
    console.error('Poll error:', err);
    setNetwork(false);
  }
}

function refreshTimes() {
  var tbody = $('blockTbody');
  if (tbody) {
    tbody.querySelectorAll('tr[data-height]').forEach(function(tr) {
      var h = parseInt(tr.dataset.height, 10);
      var b = state.allBlocks.find(function(x) { return x._height === h; });
      if (b) { var cells = tr.querySelectorAll('td'); if (cells.length >= 6) cells[5].textContent = timeAgo(b.time); }
    });
  }
}

/* ===== Event Bindings ===== */
/* ===== Scroll Reveal Animations ===== */
function initScrollReveal() {
  var els = document.querySelectorAll('.reveal-on-scroll:not(.revealed)');
  if (!els.length) return;
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        e.target.classList.add('revealed');
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  els.forEach(function(el) { obs.observe(el); });
}

function applyRevealClasses() {
  var selectors = '.hero-card, .card, .ns-item, .profile-header, .tx-stat, .block-detail';
  document.querySelectorAll(selectors).forEach(function(el) {
    if (!el.classList.contains('reveal-on-scroll') && !el.classList.contains('revealed')) {
      el.classList.add('reveal-on-scroll');
    }
  });
  initScrollReveal();
}

function bindEvents() {
  $('walletBtn').addEventListener('click', function() { state.wallet ? disconnectWallet() : connectWallet(); });
  $('walletConnect2').addEventListener('click', connectWallet);
  $('walletDisconnect').addEventListener('click', disconnectWallet);
  $('closeBlockDetail').addEventListener('click', hideBlockDetail);
  $('searchBtn').addEventListener('click', search);
  $('searchInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') search(); });

  $('blockPrev').addEventListener('click', function() { if (state.blockPage > 0) { state.blockPage--; updateBlockTable(); } });
  $('blockNext').addEventListener('click', function() {
    var maxPage = Math.ceil(state.allBlocks.length / BLOCKS_PER_PAGE) - 1;
    if (state.blockPage < maxPage) { state.blockPage++; updateBlockTable(); }
  });

  // Profile tab buttons
  $('profileConnect').addEventListener('click', connectWallet);
  $('profDisconnect').addEventListener('click', disconnectWallet);
  $('viewProfile').addEventListener('click', function(e) { e.preventDefault(); switchTab('profile'); });

  // Mobile bottom nav
  $('mobileNav').addEventListener('click', function(e) {
    var item = e.target.closest('.mobile-nav__item');
    if (!item) return;
    e.preventDefault();
    switchTab(item.dataset.tab);
  });

  var resizeTimer = null;
  window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawGasChart, 100); });
}

/* ===== Init ===== */
document.addEventListener('DOMContentLoaded', async function() {
  initTabs();
  initTxSubTabs();
  initTxFilters();
  initGasChartHover();
  initCopyable();
  initKeyboard();
  bindEvents();
  startCountdown();
  renderSearchHistory();

  // URL hash routing
  var hash = location.hash.slice(1);
  if (hash && ['overview','blocks','txs','explorer','profile'].indexOf(hash) >= 0) switchTab(hash);

  // Pre-load known tokens so they're ready immediately
  ensureKnownTokens();

  // Apply scroll reveal animations
  applyRevealClasses();

  // Restore cached blocks from IndexedDB (instant sync on refresh)
  try {
    var cached = await loadCachedBlocks();
    if (cached.length) {
      // Filter out invalid cache entries
      cached = cached.filter(function(b) { return b && typeof b._height === 'number' && b._height > 0; });
      var seen = {};
      cached.forEach(function(b) {
        if (seen[b._height]) return; // dedupe
        seen[b._height] = true;
        state.allBlocks.push(b);
        if (b.transactions && b.transactions.length) {
          state.blocks.push(b);
          trackContracts(b);
        }
      });
      state.allBlocks.sort(function(a, b) { return b._height - a._height; });
      state.blocks.sort(function(a, b) { return b._height - a._height; });
      if (state.blocks.length > RECENT_BLOCKS) state.blocks = state.blocks.slice(0, RECENT_BLOCKS);
      state.gasHistory = [];
      var chartSlice = state.blocks.slice(0, CHART_BLOCKS);
      for (var g = chartSlice.length - 1; g >= 0; g--) {
        state.gasHistory.push({ height: chartSlice[g]._height, gasUsed: chartSlice[g]._gasUsed, block: chartSlice[g] });
      }
      updateBlockTable();
      drawGasChart();
      updateLatestTxs();
      updateBlockViz();
      updateNetworkStats();
      updateContractCatalog();
      state.blocks.forEach(function(b) { state.prevHeights.add(b._height); });
      console.log('Restored ' + cached.length + ' blocks from cache (' + state.blocks.length + ' with tx data)');
    }
  } catch(e) { console.warn('Cache restore failed:', e); }

  // Auto-reconnect wallet — try quickly, retry if wallet extension loads late
  try {
    if (localStorage.getItem('op_wallet_connected')) {
      if (hasOPWallet()) {
        setTimeout(connectWallet, 500);
      } else {
        // Wallet extension might load after page — retry at 1.5s and 3s
        setTimeout(function() { if (hasOPWallet() && !state.wallet) connectWallet(); }, 1500);
        setTimeout(function() { if (hasOPWallet() && !state.wallet) connectWallet(); }, 3000);
      }
    }
  } catch(e) {}

  poll();
  setInterval(poll, POLL_MS);
  setInterval(refreshTimes, 5000);
});
