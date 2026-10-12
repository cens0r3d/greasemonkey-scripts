// ==UserScript==
// @name         TikTok LIVE · Auto-Stay
// @namespace    nwo-telaviv.tiktok.autostay
// @version      2.0.0
// @description  Cancels TikTok LIVE's "next LIVE in N seconds" pause countdown automatically, so you stay in the stream. Multilingual detection, drag-and-drop badge, stats, kill switch on Alt+C.
// @author       NWO_TelAviv
// @match        https://www.tiktok.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @noframes
// ==/UserScript==

/**
 * Auto-Stay for paused TikTok LIVEs.
 *
 * 1. DETECT   A short element whose text contains "LIVE" + a number + a seconds
 *             unit ("in 4 seconds", "in 4 Sekunden", "4秒"). "LIVE" is written
 *             the same in almost every locale, so this survives UI language
 *             changes and class-name churn.
 * 2. CONFIRM  The countdown must sit in a flat container that also shows a pause
 *             hint ("LIVE Pause", "Paused", "En pause"). This filters out chat
 *             lines such as "the next live in 5 seconds".
 * 3. ACT      A full pointer/mouse/click sequence is sent to the cancel control,
 *             because React listens on bubbling events. If the overlay survives,
 *             it escalates: direct click() -> keyboard -> wrapper elements ->
 *             give up with a console warning.
 * 4. GUARD    A stream that really ended ("LIVE has ended") is never cancelled.
 */

(() => {
  'use strict';

  const VERSION = '2.0.0';
  const LOG = '[AutoStay]';

  /* ------------------------------------------------------------------ config */

  const CONFIG = {
    mode: 'stay',            // 'stay' = cancel the countdown | 'off' = observe only
    giveUpAfter: 0,          // 0 = never give up; N = let TikTok move on after N cancels in one stream
    clickCooldownMs: 1200,   // minimum gap between two click attempts
    scanIntervalMs: 400,     // minimum gap between two DOM scans (keeps CPU low on busy chats)
    retryDelayMs: 700,       // grace period before a click is considered failed
    maxClickLevel: 4,        // escalation steps per overlay
    notify: false,           // desktop notification on the first successful cancel
    badge: true,             // show the status badge
    badgeTop: 84,            // badge offset from the top (px)
    badgeRight: 16,          // badge offset from the right (px)
    hotkey: true,            // Alt+C toggles Auto-Stay
    debug: false,            // console logging
  };

  const debug = (...args) => { if (CONFIG.debug) console.log(LOG, ...args); };

  /* ----------------------------------------------------------------- storage */
  // Greasemonkey 4 dropped the legacy GM_* names, so fall back to localStorage.
  const store = {
    get(key, fallback) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (e) { /* ignore */ }
      try {
        const raw = localStorage.getItem('ttAutoStay:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; } } catch (e) { /* ignore */ }
      try { localStorage.setItem('ttAutoStay:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  /* ---------------------------------------------------------------- patterns */

  const SECONDS = [
    'sekunden', 'sekunde', 'sek', 'seconds', 'second', 'sec',
    'secondes', 'seconde', 'segundos', 'segundo', 'secondi', 'secondo',
    'sekunder', 'sekund', 'sekundy', 'sekunda', 'saniye', 'seconden',
    '秒', '초', 'ثواني', 'ثانية', 'ثانیه', 'giây', 'секунд', 'секунды', 'δευτερόλεπτα',
  ].join('|');

  // number + seconds unit; no trailing \b because CJK characters are not \w
  const RX_COUNTDOWN = new RegExp(`(?:^|[^\\d])\\d{1,3}\\s*(?:${SECONDS})(?![a-zäöüß])`, 'i');
  const RX_LIVE = /(^|[^a-zäöü])live([^a-zäöü]|$)/i;
  const RX_PAUSE = /paus|en pause|en attente|一時停止|일시정지|暂停|暫停|متوقف/i;
  const RX_CANCEL = /^(abbrechen|abbrechen\.?|cancel|annuler|annulla|annullare|cancelar|anular|annuleer|afbreken|avbryt|anuluj|anulovať|zrušit|otkaži|отмена|отменить|取消|キャンセル|취소|إلغاء|huỷ|hủy|iptal|peruuta|aflys|afbryd|dranbleiben|stay)\b/i;
  const RX_ENDED = /(live\s+(ist\s+)?(beendet|vorbei|zu\s+ende)|live\s+has\s+ended|live\s+ended|est\s+termin[ée]|ha\s+finalizado|terminato|終了しました|종료되었습니다|已结束|завершён)/i;
  const RX_CHAT = /chat|comment|kommentar|message|nachricht|danmaku|room-?message/i;
  const RX_CHEAP = new RegExp(`(?:\\d|${SECONDS})`, 'i'); // pre-filter, cheap

  /* ------------------------------------------------------------- dom helpers */

  const isLivePage = () => /\/live(\/|$|\?)/.test(location.pathname);

  const rectOf = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };

  const textOf = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  /** Element text, but with a hard character budget: reading textContent of a
   *  huge container (1000 chat lines) is the one thing that kills performance.
   *  `truncated` means "too big to inspect" - callers treat that as no match. */
  function textUpTo(root, budget) {
    let out = '';
    let truncated = false;
    const walk = (node) => {
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === 3) out += child.nodeValue;
        else if (child.nodeType === 1) {
          const tag = child.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
          walk(child);
        }
        if (out.length > budget) { truncated = true; return; }
      }
    };
    walk(root);
    return { text: truncated ? out.slice(0, budget) : out, truncated };
  }

  /** Own styles, ancestor display/visibility and a real box. Ancestor opacity or
   *  aria-hidden are ignored on purpose: fade-ins and decor wrappers would
   *  otherwise produce false negatives. */
  function isVisible(el) {
    if (!el || !el.isConnected || el.closest('[hidden]')) return false;
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 15) {
      let cs;
      try { cs = getComputedStyle(node); } catch (e) { break; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (node === el && (cs.opacity === '0' || node.getAttribute('aria-hidden') === 'true')) return false;
      node = node.parentElement; depth++;
    }
    const rect = rectOf(el);
    return !(rect && rect.width === 0 && rect.height === 0);
  }

  /** Flat surface (the overlay), not an inline span. A zero-box means "layout
   *  not measurable" and must not count as a decision. */
  function isFlatSurface(el) {
    const rect = rectOf(el);
    if (!rect) return false;
    if (rect.width === 0 && rect.height === 0) return true;
    return rect.width >= 180 && rect.height >= 80;
  }

  const classString = (el) => (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '');

  function inChatArea(el) {
    let node = el, depth = 0;
    while (node && node !== document.body && depth < 8) {
      const id = (node.getAttribute && (node.getAttribute('data-e2e') || node.getAttribute('data-testid'))) || '';
      if (RX_CHAT.test(classString(node)) || RX_CHAT.test(id)) return true;
      node = node.parentElement; depth++;
    }
    return false;
  }

  /** Walk text nodes without TreeWalker. `skipContainer(el)` prunes whole
   *  subtrees (chat areas). */
  function eachTextNode(root, fn, skipContainer) {
    const stack = [root];
    while (stack.length) {
      const kids = stack.pop().childNodes;
      if (!kids) continue;
      for (let i = kids.length - 1; i >= 0; i--) {
        const child = kids[i];
        const type = child.nodeType;
        if (type === 3) { fn(child); continue; }
        if (type !== 1) continue;
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        if (skipContainer && skipContainer(child)) continue;
        stack.push(child);
      }
    }
  }

  const isChatContainer = (el) => {
    const id = (el.getAttribute && (el.getAttribute('data-e2e') || el.getAttribute('data-testid'))) || '';
    return RX_CHAT.test(classString(el)) || RX_CHAT.test(id);
  };

  /* --------------------------------------------------------------- detection */

  /** Innermost elements whose text is a countdown line. Element level (not text
   *  node level), because TikTok splits the sentence across nodes. */
  function collectCountdowns() {
    const hits = [];
    const seen = new Set();
    let visits = 0;

    eachTextNode(document.body, (node) => {
      if (visits > 400) return;                                   // safety valve
      const raw = node.nodeValue;
      if (!raw) return;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 120 || !RX_CHEAP.test(trimmed)) return;
      visits++;

      let el = node.parentElement, depth = 0;
      while (el && el !== document.body && depth < 6) {
        const { text, truncated } = textUpTo(el, 200);
        if (truncated) break;                                     // too big, stop climbing
        const t = text.replace(/\s+/g, ' ').trim();
        if (RX_COUNTDOWN.test(t) && RX_LIVE.test(t)) {
          if (isVisible(el) && !inChatArea(el) && !seen.has(el)) { seen.add(el); hits.push(el); }
          break;
        }
        el = el.parentElement; depth++;
      }
    }, isChatContainer);

    if (hits.length < 2) return hits;
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  }

  /** Climb from the countdown to the flat container that also shows the pause
   *  hint - that container is the overlay. */
  function findOverlay(el) {
    let node = el, depth = 0, loose = null;
    while (node && node !== document.body && depth < 14) {
      const { text, truncated } = textUpTo(node, 600);
      if (!truncated && RX_PAUSE.test(text) && !RX_ENDED.test(text)) {
        if (isFlatSurface(node)) return node;
        if (!loose) loose = node;
      }
      node = node.parentElement; depth++;
    }
    return loose;
  }

  /** Click targets inside the overlay, best first. Cancel wording beats a plain
   *  button, leaf nodes beat wrappers (React handlers may live on the leaf). */
  function collectCancelTargets(root) {
    const found = [];
    const seen = new Set();

    const add = (el, score, label) => {
      if (!el || seen.has(el) || !isVisible(el)) return;
      const { text, truncated } = textUpTo(el, 60);
      if (truncated) return;
      const label2 = text.replace(/\s+/g, ' ').trim();
      if (!label2 || label2.length > 40) return;
      if (RX_COUNTDOWN.test(label2) && RX_LIVE.test(label2)) return;   // the countdown itself
      if (RX_PAUSE.test(label2) && !RX_CANCEL.test(label2)) return;    // the pause headline
      seen.add(el);
      found.push({ el, score, label: label || label2 });
    };

    eachTextNode(root, (node) => {
      const el = node.parentElement;
      if (!el || inChatArea(el)) return;
      const { text, truncated } = textUpTo(el, 60);
      if (truncated) return;
      const t = text.replace(/\s+/g, ' ').trim();
      if (!RX_CANCEL.test(t)) return;
      add(el, 120, t);                                    // leaf with the cancel wording
      if (el.parentElement) add(el.parentElement, 60, t);  // its wrapper
    });

    root.querySelectorAll('button, [role="button"], a[href], [tabindex]:not([tabindex="-1"])')
      .forEach((el) => { if (RX_CANCEL.test(textOf(el))) add(el, 100); });

    if (!found.length) {                                  // last resort: any control
      root.querySelectorAll('button, [role="button"], a[href]').forEach((el) => add(el, 12));
    }

    return found.sort((a, b) => b.score - a.score);
  }

  /* ------------------------------------------------------------------- clicks */

  function fire(el, type, Ctor, extra) {
    const rect = rectOf(el) || { left: 0, top: 0, width: 0, height: 0 };
    const released = type === 'pointerup' || type === 'mouseup' || type === 'click';
    const init = Object.assign({
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      buttons: released ? 0 : 1,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }, extra || {});
    try {
      el.dispatchEvent(new Ctor(type, init));
    } catch (e) {
      try { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true })); }
      catch (e2) { debug('could not dispatch', type, e2); }
    }
  }

  const PointerCtor = () => (typeof PointerEvent === 'function' ? PointerEvent : MouseEvent);

  function pointerSequence(el) {
    fire(el, 'pointerover', PointerCtor());
    fire(el, 'mouseover', MouseEvent);
    fire(el, 'pointerenter', PointerCtor(), { bubbles: false });
    fire(el, 'mouseenter', MouseEvent, { bubbles: false });
    fire(el, 'pointerdown', PointerCtor());
    fire(el, 'mousedown', MouseEvent);
    try { el.focus && el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    fire(el, 'pointerup', PointerCtor());
    fire(el, 'mouseup', MouseEvent);
    fire(el, 'click', MouseEvent);
  }

  function keyboardSequence(el) {
    ['Enter', ' '].forEach((key) => {
      const code = key === ' ' ? 'Space' : 'Enter';
      const keyCode = key === ' ' ? 32 : 13;
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        fire(el, type, KeyboardEvent, { key, code, keyCode, which: keyCode });
      });
    });
    try { el.click(); } catch (e) { /* ignore */ }
  }

  /** Each escalation level adds exactly one new technique. */
  function dispatchClick(el, level) {
    if (level === 0) return pointerSequence(el);
    if (level === 1) { try { el.click(); } catch (e) { /* ignore */ } return; }
    if (level === 2) return keyboardSequence(el);
    const parent = el.parentElement;
    const grand = parent && parent.parentElement;
    if (parent) pointerSequence(parent);
    if (grand) pointerSequence(grand);
    if (grand && grand.parentElement) pointerSequence(grand.parentElement);
  }

  /* -------------------------------------------------------------------- state */

  const state = {
    mode: 'stay',
    cancels: 0,          // confirmed cancels in the current stream
    totalCancels: 0,     // confirmed cancels overall (persisted)
    lastClickAt: 0,
    url: location.href,
    hostAway: false,
    lastResult: '-',
  };

  const pending = new Map();  // overlay element -> { level, at }

  state.totalCancels = Number(store.get('totalCancels', 0)) || 0;
  state.mode = store.get('mode', CONFIG.mode) === 'off' ? 'off' : 'stay';
  CONFIG.mode = state.mode;

  function setMode(mode) {
    state.mode = mode === 'off' ? 'off' : 'stay';
    CONFIG.mode = state.mode;
    store.set('mode', state.mode);
    pending.clear();
    renderBadge();
    debug('mode:', state.mode);
  }

  function notify(title, text) {
    if (!CONFIG.notify) return;
    try {
      if (typeof GM_notification === 'function') { GM_notification({ title, text, timeout: 6000 }); return; }
      if (typeof GM !== 'undefined' && GM && GM.notification) { GM.notification({ title, text, timeout: 6000 }); return; }
      if (typeof Notification === 'function' && Notification.permission === 'granted') new Notification(title, { body: text });
    } catch (e) { debug('notification failed', e); }
  }

  /* -------------------------------------------------------------------- badge */

  let badge = null;
  let dragBound = false;
  let drag = null;
  let suppressClick = false;
  let mountTry = 0;

  const defaultPos = () => ({ top: Number(CONFIG.badgeTop) || 84, right: Number(CONFIG.badgeRight) || 16 });

  function savedPos() {
    const pos = store.get('badgePos', null);
    return (pos && typeof pos.left === 'number' && typeof pos.top === 'number') ? pos : null;
  }

  function clampPos(left, top, width, height) {
    const maxLeft = (window.innerWidth || 1280) - (width || 0);
    const maxTop = (window.innerHeight || 720) - (height || 0);
    return { left: Math.round(Math.max(0, Math.min(left, maxLeft))), top: Math.round(Math.max(0, Math.min(top, maxTop))) };
  }

  function styleBadge() {
    const pos = savedPos();
    const base = defaultPos();
    badge.style.cssText = [
      'position:fixed', 'z-index:2147483000', 'margin:0',
      pos ? 'left:' + pos.left + 'px' : 'right:' + base.right + 'px',
      'top:' + (pos ? pos.top : base.top) + 'px',
      'display:flex', 'align-items:center', 'justify-content:center', 'text-align:center',
      'padding:5px 11px', 'border-radius:999px',
      'font:600 11px/1.25 -apple-system,Segoe UI,Roboto,sans-serif',
      'color:#fff', 'background:rgba(0,0,0,.74)', 'border:1px solid rgba(255,255,255,.25)',
      'cursor:grab', 'user-select:none', 'touch-action:none', 'white-space:nowrap',
      'letter-spacing:.02em', 'box-shadow:0 2px 10px rgba(0,0,0,.35)',
    ].join(';');
    if (pos) { badge.style.left = pos.left + 'px'; badge.style.top = pos.top + 'px'; }
  }

  function renderBadge() {
    if (!badge) return;
    const on = state.mode === 'stay';
    badge.textContent = on ? '🛡 Auto-Stay · ' + state.cancels + '×' : '🛡 Auto-Stay off';
    badge.style.borderColor = on ? 'rgba(37,244,238,.6)' : 'rgba(255,255,255,.25)';
    badge.style.background = on ? 'rgba(0,60,60,.8)' : 'rgba(0,0,0,.74)';
  }

  function flashBadge(color) {
    if (!badge) return;
    badge.style.borderColor = color;
    setTimeout(renderBadge, 900);
  }

  /* drag: grab the badge, drop it anywhere; the position is remembered */
  function dragStart(ev) {
    if (!badge || (ev.button !== undefined && ev.button > 0)) return;
    const rect = rectOf(badge) || { left: 0, top: 0, width: 0, height: 0 };
    drag = { x: ev.clientX || 0, y: ev.clientY || 0, left: rect.left, top: rect.top, w: rect.width, h: rect.height, moved: false, pos: null };
    badge.style.cursor = 'grabbing';
    if (typeof badge.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try { badge.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
    ev.stopPropagation();
  }

  function dragMove(ev) {
    if (!drag || !badge) return;
    const dx = (ev.clientX || 0) - drag.x;
    const dy = (ev.clientY || 0) - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;   // still a click
    drag.moved = true;
    drag.pos = clampPos(drag.left + dx, drag.top + dy, drag.w, drag.h);
    badge.style.left = drag.pos.left + 'px';
    badge.style.top = drag.pos.top + 'px';
    badge.style.right = 'auto';
  }

  function dragEnd() {
    if (!drag) return;
    const { moved, pos } = drag;
    drag = null;
    if (badge) badge.style.cursor = 'grab';
    suppressClick = moved;
    if (moved && pos) { store.set('badgePos', pos); debug('badge position saved', pos); }
  }

  /** Bound where the badge is created, not in boot(): the badge can exist before
   *  DOMContentLoaded, and then the move handler would be missing. */
  function bindDragEvents() {
    if (dragBound) return;
    dragBound = true;
    document.addEventListener('pointermove', dragMove, true);
    document.addEventListener('pointerup', dragEnd, true);
    document.addEventListener('pointercancel', dragEnd, true);
    window.addEventListener('resize', () => {
      const pos = savedPos();
      if (!badge || !badge.isConnected || !pos) return;
      const rect = rectOf(badge) || { width: 0, height: 0 };
      const fit = clampPos(pos.left, pos.top, rect.width, rect.height);
      if (fit.left !== pos.left || fit.top !== pos.top) {
        store.set('badgePos', fit);
        badge.style.left = fit.left + 'px';
        badge.style.top = fit.top + 'px';
      }
    });
  }

  /** The badge lives in the viewport corner (top right by default) and never
   *  inside TikTok's DOM: no layout to guess, nothing React can delete without
   *  us noticing. */
  function ensureBadge() {
    if (!CONFIG.badge) return;
    bindDragEvents();

    if (!isLivePage()) {
      if (badge && badge.isConnected) badge.remove();
      return;
    }
    const root = document.body || document.documentElement;
    if (!root) return;

    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ttlivestay-badge';
      badge.title = 'Auto-Stay: click = on/off (Alt+C) · drag = move · double click = reset position';
      badge.addEventListener('pointerdown', dragStart);
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }   // that was a drag
        setMode(state.mode === 'stay' ? 'off' : 'stay');
      });
      badge.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.set('badgePos', null);
        styleBadge();
        renderBadge();
      });
    }
    if (badge.isConnected && badge.parentElement === root) return;
    if (Date.now() - mountTry < 1000) return;
    mountTry = Date.now();

    styleBadge();
    try { root.appendChild(badge); } catch (e) { debug('could not mount badge', e); }
    renderBadge();
  }

  /* --------------------------------------------------------------------- core */

  /** One scan: find overlays, click the cancel control, escalate later. */
  function scan() {
    if (!isLivePage() || !document.body || state.mode !== 'stay') { renderBadge(); return 0; }
    if (CONFIG.giveUpAfter > 0 && state.cancels >= CONFIG.giveUpAfter) return 0;

    const countdowns = collectCountdowns();
    if (!countdowns.length) {
      if (state.hostAway) { state.hostAway = false; state.lastResult = 'host back'; debug('host is back'); }
      return 0;
    }

    const overlays = new Set();
    countdowns.forEach((el) => {
      const overlay = findOverlay(el);
      if (overlay && !RX_ENDED.test(textOf(overlay))) overlays.add(overlay);
    });
    if (!overlays.size) return 0;
    state.hostAway = true;

    let clicked = 0;
    overlays.forEach((overlay) => {
      const info = pending.get(overlay) || { level: 0, at: 0 };
      if (info.level >= CONFIG.maxClickLevel) return;
      if (Date.now() - state.lastClickAt < CONFIG.clickCooldownMs) return;

      const target = collectCancelTargets(overlay)[0];
      if (!target) { debug('no cancel control found'); return; }

      dispatchClick(target.el, info.level);
      state.lastClickAt = Date.now();
      pending.set(overlay, { level: info.level + 1, at: Date.now() });
      debug('click level', info.level + 1, 'on', JSON.stringify(target.label));
      clicked++;
    });

    renderBadge();
    return clicked;
  }

  /** Confirm clicks: only a countdown that actually disappeared counts. */
  function verify() {
    let confirmed = 0;
    const now = Date.now();

    [...pending.entries()].forEach(([overlay, info]) => {
      if (now - info.at < CONFIG.retryDelayMs) return;

      const counting = document.contains(overlay) && collectCountdowns().some((el) => overlay.contains(el));
      if (counting) {
        if (info.level >= CONFIG.maxClickLevel) {
          pending.delete(overlay);
          state.lastResult = 'gave up';
          console.warn(LOG, 'cancel control ignored synthetic events after', info.level, 'levels. Overlay text:', JSON.stringify(textOf(overlay).slice(0, 160)));
        }
        return;
      }

      pending.delete(overlay);
      confirmed++;
      state.cancels++;
      state.totalCancels++;
      state.lastResult = 'countdown cancelled';
      store.set('totalCancels', state.totalCancels);
      if (state.cancels === 1) {
        notify('TikTok LIVE', 'Pause countdown cancelled automatically - you stay in the stream.');
        flashBadge('rgba(37,244,238,.95)');
      }
      renderBadge();
      debug('cancel confirmed · stream:', state.cancels, '· total:', state.totalCancels);
    });

    return confirmed;
  }

  /* --------------------------------------------------------------- main loop */

  let scanTimer = null;
  let lastScanAt = 0;

  function scheduleScan(delay) {
    if (scanTimer) return;
    const since = Date.now() - lastScanAt;
    const wait = Math.max(delay || 220, since < CONFIG.scanIntervalMs ? CONFIG.scanIntervalMs - since : 0);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      lastScanAt = Date.now();
      scan();
      verify();
    }, wait);
  }

  function boot() {
    ensureBadge();

    if (typeof MutationObserver === 'function' && document.body) {
      new MutationObserver(() => scheduleScan(220)).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // safety net: the countdown ticks every second, and the badge may need remounting
    setInterval(() => { scheduleScan(300); ensureBadge(); }, 1000);

    if (CONFIG.hotkey) {
      document.addEventListener('keydown', (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault();
          setMode(state.mode === 'stay' ? 'off' : 'stay');
        }
      }, true);
    }

    // new stream after an SPA navigation: reset the per-stream counter
    setInterval(() => {
      if (location.href === state.url) return;
      state.url = location.href;
      state.cancels = 0;
      state.hostAway = false;
      pending.clear();
      scheduleScan(400);
    }, 1500);

    scheduleScan(500);
    debug('ready · version', VERSION, '· mode:', state.mode);
  }

  // debug handle
  window.__ttAutoStay = {
    version: VERSION, config: CONFIG, state, pending,
    scan, verify, setMode, ensureBadge,
    tick: () => { scan(); verify(); ensureBadge(); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
