(function () {
  'use strict';
  var CFG = { salt: 'd58b2f83d889ee0d5efbe4aada5e7f30', hash: '1f32e433fd33a5eaaf1bf4fc2ba881f3002798d274179095f441c36ea7751057', iter: 600000, idleMs: 15 * 60 * 1000 };
  var CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', PREFIX = 'KNOX~', MAXMIN = 1440;
  var HKEY = 'zx_hist', FKEY = 'zx_fail', SKEY = 'zx_sess', TKEY = 'zx_tok';
  var GH = { owner: 'huskne', repo: 'Admin-panel-tst', path: 'assets/cfg.dat' };
  function makeKey(T) {
    var v = (T ^ 0x2A5C3E71) & 0x3FFFFFFF, tp = '', k;
    for (k = 5; k >= 0; k--) tp += CH.charAt((v >> (5 * k)) & 31);
    var seed = T * 7 + 13579, mac = '', i, x;
    for (i = 0; i < 10; i++) {
      x = Math.sin(seed++) * 10000;
      mac += CH.charAt(Math.floor(Math.abs(x - Math.floor(x)) * CH.length));
    }
    var all = tp + mac;
    return PREFIX + all.substring(0, 8) + '~' + all.substring(8, 16);
  }
  function keyFor(d, extraBack) {
    var now = Math.floor(Date.now() / 60000);
    var T = now - (MAXMIN - d) - (extraBack || 0);
    return { key: makeKey(T), exp: (T + MAXMIN) * 60000 };
  }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} return null; }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function unhex(h) { var a = new Uint8Array(h.length / 2), i; for (i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function derive(user, pass, saltHex, iter) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(user + ':' + pass), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(saltHex), iterations: iter, hash: 'SHA-256' }, k, 256);
    }).then(hex);
  }
  function token() { try { return sessionStorage.getItem('zx_tk') || localStorage.getItem(TKEY) || ''; } catch (e) { return ''; } }
  function api(method, body) {
    var t = token();
    if (!t) return Promise.reject(new Error('Set your GitHub token first (GitHub sync, below).'));
    var url = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo + '/contents/' + GH.path;
    var opt = { method: method, headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' }, cache: 'no-store' };
    if (method === 'GET') url += '?t=' + Date.now();
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); });
  }
  function readList() {
    return api('GET').then(function (x) {
      if (x.status === 404) return { text: '', sha: null };
      if (!x.ok) throw new Error('GitHub: ' + (x.j.message || x.status));
      return { text: atob((x.j.content || '').replace(/\s/g, '')), sha: x.j.sha };
    });
  }
  function writeList(text, sha, msg) {
    var b = { message: msg, content: btoa(text) }; if (sha) b.sha = sha;
    return api('PUT', b).then(function (x) { if (!x.ok) throw new Error('GitHub: ' + (x.j.message || x.status)); });
  }
  function parseList(t) { return t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean); }
  function lineKey(l) { return l.split(/\s+/)[0]; }
  function pruned(L) { var lim = Date.now() - 2 * 86400000; return L.filter(function (l) { var e = parseInt(l.split(/\s+/)[1], 10); return !(e && e < lim); }); }
  function hashKey(key) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.trim().toUpperCase())).then(function (b) { return hex(b).slice(0, 32); });
  }
  function revoke(key, exp) {
    return hashKey(key).then(function (h) {
      return readList().then(function (o) {
        var L = parseList(o.text);
        if (!L.some(function (l) { return lineKey(l) === h; })) L.push(h + ' ' + exp);
        L = pruned(L); return writeList(L.join('\n') + '\n', o.sha, 'update');
      });
    });
  }
  function restoreHash(h) {
    return readList().then(function (o) {
      var L = parseList(o.text).filter(function (l) { return lineKey(l) !== h; });
      return writeList(L.join('\n') + (L.length ? '\n' : ''), o.sha, 'update');
    });
  }
  function restore(key) { return hashKey(key).then(restoreHash); }
  function visible(key) {
    return hashKey(key).then(function (h) {
      var u = 'https://raw.githubusercontent.com/' + GH.owner + '/' + GH.repo + '/HEAD/' + GH.path + '?t=' + Date.now();
      return fetch(u, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) { return t.indexOf(h) >= 0; });
    }).catch(function () { return false; });
  }
  function markRev(key, val) { var h = ls(HKEY) || []; h.forEach(function (x) { if (x.key === key) x.rev = val; }); ls(HKEY, h); }
  function fmt(ms) { return new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function copy(t, done) {
    function fb() { var a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(a); done && done(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { done && done(); }, fb); else fb();
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var root = null, idleT = null, tick = null, openedAt = 0;
  var CSS = '.zx-o{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.88);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px;font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#eee}' +
    '.zx-b{width:100%;max-width:460px;background:#111;border:1px solid #FFD70066;border-radius:16px;padding:18px;margin:auto;box-shadow:0 0 40px #FFD70022}' +
    '.zx-b h2{margin:0 0 12px;font-size:16px;letter-spacing:.15em;color:#FFD700}.zx-b h3{margin:16px 0 8px;font-size:11px;letter-spacing:.2em;color:#FFD700aa}' +
    '.zx-b input{width:100%;box-sizing:border-box;background:#1b1b1b;border:1px solid #333;border-radius:10px;color:#fff;padding:11px 12px;font-size:14px;margin:4px 0}' +
    '.zx-b button{cursor:pointer;border:0;border-radius:10px;padding:10px 14px;font-weight:700;font-size:13px;background:#2a2a2a;color:#eee}' +
    '.zx-b button.p{background:linear-gradient(135deg,#FFD700,#D4AF37);color:#111;width:100%;margin-top:8px;padding:12px}' +
    '.zx-row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.zx-row button.on{background:#FFD700;color:#111}' +
    '.zx-e{color:#ff6b6b;font-size:12px;min-height:16px;margin-top:6px}.zx-n{color:#999;font-size:11px;line-height:1.5;margin-top:6px}' +
    '.zx-k{background:#1a1a1a;border:1px solid #2c2c2c;border-radius:10px;padding:9px 10px;margin:6px 0;display:flex;gap:8px;align-items:center}' +
    '.zx-k div{flex:1;min-width:0}.zx-k code{display:block;font-family:Courier New,monospace;font-size:13px;color:#FFD700;word-break:break-all}.zx-k small{color:#999;font-size:10px}' +
    '.zx-k button{padding:7px 10px;font-size:11px}.zx-top{display:flex;justify-content:space-between;align-items:center}.zx-top button{padding:7px 10px;font-size:11px}' +
    '.zx-b button.d{background:#5b1d1d;color:#ffb4b4}.zx-a{color:#4ade80}.zx-x{color:#f87171}.zx-cfg{width:100%;box-sizing:border-box;background:#0b0b0b;color:#9f9;border:1px solid #333;border-radius:8px;padding:8px;font-size:10px;font-family:monospace;min-height:70px}';
  function close() { if (root) { root.remove(); root = null; } clearTimeout(idleT); clearInterval(tick); }
  function logout() { try { sessionStorage.removeItem(SKEY); } catch (e) {} close(); }
  function bump() { clearTimeout(idleT); idleT = setTimeout(logout, CFG.idleMs); }
  function open() {
    if (root) return;
    openedAt = Date.now();
    if (!document.getElementById('zx-css')) { var s = el('style'); s.id = 'zx-css'; s.textContent = CSS; document.head.appendChild(s); }
    root = el('div', 'zx-o'); document.body.appendChild(root);
    root.addEventListener('input', bump); root.addEventListener('click', bump);
    var ok = false; try { ok = sessionStorage.getItem(SKEY) === '1'; } catch (e) {}
    ok ? panel() : login();
  }
  function login() {
    root.textContent = '';
    var b = el('div', 'zx-b'); root.appendChild(b);
    b.appendChild(el('h2', '', 'ADMIN LOGIN'));
    var u = el('input'); u.placeholder = 'Username'; u.autocomplete = 'off'; u.autocapitalize = 'off';
    var p = el('input'); p.type = 'password'; p.placeholder = 'Password'; p.autocomplete = 'off';
    var er = el('div', 'zx-e'), go = el('button', 'p', 'LOGIN');
    b.appendChild(u); b.appendChild(p); b.appendChild(go); b.appendChild(er);
    var cl = el('button', '', 'Close'); cl.style.marginTop = '10px'; cl.onclick = close; b.appendChild(cl);
    function submit() {
      var f = ls(FKEY) || { n: 0, until: 0 }, now = Date.now();
      if (f.until > now) { er.textContent = 'Locked. Try again in ' + Math.ceil((f.until - now) / 60000) + ' min.'; return; }
      if (!window.crypto || !crypto.subtle) { er.textContent = 'Secure context required (use https).'; return; }
      go.disabled = true; er.textContent = 'Checking...';
      derive(u.value.trim(), p.value, CFG.salt, CFG.iter).then(function (h) {
        var d = 0, i; for (i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ CFG.hash.charCodeAt(i);
        if (h.length === CFG.hash.length && d === 0) { ls(FKEY, { n: 0, until: 0 }); try { sessionStorage.setItem(SKEY, '1'); } catch (e) {} bump(); panel(); }
        else { f.n++; if (f.n >= 5) { f.until = now + 5 * 60000; f.n = 0; er.textContent = 'Too many attempts. Locked for 5 minutes.'; } else er.textContent = 'Wrong username or password (' + (5 - f.n) + ' left).'; ls(FKEY, f); go.disabled = false; p.value = ''; }
      }, function () { er.textContent = 'Error.'; go.disabled = false; });
    }
    go.onclick = submit; p.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    setTimeout(function () { u.focus(); }, 50);
  }
  function panel() {
    root.textContent = '';
    var b = el('div', 'zx-b'); root.appendChild(b);
    var top = el('div', 'zx-top'); top.appendChild(el('h2', '', 'KEY GENERATOR'));
    var lo = el('button', '', 'Logout'); lo.onclick = logout; top.appendChild(lo); b.appendChild(top);
    b.appendChild(el('h3', '', 'VALIDITY'));
    var dur = 1440, row = el('div', 'zx-row'), chips = [];
    [['1 hour', 60], ['3 hours', 180], ['6 hours', 360], ['12 hours', 720], ['24 hours', 1440]].forEach(function (c) {
      var x = el('button', c[1] === 1440 ? 'on' : '', c[0]);
      x.onclick = function () { dur = c[1]; cu.value = ''; chips.forEach(function (y) { y.className = ''; }); x.className = 'on'; };
      chips.push(x); row.appendChild(x);
    });
    b.appendChild(row);
    var cu = el('input'); cu.type = 'number'; cu.min = 1; cu.max = MAXMIN; cu.placeholder = 'Or custom minutes (1 - 1440)';
    cu.oninput = function () { if (cu.value) chips.forEach(function (y) { y.className = ''; }); };
    b.appendChild(cu);
    b.appendChild(el('h3', '', 'USER NOTE & COUNT'));
    var note = el('input'); note.placeholder = 'User name / note (optional, only saved on this device)';
    var cnt = el('input'); cnt.type = 'number'; cnt.min = 1; cnt.max = 50; cnt.value = 1; cnt.placeholder = 'How many keys';
    b.appendChild(note); b.appendChild(cnt);
    var gen = el('button', 'p', 'GENERATE KEY'), er = el('div', 'zx-e'); b.appendChild(gen); b.appendChild(er);
    var out = el('div'); b.appendChild(out);
    b.appendChild(el('div', 'zx-n', 'Max validity is 24 hours (the app accepts a key for 24h only). Keys are time-based, not locked to a user. Several keys at once = each one expires 1 minute apart so they stay unique. Phone clock should be correct.'));
    var msg = el('div', 'zx-e'); b.insertBefore(msg, out);
    function say(t, bad) { msg.style.color = bad ? '#ff6b6b' : '#4ade80'; msg.textContent = t; }
    function card(r) {
      var c = el('div', 'zx-k'), d = el('div');
      d.appendChild(el('code', '', r.key));
      var live = r.exp > Date.now();
      var sm = el('small', '', (r.note ? r.note + ' \u00b7 ' : '') + 'expires ' + fmt(r.exp) + ' \u00b7 ');
      sm.appendChild(el('span', r.rev ? 'zx-x' : (live ? 'zx-a' : 'zx-x'), r.rev ? 'revoked' : (live ? 'active' : 'expired')));
      d.appendChild(sm); c.appendChild(d);
      var bt = el('button', '', 'Copy'); bt.onclick = function () { copy(r.key, function () { bt.textContent = 'Copied'; setTimeout(function () { bt.textContent = 'Copy'; }, 1200); }); };
      c.appendChild(bt);
      function swap() { if (c.parentNode) c.parentNode.replaceChild(card(r), c); hist(); }
      if (r.rev || live) {
        var ac = el('button', r.rev ? '' : 'd', r.rev ? 'Restore' : 'Delete');
        ac.onclick = function () {
          if (!r.rev && !confirm('Delete this key? The app will show KEY EXPIRED for it.')) return;
          ac.disabled = true; ac.textContent = '...'; say('Updating GitHub...');
          (r.rev ? restore(r.key) : revoke(r.key, r.exp)).then(function () {
            r.rev = !r.rev; markRev(r.key, r.rev); say(r.rev ? 'Deleted. Checking public file...' : 'Key restored.'); swap();
            if (r.rev) visible(r.key).then(function (v) { say(v ? 'Deleted. Confirmed: the app can see it, login will show KEY EXPIRED.' : 'Saved, but the public file does not show it yet. Wait 1-5 min and test again.', !v); });
          }, function (e) { ac.disabled = false; ac.textContent = r.rev ? 'Restore' : 'Delete'; say(e.message, true); });
        };
        c.appendChild(ac);
      } else {
        var rm = el('button', '', 'Remove'); rm.onclick = function () { var h = (ls(HKEY) || []).filter(function (x) { return x.key !== r.key; }); ls(HKEY, h); hist(); if (c.parentNode) c.parentNode.removeChild(c); };
        c.appendChild(rm);
      }
      return c;
    }
    gen.onclick = function () {
      var d = cu.value ? parseInt(cu.value, 10) : dur, n = parseInt(cnt.value, 10) || 1;
      if (!(d >= 1 && d <= MAXMIN)) { er.textContent = 'Minutes must be 1 - 1440.'; return; }
      if (n < 1 || n > 50) { er.textContent = 'Count must be 1 - 50.'; return; }
      er.textContent = ''; out.textContent = '';
      var h = ls(HKEY) || [], i, all = [];
      for (i = 0; i < n; i++) {
        if (d - i < 1) break;
        var k = keyFor(d, i), r = { t: Date.now(), note: note.value.trim(), key: k.key, exp: k.exp - 0 };
        r.exp = k.exp; all.push(r); h.unshift(r); out.appendChild(card(r));
      }
      ls(HKEY, h.slice(0, 200)); hist();
      if (all.length > 1) { var ca = el('button', 'p', 'COPY ALL'); ca.onclick = function () { copy(all.map(function (x) { return x.key; }).join('\n'), function () { ca.textContent = 'Copied'; }); }; out.appendChild(ca); }
    };
    b.appendChild(el('h3', '', 'HISTORY (THIS DEVICE)'));
    var hb = el('div'); b.appendChild(hb);
    var clr = el('button', '', 'Clear history'); clr.style.marginTop = '8px';
    clr.onclick = function () { if (confirm('Delete all history?')) { ls(HKEY, []); hist(); } }; b.appendChild(clr);
    function hist() { hb.textContent = ''; var h = ls(HKEY) || []; if (!h.length) hb.appendChild(el('div', 'zx-n', 'No keys yet.')); h.slice(0, 40).forEach(function (r) { hb.appendChild(card(r)); }); }
    hist(); tick = setInterval(hist, 30000);
    var gd = el('details'); gd.style.marginTop = '16px';
    var gs = el('summary', '', 'GitHub sync (needed for Delete)'); gs.style.cssText = 'cursor:pointer;color:#FFD700aa;font-size:12px'; gd.appendChild(gs);
    var tk = el('input'); tk.type = 'password'; tk.placeholder = 'GitHub token (repo contents: read & write)'; tk.value = token();
    var rem = el('label', 'zx-n'); var rc = el('input'); rc.type = 'checkbox'; rc.style.cssText = 'width:auto;margin-right:6px'; try { rc.checked = !!localStorage.getItem(TKEY); } catch (e) {}
    rem.appendChild(rc); rem.appendChild(document.createTextNode('Remember token on this device'));
    var sv = el('button', '', 'Save token'), sh = el('button', '', 'Show online revoked list'), gl = el('div');
    sv.onclick = function () { try { sessionStorage.setItem('zx_tk', tk.value.trim()); if (rc.checked) localStorage.setItem(TKEY, tk.value.trim()); else localStorage.removeItem(TKEY); } catch (e) {} say('Token saved.'); };
    sh.onclick = function () {
      gl.textContent = ''; say('Loading...');
      readList().then(function (o) {
        var L = parseList(o.text); say(L.length + ' key(s) revoked online.');
        L.forEach(function (l) {
          var key = lineKey(l), c = el('div', 'zx-k'), d = el('div'); d.appendChild(el('code', '', key.slice(0, 12) + '...')); d.appendChild(el('small', '', 'hashed entry')); c.appendChild(d);
          var rb = el('button', '', 'Restore'); rb.onclick = function () { rb.disabled = true; restoreHash(key).then(function () { var h = ls(HKEY) || []; return Promise.all(h.map(function (x) { return hashKey(x.key).then(function (hh) { if (hh === key) x.rev = false; }); })).then(function () { ls(HKEY, h); c.remove(); hist(); say('Key restored.'); }); }, function (e) { rb.disabled = false; say(e.message, true); }); };
          c.appendChild(rb); gl.appendChild(c);
        });
      }, function (e) { say(e.message, true); });
    };
    gd.appendChild(tk); gd.appendChild(rem); gd.appendChild(sv); gd.appendChild(sh); gd.appendChild(gl);
    gd.appendChild(el('div', 'zx-n', 'Create a fine-grained token at GitHub > Settings > Developer settings, for the ' + GH.repo + ' repo only, permission "Contents: Read and write". Deleted keys are written to ' + GH.path + ' (as hashes only) and the app blocks them on the next login.'));
    b.appendChild(gd);
    var dt = el('details'); dt.style.marginTop = '16px'; var sm = el('summary', '', 'Change admin login'); sm.style.cssText = 'cursor:pointer;color:#FFD700aa;font-size:12px'; dt.appendChild(sm);
    var nu = el('input'); nu.placeholder = 'New username'; var np = el('input'); np.placeholder = 'New password (min 10 chars)';
    var mk = el('button', '', 'Make config'), ta = el('textarea', 'zx-cfg'); ta.readOnly = true; ta.style.display = 'none';
    mk.onclick = function () {
      if (!nu.value.trim() || np.value.length < 10) { ta.style.display = 'block'; ta.value = 'Username required and password min 10 chars.'; return; }
      var s = new Uint8Array(16); crypto.getRandomValues(s); var sh = hex(s);
      derive(nu.value.trim(), np.value, sh, CFG.iter).then(function (h) { ta.style.display = 'block'; ta.value = "var CFG = { salt: '" + sh + "', hash: '" + h + "', iter: " + CFG.iter + ", idleMs: 15 * 60 * 1000 };"; });
    };
    dt.appendChild(nu); dt.appendChild(np); dt.appendChild(mk); dt.appendChild(ta);
    dt.appendChild(el('div', 'zx-n', 'Copy this line and replace the "var CFG = ..." line at the top of assets/fx.js, then re-upload.'));
    b.appendChild(dt);
  }
  var taps = [];
  function hit(e) {
    if (root) return;
    var fe = document.querySelector('.footer'), r = fe ? fe.getBoundingClientRect() : null;
    var inFooter = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inFooter && (e.clientX > 70 || e.clientY > 70)) return;
    var n = Date.now(); taps.push(n); taps = taps.filter(function (x) { return n - x < 4000; });
    if (taps.length >= 7) { taps = []; setTimeout(open, 350); }
  }
  document.addEventListener('pointerdown', hit, true);
  document.addEventListener('keydown', function (e) { if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); open(); } });
})();
