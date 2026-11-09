/* Basket Random - online 2-player mode with lobby codes.
 *
 * How it works
 *  - HOST runs the real game. The game canvas (and its audio) is streamed to the guest over WebRTC.
 *    The host plays Player 1 (W / Up / Space). The guest's key presses arrive over a data channel
 *    and are injected into the game as Player 2's key (Up arrow).
 *  - GUEST sees the host's screen as a video and sends jump presses (Space / Up / W / tap).
 *  - PeerJS provides the signalling: the lobby code is the host's peer id.
 */
(function () {
  'use strict';

  var PREFIX = 'bsktrnd-';
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  var LEN = 5;
  var P1 = { which: 87, code: 'KeyW', key: 'w' };          // Player 1 in the game
  var P2 = { which: 38, code: 'ArrowUp', key: 'ArrowUp' }; // Player 2 in the game
  var JUMP = { KeyW: 1, ArrowUp: 1, Space: 1 };

  var S = { role: null, status: 'idle', panel: false, code: '', msg: '', peer: null, conn: null, call: null, live: false };

  /* ---------- audio tap: copy everything the game sends to the speakers into a stream ---------- */
  var audioCtxs = [];
  var msdByCtx = new WeakMap();
  var muteLocal = false;
  try {
    var origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try {
        var ctx = this.context;
        if (ctx && audioCtxs.indexOf(ctx) < 0) audioCtxs.push(ctx);
        if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
          var msd = msdByCtx.get(dest.context);
          if (!msd && dest.context.createMediaStreamDestination) {
            msd = dest.context.createMediaStreamDestination();
            msdByCtx.set(dest.context, msd);
          }
          if (msd) origConnect.apply(this, [msd].concat(Array.prototype.slice.call(arguments, 1)));
          if (muteLocal) return dest;
        }
      } catch (e) { /* never break the game's audio */ }
      return origConnect.apply(this, arguments);
    };
    var origResume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      if (muteLocal) return Promise.resolve();
      return origResume.apply(this, arguments);
    };
  } catch (e) { console.warn('[MP] audio tap unavailable', e); }

  function muteGameLocally() {
    muteLocal = true;
    var f = function () { audioCtxs.forEach(function (c) { try { c.suspend(); } catch (e) {} }); };
    f(); setInterval(f, 1000);
  }
  function suspendGameLocally() {
    // The guest watches the host's video, so pause the guest's own copy of the game.
    var tries = 0;
    var t = setInterval(function () {
      try {
        var rt = window.c3_runtimeInterface && window.c3_runtimeInterface._GetLocalRuntime();
        if (rt) { rt.SetSuspended(true); clearInterval(t); }
      } catch (e) {}
      if (++tries > 60) clearInterval(t);
    }, 500);
  }

  /* ---------- injecting keys into the game ---------- */
  function fireKey(type, k) {
    var e = new KeyboardEvent(type, { key: k.key, code: k.code, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'which', { get: function () { return k.which; } });
    Object.defineProperty(e, 'keyCode', { get: function () { return k.which; } });
    e.__mp = true;
    window.dispatchEvent(e);
  }
  function tracker(cb) {
    var held = {}, down = false;
    return {
      set: function (id, isDown) {
        if (isDown) held[id] = 1; else delete held[id];
        var d = Object.keys(held).length > 0;
        if (d !== down) { down = d; cb(d); }
      },
      reset: function () { held = {}; if (down) { down = false; cb(false); } }
    };
  }
  var hostJump = tracker(function (d) { fireKey(d ? 'keydown' : 'keyup', P1); });
  var guestJump = tracker(function (d) { send({ t: d ? 'd' : 'u' }); });
  var remoteDown = false;
  function setRemote(v) { if (v !== remoteDown) { remoteDown = v; fireKey(v ? 'keydown' : 'keyup', P2); } }

  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }
  function onKey(e) {
    if (e.__mp || !S.live || !JUMP[e.code] || typing(e.target)) return;
    // While online, every jump key means "my player jumps" and never the other player.
    e.preventDefault(); e.stopImmediatePropagation();
    (S.role === 'host' ? hostJump : guestJump).set(e.code, e.type === 'keydown');
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', function () { hostJump.reset(); guestJump.reset(); });

  function send(m) { try { if (S.conn && S.conn.open) S.conn.send(m); } catch (e) {} }

  /* ---------- networking ---------- */
  function PeerCtor() { return window.Peer || (window.peerjs && window.peerjs.Peer); }
  function randCode() {
    var s = '';
    for (var i = 0; i < LEN; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
    return s;
  }
  function end(msg) { S.status = 'ended'; S.msg = msg; S.live = false; hostJump.reset(); guestJump.reset(); setRemote(false); render(); }
  function netError(err) {
    console.warn('[MP] peer error', err);
    end('Could not reach the lobby server (' + (err && err.type ? err.type : 'error') + '). Check your internet connection and any content blockers (Brave Shields etc.), then try again.');
  }
  function needLib() {
    if (PeerCtor()) return false;
    end('The online library (PeerJS) did not load. Check your internet connection or content blocker and reload the page.');
    return true;
  }

  function findCanvas() {
    var best = null, area = 0;
    [].forEach.call(document.querySelectorAll('canvas'), function (c) {
      var a = c.width * c.height; if (a > area) { best = c; area = a; }
    });
    return best;
  }
  function buildStream() {
    var canvas = findCanvas();
    if (!canvas) throw new Error('The game has not finished loading on the host yet.');
    var stream = canvas.captureStream(60);
    try { stream.getVideoTracks()[0].contentHint = 'motion'; } catch (e) {}
    for (var i = 0; i < audioCtxs.length; i++) {
      var m = msdByCtx.get(audioCtxs[i]);
      if (m) { m.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); }); break; }
    }
    return { stream: stream, canvas: canvas };
  }
  function tuneSender(call, canvas) {
    setTimeout(function () {
      try {
        call.peerConnection.getSenders().forEach(function (s) {
          if (!s.track || s.track.kind !== 'video') return;
          var p = s.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = 3000000;
          p.encodings[0].maxFramerate = 60;
          p.encodings[0].scaleResolutionDownBy = Math.max(1, canvas.width / 960);
          s.setParameters(p);
        });
      } catch (e) { console.warn('[MP] could not tune video', e); }
    }, 1500);
  }

  /* host */
  function startHost() {
    if (needLib()) return;
    S.role = 'host'; S.status = 'starting'; render();
    tryCode(0);
  }
  function tryCode(n) {
    var code = randCode();
    var peer = new (PeerCtor())(PREFIX + code);
    S.peer = peer;
    peer.on('open', function () { S.code = code; S.status = 'waiting'; render(); });
    peer.on('error', function (err) {
      if (err.type === 'unavailable-id' && n < 5) { try { peer.destroy(); } catch (e) {} tryCode(n + 1); }
      else netError(err);
    });
    peer.on('disconnected', function () { if (!peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
    peer.on('connection', onGuestConn);
  }
  function onGuestConn(conn) {
    if (S.conn) { // lobby already has two players
      conn.on('open', function () { conn.send({ t: 'full' }); setTimeout(function () { conn.close(); }, 400); });
      return;
    }
    S.conn = conn; S.status = 'connecting'; render();
    conn.on('open', function () {
      try {
        var b = buildStream();
        S.call = S.peer.call(conn.peer, b.stream);
        S.call.on('close', guestGone);
        S.call.on('error', guestGone);
        tuneSender(S.call, b.canvas);
        S.live = true; S.status = 'live'; render();
      } catch (e) {
        conn.send({ t: 'err', m: e.message || 'Host could not start streaming.' });
        S.conn = null; S.status = 'waiting'; render();
      }
    });
    conn.on('data', function (d) { if (d && d.t === 'd') setRemote(true); else if (d && d.t === 'u') setRemote(false); });
    conn.on('close', guestGone);
    conn.on('error', guestGone);
  }
  function guestGone() {
    if (!S.conn) return;
    S.conn = null;
    try { if (S.call) S.call.close(); } catch (e) {}
    S.call = null; S.live = false; hostJump.reset(); setRemote(false);
    S.status = 'waiting'; render();
  }

  /* guest */
  function startJoin(raw) {
    var code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== LEN) { S.msg = 'Enter the ' + LEN + '-character code.'; render(); return; }
    if (needLib()) return;
    S.role = 'guest'; S.code = code; S.status = 'connecting'; S.msg = ''; render();
    muteGameLocally(); suspendGameLocally();
    var peer = new (PeerCtor())();
    S.peer = peer;
    var timer = setTimeout(function () {
      end('Could not connect. Check the code, and make sure the host is still waiting. Some strict networks block direct connections.');
    }, 25000);
    peer.on('open', function () {
      var conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      S.conn = conn;
      conn.on('open', function () { S.status = 'waitvideo'; render(); });
      conn.on('data', function (d) {
        if (d && d.t === 'full') { clearTimeout(timer); end('That lobby already has two players.'); }
        else if (d && d.t === 'err') { clearTimeout(timer); end(d.m); }
      });
      conn.on('close', function () { clearTimeout(timer); end('The host left the game.'); });
    });
    peer.on('call', function (call) {
      S.call = call;
      call.answer();
      call.on('stream', function (stream) { clearTimeout(timer); showVideo(stream); });
      call.on('close', function () { end('The host left the game.'); });
    });
    peer.on('error', function (err) {
      clearTimeout(timer);
      if (err.type === 'peer-unavailable') end('No lobby found with code ' + code + '. Check the code, and that the host has started hosting.');
      else netError(err);
    });
  }

  /* ---------- UI ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#mp-root{position:fixed;top:8px;left:8px;z-index:2147483647;font:14px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#fff}' +
    '#mp-root *{box-sizing:border-box}' +
    '#mp-root button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:8px 12px;background:#ff8a00;color:#fff;font-weight:600}' +
    '#mp-root button.alt{background:#3a3f4b}' +
    '#mp-root .card{background:rgba(20,22,30,.94);border-radius:12px;padding:14px;width:min(300px,calc(100vw - 16px));box-shadow:0 4px 18px rgba(0,0,0,.45)}' +
    '#mp-root .pill{background:rgba(20,22,30,.82);border-radius:999px;padding:6px 8px 6px 12px;display:flex;align-items:center;gap:10px;font-size:13px}' +
    '#mp-root .pill button{padding:4px 10px}' +
    '#mp-root input{font:inherit;width:100%;padding:8px;border-radius:8px;border:2px solid #555;background:#111;color:#fff;text-transform:uppercase;letter-spacing:4px;text-align:center}' +
    '#mp-root .row{display:flex;gap:8px;margin-top:8px}' +
    '#mp-root .code{font-size:34px;letter-spacing:8px;font-weight:800;text-align:center;margin:8px 0;user-select:all}' +
    '#mp-root .small{font-size:12px;opacity:.8}' +
    '#mp-root .err{color:#ff8f8f;margin-top:6px}' +
    '#mp-video{position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:2147483000;display:none;touch-action:none}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.id = 'mp-root';
  var video = document.createElement('video');
  video.id = 'mp-video'; video.autoplay = true; video.playsInline = true;
  function mount() { document.body.appendChild(video); document.body.appendChild(root); render(); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  video.addEventListener('pointerdown', function () { if (S.live) guestJump.set('ptr', true); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) {
    video.addEventListener(n, function () { guestJump.set('ptr', false); });
  });

  function showVideo(stream) {
    video.srcObject = stream;
    video.style.display = 'block';
    var p = video.play();
    if (p && p.catch) p.catch(function () { video.muted = true; video.play(); });
    S.live = true; S.status = 'live'; render();
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function render() {
    if (!root.parentNode) return;
    var h = '';
    if (S.status === 'idle') {
      if (!S.panel) h = '<button data-act="open" class="alt">\uD83C\uDF10 Online</button>';
      else h = '<div class="card"><b>Play online</b>' +
        '<div class="row"><button data-act="host" style="flex:1">Host a game</button></div>' +
        '<div class="small" style="margin:10px 0 4px">or join a friend:</div>' +
        '<input id="mp-code" maxlength="' + LEN + '" placeholder="CODE" autocomplete="off" spellcheck="false">' +
        '<div class="row"><button data-act="join" style="flex:1">Join</button><button data-act="close" class="alt">Close</button></div>' +
        (S.msg ? '<div class="err">' + esc(S.msg) + '</div>' : '') + '</div>';
    } else if (S.status === 'starting') {
      h = '<div class="card">Creating lobby\u2026</div>';
    } else if (S.status === 'waiting') {
      h = '<div class="card"><b>Your lobby code</b><div class="code">' + esc(S.code) + '</div>' +
        '<div class="row"><button data-act="copy" style="flex:1">Copy code</button><button data-act="leave" class="alt">Cancel</button></div>' +
        '<div class="small" style="margin-top:10px">Waiting for your friend to join\u2026<br>Meanwhile, choose <b>2 players</b> in the game menu. Keep this tab open and in front.</div></div>';
    } else if (S.status === 'connecting' || S.status === 'waitvideo') {
      h = '<div class="card">Connecting to lobby ' + esc(S.code) + '\u2026 <div class="row"><button data-act="leave" class="alt">Cancel</button></div></div>';
    } else if (S.status === 'live') {
      h = '<div class="pill"><span>\u25CF Online \u00B7 ' + (S.role === 'host' ? 'You are Player 1 (W / \u2191 / Space)' : 'You are Player 2 (Space / \u2191 / tap)') + '</span><button data-act="leave" class="alt">Leave</button></div>';
    } else if (S.status === 'ended') {
      h = '<div class="card">' + esc(S.msg) + '<div class="row"><button data-act="leave" style="flex:1">OK</button></div></div>';
    }
    root.innerHTML = h;
    var inp = root.querySelector('#mp-code');
    if (inp) {
      inp.addEventListener('input', function () { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') startJoin(inp.value); });
      if (S.panel) inp.focus();
    }
  }
  root.addEventListener('click', function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (!a) return;
    if (a === 'open') { S.panel = true; S.msg = ''; render(); }
    else if (a === 'close') { S.panel = false; S.msg = ''; render(); }
    else if (a === 'host') startHost();
    else if (a === 'join') startJoin((root.querySelector('#mp-code') || {}).value);
    else if (a === 'copy') {
      try { navigator.clipboard.writeText(S.code); e.target.textContent = 'Copied!'; } catch (x) {}
    }
    else if (a === 'leave') { try { if (S.peer) S.peer.destroy(); } catch (x) {} location.reload(); }
  });
  window.addEventListener('beforeunload', function () { try { if (S.peer) S.peer.destroy(); } catch (e) {} });
})();
