/* Basket Random - online 2-player over Supabase Realtime (input sync / "lockstep").
 *
 * No video streaming. Both players run their own copy of the game. Only inputs travel over the
 * network, and both copies advance on a fixed clock, frame by frame, applying the same inputs on
 * the same frame. If both copies are deterministic they stay identical; a checksum is exchanged
 * every half second to detect drift.
 *
 *  - Player 1 (host) jumps with W / Up / Space.   Player 2 (guest) jumps with W / Up / Space too;
 *    the game sees them as W (P1) and Up (P2) respectively.
 *  - Lobby code = Supabase Realtime Broadcast channel name.
 *  - Online mode runs on a page loaded with ?online=host|join&code=XXXXX so that both copies start
 *    from the same state (game held right after its first tick, random numbers seeded from the code).
 */
(function () {
  'use strict';

  var SUPABASE_KEYS = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqZHVyamtta210aXB3bWNoamhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNTY2NzEsImV4cCI6MjEwOTgzMjY3MX0.-fHEK4hKk-u6gNri4gnu4W6E0-632aIfbuAd5HoYIe4',
    'sb_publishable_VVJDninJBigqq5swj8E2lQ_qg8t_XD3'
  ];
  // The project URL is derived from the project reference stored inside the key.
  var SUPABASE_URL = (function () {
    try { return 'https://' + JSON.parse(atob(SUPABASE_KEYS[0].split('.')[1])).ref + '.supabase.co'; }
    catch (e) { return ''; }
  })();

  var CHANNEL_PREFIX = 'bsktrnd-';
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  var LEN = 5;
  var FRAME_MS = 1000 / 60;
  var SEND_EVERY = 3;   // frames between packets
  var HASH_EVERY = 30;  // frames between state checksums
  var P1 = { which: 87, code: 'KeyW', key: 'w' };          // Player 1 in the game
  var P2 = { which: 38, code: 'ArrowUp', key: 'ArrowUp' }; // Player 2 in the game
  var JUMP = { KeyW: 1, ArrowUp: 1, Space: 1 };

  var qs = new URLSearchParams(location.search);
  var ROLE = qs.get('online');
  var CODE = (qs.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var ONLINE = (ROLE === 'host' || ROLE === 'join') && CODE.length === LEN;
  var MY = ROLE === 'host' ? 0 : 1; // my player index

  var S = { status: 'idle', msg: '', gameLoaded: false, paired: false, ready: false, peerReady: false,
            started: false, rtt: null, desync: null, waiting: false, panel: false };
  var me = Math.random().toString(36).slice(2, 10);
  var peerId = null;
  var mode = ONLINE ? 'hold' : 'free';   // free | hold | lock
  var heldCb = null, HELD_ID = -7777;
  var frame = 0, D = 0, remoteUpTo = -1, peerAck = -1, seq = 0, lastSeqIn = 0;
  var outLog = [], evAt = {}, hashMine = {}, hashPeer = {}, hashOut = [];
  var lastSend = 0, lastHeard = 0, rngLate = false;

  /* ---------------- helpers ---------------- */
  function getRt() {
    try { var ri = window.c3_runtimeInterface; return ri && ri._GetLocalRuntime ? ri._GetLocalRuntime() : null; }
    catch (e) { return null; }
  }
  function fnv(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randCode() {
    var s = '';
    for (var i = 0; i < LEN; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
    return s;
  }
  function log() { try { console.info.apply(console, ['[MP]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ---------------- take control of the game's clock ---------------- */
  var realRAF = window.requestAnimationFrame.bind(window);
  var realCAF = window.cancelAnimationFrame.bind(window);
  if (ONLINE) {
    // The game asks for its next tick with requestAnimationFrame. We catch exactly that callback and
    // run it ourselves, at a fixed pace, only when both players' inputs for that frame are known.
    window.requestAnimationFrame = function (cb) {
      if (mode !== 'free') {
        var rt = getRt();
        if (rt && rt._tickCallbacks && cb === rt._tickCallbacks.normal) { heldCb = cb; return HELD_ID; }
      }
      return realRAF(cb);
    };
    window.cancelAnimationFrame = function (id) {
      if (id === HELD_ID) { heldCb = null; return; }
      return realCAF(id);
    };
    // Seed the game's random numbers from the lobby code, before the game starts.
    var rngTimer = setInterval(function () {
      var rt = getRt();
      if (rt && rt.SetRandomNumberGeneratorCallback) {
        rngLate = !!rt._hasStarted;
        rt.SetRandomNumberGeneratorCallback(mulberry32(fnv(CODE)));
        clearInterval(rngTimer);
        log('random seeded' + (rngLate ? ' (LATE)' : ''));
      }
    }, 1);
  }

  // Remember audio contexts so a real click can wake them (the page was just reloaded).
  var audioCtxs = [];
  try {
    var origGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      if (audioCtxs.indexOf(this) < 0) audioCtxs.push(this);
      return origGain.apply(this, arguments);
    };
  } catch (e) {}
  function wakeAudio() { audioCtxs.forEach(function (c) { try { c.resume(); } catch (e) {} }); }

  /* ---------------- injecting input into the game ---------------- */
  function fireKey(type, k) {
    var e = new KeyboardEvent(type, { key: k.key, code: k.code, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'which', { get: function () { return k.which; } });
    Object.defineProperty(e, 'keyCode', { get: function () { return k.which; } });
    e.__mp = true;
    window.dispatchEvent(e);
  }
  function firePointer(p, d, f) {
    var rt = getRt(), cx, cy;
    try {
      var a = rt.GetMainRunningLayout().GetLayerByIndex(0).LayerToCanvasCss(d[5], d[6], 0);
      cx = a[0] + rt.GetCanvasClientX(); cy = a[1] + rt.GetCanvasClientY();
    } catch (e) { return; }
    var ev = new PointerEvent(d[1], { pointerId: d[2] + p * 1000, pointerType: d[7] || 'mouse', isPrimary: true,
      button: d[3], buttons: d[4], clientX: cx, clientY: cy, width: 1, height: 1, pressure: d[4] ? 0.5 : 0,
      bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'timeStamp', { value: (f + 1) * FRAME_MS });
    ev.__mp = true;
    window.dispatchEvent(ev);
  }
  function applyEvent(p, d, f) {
    if (d[0] === 'k') fireKey(d[1] ? 'keydown' : 'keyup', p === 0 ? P1 : P2);
    else if (d[0] === 'p') firePointer(p, d, f);
  }

  /* ---------------- local input -> scheduled events ---------------- */
  function addEvent(f, p, s, d) { (evAt[f] || (evAt[f] = [])).push({ p: p, s: s, d: d }); }
  function scheduleLocal(d) {
    var f = frame + D, s = ++seq;
    outLog.push([f, s, d]);
    addEvent(f, MY, s, d);
    sendSoon();
  }
  var held = {}, jumpDown = false;
  function setJump(id, down) {
    if (down) held[id] = 1; else delete held[id];
    var d = Object.keys(held).length > 0;
    if (d !== jumpDown) { jumpDown = d; scheduleLocal(['k', d ? 1 : 0]); }
  }
  function inUi(t) { return t && t.closest && t.closest('#mp-root'); }
  function onInput(e) {
    if (mode !== 'lock' || e.__mp || inUi(e.target)) return;
    var t = e.type;
    wakeAudio();
    if (t === 'keydown' || t === 'keyup') {
      if (JUMP[e.code]) { e.preventDefault(); if (!e.repeat) setJump(e.code, t === 'keydown'); }
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (e.cancelable && t !== 'wheel') e.preventDefault();
    if (t === 'pointerdown' || t === 'pointerup' || t === 'pointercancel') {
      var rt = getRt();
      try {
        var a = rt.GetMainRunningLayout().GetLayerByIndex(0)
          .CanvasCssToLayer(e.clientX - rt.GetCanvasClientX(), e.clientY - rt.GetCanvasClientY(), 0);
        scheduleLocal(['p', t, e.pointerId, e.button, e.buttons, Math.round(a[0] * 100) / 100, Math.round(a[1] * 100) / 100, e.pointerType]);
      } catch (x) {}
    }
  }
  if (ONLINE) {
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerrawupdate',
     'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
     'wheel', 'contextmenu'].forEach(function (n) { window.addEventListener(n, onInput, { capture: true, passive: false }); });
    window.addEventListener('blur', function () { if (jumpDown) { held = {}; jumpDown = false; if (mode === 'lock') scheduleLocal(['k', 0]); } });
  }

  /* ---------------- the lockstep loop ---------------- */
  function stateHash() {
    try {
      var rt = getRt(), h = 2166136261;
      var mix = function (n) { h ^= (n | 0); h = Math.imul(h, 16777619); };
      var cl = rt.GetAllObjectClasses();
      for (var i = 0; i < cl.length; i++) {
        var ins = cl[i].GetInstances ? cl[i].GetInstances() : [];
        for (var j = 0; j < ins.length; j++) {
          var wi = ins[j].GetWorldInfo && ins[j].GetWorldInfo();
          if (wi) { mix(Math.round(wi.GetX() * 10)); mix(Math.round(wi.GetY() * 10)); mix(Math.round(wi.GetAngle() * 1000)); }
        }
      }
      mix(Math.round(rt.GetGameTime() * 1000));
      return h >>> 0;
    } catch (e) { return 0; }
  }
  function compareHash(f) {
    if (hashMine[f] != null && hashPeer[f] != null) {
      if (hashMine[f] !== hashPeer[f] && S.desync == null) { S.desync = f; log('DESYNC at frame', f); render(); }
      delete hashMine[f]; delete hashPeer[f];
    }
  }
  function canStep() {
    if (mode !== 'lock' || !heldCb || frame > remoteUpTo) return false;
    var rt = getRt();
    return !(rt && rt.IsSuspended && rt.IsSuspended());
  }
  function stepOnce() {
    var f = frame;
    if (f > 0 && f % HASH_EVERY === 0) {
      var h = stateHash(); hashMine[f] = h; hashOut.push([f, h]); compareHash(f);
    }
    var evs = evAt[f];
    if (evs) {
      delete evAt[f];
      evs.sort(function (a, b) { return a.p - b.p || a.s - b.s; });
      evs.forEach(function (ev) { applyEvent(ev.p, ev.d, f); });
    }
    var cb = heldCb; heldCb = null;
    frame = f + 1;
    if (frame % SEND_EVERY === 0) sendPacket();
    cb((f + 1) * FRAME_MS);
  }
  var lastNow = 0, acc = 0, blockedSince = 0;
  function lockLoop(now) {
    realRAF(lockLoop);
    if (mode !== 'lock') { lastNow = now; return; }
    if (!lastNow) lastNow = now;
    acc += Math.min(now - lastNow, 100); lastNow = now;
    var steps = 0, blocked = false;
    while (acc >= FRAME_MS && steps < 2) {
      if (!canStep()) { blocked = true; break; }
      stepOnce(); acc -= FRAME_MS; steps++;
    }
    if (acc > FRAME_MS * 4) acc = FRAME_MS * 4;
    var waiting = blocked && frame > remoteUpTo;
    if (waiting) { if (!blockedSince) blockedSince = now; } else blockedSince = 0;
    var show = waiting && now - blockedSince > 400;
    if (show !== S.waiting) { S.waiting = show; var w = document.getElementById('mp-wait'); if (w) w.style.display = show ? 'block' : 'none'; }
  }
  realRAF(lockLoop);

  function startLock(d) {
    if (S.started) return;
    S.started = true; D = d; frame = 0; remoteUpTo = d - 1; peerAck = -1;
    mode = 'lock'; S.status = 'live'; lastHeard = Date.now();
    var rt = getRt(); if (rt) rt._lastTickTime = 0;
    log('start lockstep, delay', d, 'frames, player', MY + 1);
    render();
  }
  function releaseToFree(msg) {
    var cb = heldCb; heldCb = null; mode = 'free';
    if (cb) realRAF(cb);
    S.status = 'ended'; S.msg = msg; render();
  }

  /* ---------------- network ---------------- */
  var sb = null, ch = null, joinTimer = null;
  function send(m) {
    if (!ch) return;
    m.from = me;
    try { var p = ch.send({ type: 'broadcast', event: 'm', payload: m }); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function sendPacket() {
    lastSend = Date.now();
    var m = { t: 'in', u: frame + D - 1, a: remoteUpTo, e: outLog };
    if (hashOut.length) { m.h = hashOut; hashOut = []; }
    send(m);
  }
  var sendTimer = null;
  function sendSoon() {
    if (sendTimer) return;
    var wait = Math.max(0, 16 - (Date.now() - lastSend));
    sendTimer = setTimeout(function () { sendTimer = null; if (mode === 'lock') sendPacket(); }, wait);
  }
  function onIn(m) {
    if (m.u > remoteUpTo) remoteUpTo = m.u;
    if (m.a != null && m.a > peerAck) {
      peerAck = m.a;
      outLog = outLog.filter(function (ev) { return ev[0] > peerAck; });
    }
    var peerP = 1 - MY;
    (m.e || []).forEach(function (ev) {
      if (ev[1] > lastSeqIn) { lastSeqIn = ev[1]; addEvent(ev[0], peerP, ev[1], ev[2]); }
    });
    (m.h || []).forEach(function (x) { hashPeer[x[0]] = x[1]; compareHash(x[0]); });
  }

  function onMsg(m) {
    if (!m || m.from === me) return;
    if (m.t === 'join') {
      if (ROLE !== 'host') return;
      if (!peerId) peerId = m.from;
      if (peerId === m.from) {
        if (!S.paired) { S.paired = true; render(); }
        send({ t: 'welcome', to: m.from });
      } else send({ t: 'full', to: m.from });
      return;
    }
    if (m.t === 'welcome') {
      if (ROLE !== 'join' || m.to !== me) return;
      peerId = m.from; S.paired = true; clearInterval(joinTimer); render();
      return;
    }
    if (m.t === 'full') { if (m.to === me) { clearInterval(joinTimer); fail('That lobby already has two players.'); } return; }
    if (m.from !== peerId) return;
    lastHeard = Date.now();
    if (m.t === 'ready') { S.peerReady = true; render(); maybeBegin(); }
    else if (m.t === 'ping') send({ t: 'pong', n: m.n, ts: m.ts });
    else if (m.t === 'pong') {
      var r = performance.now() - m.ts;
      S.rtt = S.rtt == null ? r : S.rtt * 0.8 + r * 0.2;
      if (m.n >= 0) samples.push(r);
    }
    else if (m.t === 'start') startLock(m.D);
    else if (m.t === 'in') onIn(m);
    else if (m.t === 'bye') { if (mode === 'lock') releaseToFree('The other player left the game.'); else fail('The other player left.'); }
  }

  var samples = [], beginning = false;
  function maybeBegin() {
    if (ROLE !== 'host' || beginning || !S.ready || !S.peerReady) return;
    beginning = true; S.status = 'starting'; render();
    var n = 0;
    var t = setInterval(function () {
      if (n >= 6) { clearInterval(t); setTimeout(finishBegin, 350); return; }
      send({ t: 'ping', n: n++, ts: performance.now() });
    }, 150);
  }
  function finishBegin() {
    var s = samples.slice().sort(function (a, b) { return a - b; });
    var rtt = s.length ? s[Math.floor(s.length / 2)] : 150;
    var d = Math.max(5, Math.min(24, Math.ceil(rtt / 2 / FRAME_MS) + SEND_EVERY + 2));
    for (var i = 0; i < 3; i++) setTimeout(function () { send({ t: 'start', D: d }); }, i * 120);
    startLock(d);
  }
  function pressReady() {
    wakeAudio();
    S.ready = true; render();
    var again = setInterval(function () { if (S.started || S.status === 'ended') clearInterval(again); else send({ t: 'ready' }); }, 800);
    send({ t: 'ready' });
    maybeBegin();
  }

  function onSubscribed() {
    if (ROLE === 'host') { S.status = 'waiting'; render(); return; }
    S.status = 'joining'; render();
    var tries = 0;
    send({ t: 'join' });
    joinTimer = setInterval(function () {
      if (S.paired) { clearInterval(joinTimer); return; }
      if (++tries > 20) { clearInterval(joinTimer); fail('No lobby found with code ' + CODE + '. Check the code, and that the host is on the waiting screen.'); return; }
      send({ t: 'join' });
    }, 1000);
  }
  function connect(attempt) {
    var lib = window.supabase;
    if (!lib || !lib.createClient) { fail('The online library (Supabase) did not load. Check your connection or content blocker, then reload.'); return; }
    try { if (ch && sb) sb.removeChannel(ch); } catch (e) {}
    sb = lib.createClient(SUPABASE_URL, SUPABASE_KEYS[attempt], {
      realtime: { params: { eventsPerSecond: 40 } }, auth: { persistSession: false, autoRefreshToken: false }
    });
    ch = sb.channel(CHANNEL_PREFIX + CODE, { config: { broadcast: { self: false, ack: false } } });
    ch.on('broadcast', { event: 'm' }, function (msg) { onMsg(msg.payload); });
    var ok = false;
    ch.subscribe(function (status) {
      if (status === 'SUBSCRIBED') { if (!ok) { ok = true; onSubscribed(); } }
      else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !ok) {
        if (attempt < SUPABASE_KEYS.length - 1) connect(attempt + 1);
        else fail('Could not connect to the lobby server (' + status + '). Check your internet connection and any content blocker.');
      }
    });
  }
  function fail(msg) { S.status = 'ended'; S.msg = msg; render(); }

  /* periodic: game-loaded check, heartbeat, connection watchdog, ping */
  if (ONLINE) {
    setInterval(function () {
      var loaded = !!heldCb;
      if (loaded !== S.gameLoaded) { S.gameLoaded = loaded; render(); }
      if (mode === 'lock') {
        if (Date.now() - lastSend > 120) sendPacket();
        if (Date.now() - lastHeard > 20000) releaseToFree('Lost the connection to the other player.');
      }
    }, 100);
    setInterval(function () { if (mode === 'lock') send({ t: 'ping', n: -1, ts: performance.now() }); }, 2000);
    window.addEventListener('beforeunload', function () { try { send({ t: 'bye' }); } catch (e) {} });
  }

  /* ---------------- UI ---------------- */
  var css = document.createElement('style');
  css.textContent =
    '#mp-root{position:fixed;top:8px;left:8px;z-index:2147483647;font:14px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#fff}' +
    '#mp-root.center{top:50%;left:50%;transform:translate(-50%,-50%)}' +
    '#mp-root *{box-sizing:border-box}' +
    '#mp-root button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:8px 12px;background:#ff8a00;color:#fff;font-weight:600}' +
    '#mp-root button[disabled]{opacity:.5;cursor:default}' +
    '#mp-root button.alt{background:#3a3f4b}' +
    '#mp-root .card{background:rgba(20,22,30,.96);border-radius:12px;padding:16px;width:min(320px,calc(100vw - 16px));box-shadow:0 4px 18px rgba(0,0,0,.45)}' +
    '#mp-root .pill{background:rgba(20,22,30,.82);border-radius:999px;padding:6px 8px 6px 12px;display:flex;align-items:center;gap:10px;font-size:13px;flex-wrap:wrap}' +
    '#mp-root .pill button{padding:4px 10px}' +
    '#mp-root input{font:inherit;width:100%;padding:8px;border-radius:8px;border:2px solid #555;background:#111;color:#fff;text-transform:uppercase;letter-spacing:4px;text-align:center}' +
    '#mp-root .row{display:flex;gap:8px;margin-top:10px}' +
    '#mp-root .code{font-size:36px;letter-spacing:8px;font-weight:800;text-align:center;margin:8px 0;user-select:all}' +
    '#mp-root .small{font-size:12px;opacity:.8}' +
    '#mp-root .err{color:#ff8f8f;margin-top:6px}' +
    '#mp-root .bad{color:#ff8f8f}#mp-root .good{color:#8fe3a0}' +
    '#mp-back{position:fixed;inset:0;background:#0e1016;z-index:2147483000}' +
    '#mp-wait{display:none;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(20,22,30,.85);color:#fff;padding:6px 14px;border-radius:999px;font:13px system-ui,Arial,sans-serif;z-index:2147483646}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.id = 'mp-root';
  var back = document.createElement('div');
  back.id = 'mp-back';
  var wait = document.createElement('div');
  wait.id = 'mp-wait'; wait.textContent = 'Waiting for the other player\u2026';
  function mount() {
    if (ONLINE) document.body.appendChild(back);
    document.body.appendChild(wait);
    document.body.appendChild(root);
    render();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render() {
    if (!root.parentNode) return;
    var h = '', center = false;
    if (!ONLINE) {
      if (!S.panel) h = '<button data-act="open" class="alt">\uD83C\uDF10 Online</button>';
      else h = '<div class="card"><b>Play online</b>' +
        '<div class="row"><button data-act="host" style="flex:1">Host a game</button></div>' +
        '<div class="small" style="margin:10px 0 4px">or join a friend:</div>' +
        '<input id="mp-code" maxlength="' + LEN + '" placeholder="CODE" autocomplete="off" spellcheck="false">' +
        '<div class="row"><button data-act="join" style="flex:1">Join</button><button data-act="close" class="alt">Close</button></div>' +
        (S.msg ? '<div class="err">' + esc(S.msg) + '</div>' : '') +
        '<div class="small" style="margin-top:10px">Both players need the same page open in Chrome, Edge or Brave.</div></div>';
    } else if (S.status === 'live') {
      back.style.display = 'none';
      h = '<div class="pill"><span>\u25CF Online \u00B7 You are Player ' + (MY + 1) + ' (W / \u2191 / Space)</span>' +
        '<span class="small">' + (S.rtt != null ? Math.round(S.rtt) + ' ms \u00B7 ' : '') + 'delay ' + D + 'f \u00B7 ' +
        (S.desync != null ? '<span class="bad">\u26A0 out of sync</span>' : '<span class="good">in sync</span>') + '</span>' +
        '<button data-act="leave" class="alt">Leave</button></div>';
    } else {
      center = true; back.style.display = 'block';
      if (S.status === 'ended') {
        h = '<div class="card">' + esc(S.msg) + '<div class="row"><button data-act="leave" style="flex:1">OK</button></div></div>';
        if (mode === 'free') { back.style.display = 'none'; center = false; }
      } else {
        h = '<div class="card">';
        if (ROLE === 'host') {
          h += '<b>Your lobby code</b>' + (S.status === 'connecting' ? '' : '');
          h += '<div class="code">' + esc(CODE) + '</div>';
          h += '<div class="row"><button data-act="copy" style="flex:1">Copy code</button></div>';
        } else h += '<b>Joining lobby ' + esc(CODE) + '</b>';
        var line;
        if (!S.paired) line = ROLE === 'host' ? 'Waiting for your friend to join\u2026' : 'Looking for the host\u2026';
        else line = 'Both players connected.';
        h += '<div class="small" style="margin-top:8px">' + line + '</div>';
        if (S.paired) {
          if (S.status === 'starting') h += '<div style="margin-top:10px"><b>Starting\u2026</b></div>';
          else if (S.ready) h += '<div class="small" style="margin-top:10px">Waiting for the other player to press Ready\u2026</div>';
          else h += '<div class="row"><button data-act="ready" style="flex:1"' + (S.gameLoaded ? '' : ' disabled') + '>' +
            (S.gameLoaded ? 'I\u2019m ready' : 'Loading game\u2026') + '</button></div>';
        } else if (!S.gameLoaded) h += '<div class="small">Loading game\u2026</div>';
        h += '<div class="row"><button data-act="leave" class="alt" style="flex:1">Cancel</button></div></div>';
      }
    }
    root.className = center ? 'center' : '';
    root.innerHTML = h;
    var inp = root.querySelector('#mp-code');
    if (inp) {
      inp.addEventListener('input', function () { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go('join', inp.value); });
      if (S.panel) inp.focus();
    }
  }
  function go(role, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (role === 'join' && code.length !== LEN) { S.msg = 'Enter the ' + LEN + '-character code.'; render(); return; }
    if (role === 'host') code = randCode();
    location.href = location.pathname + '?online=' + role + '&code=' + code;
  }
  root.addEventListener('click', function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (!a) return;
    if (a === 'open') { S.panel = true; S.msg = ''; render(); }
    else if (a === 'close') { S.panel = false; S.msg = ''; render(); }
    else if (a === 'host') go('host');
    else if (a === 'join') go('join', (root.querySelector('#mp-code') || {}).value);
    else if (a === 'ready') pressReady();
    else if (a === 'copy') { try { navigator.clipboard.writeText(CODE); e.target.textContent = 'Copied!'; } catch (x) {} }
    else if (a === 'leave') { try { send({ t: 'bye' }); } catch (x) {} location.href = location.pathname; }
  });
  setInterval(function () { if (S.status === 'live') render(); }, 1000);

  if (ONLINE) {
    S.status = 'connecting';
    window.addEventListener('load', function () { connect(0); });
    if (document.readyState === 'complete') connect(0);
  }

  window.__mp = { state: function () { return { mode: mode, frame: frame, D: D, remoteUpTo: remoteUpTo, S: S, rngLate: rngLate }; } };
})();
