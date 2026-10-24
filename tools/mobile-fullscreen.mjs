// Presentation only: never reparents the canvas, changes its backing size, or touches game timing.
export const MOBILE_FULLSCREEN_BUTTON_SELECTOR = 'button.button,button[data-sq-fullscreen-control]';
export const MOBILE_FULLSCREEN_CSS = `
html.sq-game-expanded { overflow: hidden !important; overscroll-behavior: none; }
html.sq-game-expanded body.sq-game-expanded {
  position: fixed !important; inset: auto !important;
  top: var(--sq-expanded-top, 0px) !important; left: var(--sq-expanded-left, 0px) !important;
  width: var(--sq-expanded-width, 100vw) !important;
  height: var(--sq-expanded-height, 100vh) !important;
  margin: 0 !important; max-width: none !important; max-height: none !important;
  overflow: hidden !important; overscroll-behavior: none;
}
[data-sq-expanded-controls] {
  position: fixed !important; z-index: 2147483647 !important;
  top: calc(var(--sq-expanded-top, 0px) + max(8px, env(safe-area-inset-top)));
  right: calc(100vw - var(--sq-expanded-left, 0px) - var(--sq-expanded-width, 100vw) + max(8px, env(safe-area-inset-right)));
  box-sizing: border-box; width: min(360px, calc(var(--sq-expanded-width, 100vw) - 24px));
  max-height: calc(var(--sq-expanded-height, 100vh) - 24px); overflow: auto; padding: 8px;
  color: #f3f7ff; background: #101827; border: 1px solid #92b5d9; border-radius: 8px;
  font: 13px/1.35 sans-serif; text-align: left; touch-action: auto;
}
[data-sq-expanded-controls] p { margin: 6px 0 0; }
[data-sq-expanded-controls] .sq-expanded-exit {
  display: block; width: 100%; min-width: 44px; min-height: 44px; box-sizing: border-box;
  padding: 10px 14px; border: 2px solid #bbdfff; border-radius: 4px;
  color: #fff; background: #24446b; font: 700 15px/1.25 sans-serif; cursor: pointer;
}
[data-sq-expanded-controls] summary { min-height: 44px; padding-top: 8px; box-sizing: border-box; cursor: pointer; }
[data-sq-expanded-controls] :is(button,summary):focus-visible { outline: 3px solid #fff; outline-offset: -4px; }
`;

const installations = new WeakMap();
const expandedClass = 'sq-game-expanded';
const properties = ['--sq-expanded-width', '--sq-expanded-height', '--sq-expanded-top', '--sq-expanded-left'];
const attributes = ['aria-label', 'aria-pressed', 'title'];

export function installMobileFullscreen({window = globalThis.window, document = globalThis.document} = {}) {
  if (!window || !document?.documentElement) return {mode: 'unavailable', toggle: async () => false, exit: async () => false, destroy() {}};
  if (installations.has(document)) return installations.get(document);
  const html = document.documentElement, labels = new Map();
  let destroyed = false, mounted = false, expanded = false, help = false, nativeFailed = false;
  let observer, style, controls, saved, pending, serial = 0, frame = 0;
  const nativeElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const ios = () => /iPhone|iPad|iPod/.test(window.navigator?.userAgent || '') ||
    window.navigator?.platform === 'MacIntel' && window.navigator?.maxTouchPoints > 1;
  const mobile = () => ios() || window.matchMedia?.('(pointer: coarse)')?.matches === true;
  const embedded = () => {try {return window.self !== window.top;} catch {return true;}};
  function nativeAPI() {
    if (document.fullscreenEnabled === false || window.electron) return null;
    for (const target of [document.body, html]) {
      if (typeof target?.requestFullscreen === 'function') return {target, request: target.requestFullscreen};
      if (document.webkitFullscreenEnabled !== false && typeof target?.webkitRequestFullscreen === 'function') {
        return {target, request: target.webkitRequestFullscreen};
      }
    }
    return null;
  }
  function alreadyFillsViewport() {
    const game = document.querySelector('#screen') || document.querySelector('[data-polytrack-container]') || document.body;
    const bounds = game?.getBoundingClientRect?.(), viewport = window.visualViewport;
    const left = Math.max(0, viewport?.offsetLeft || 0), top = Math.max(0, viewport?.offsetTop || 0);
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    return Boolean(bounds && width > 0 && height > 0 && bounds.left <= left + 2 && bounds.top <= top + 2 &&
      bounds.right >= left + width - 2 && bounds.bottom >= top + height - 2);
  }
  function isControl(button) {
    if (!button?.matches?.('button')) return false;
    if (labels.has(button) || button.hasAttribute('data-sq-fullscreen-control')) return true;
    return [...button.querySelectorAll('img')].some(image => /(?:^|\/)(?:fullscreen|windowed)\.svg(?:[?#].*)?$/.test(image.getAttribute('src') || ''));
  }
  function restoreLabel(button, record) {
    button.replaceChildren(...record.nodes);
    for (const [name, value] of record.attributes) {
      if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
    }
    labels.delete(button);
  }
  function renderLabels() {
    if (destroyed || !mounted) return;
    const fallback = !window.electron && !nativeElement() && (expanded || help || nativeFailed || !nativeAPI());
    for (const [button, record] of labels) if (!fallback || !button.isConnected) restoreLabel(button, record);
    if (!fallback) return;
    for (const button of document.querySelectorAll(MOBILE_FULLSCREEN_BUTTON_SELECTOR)) {
      if (!isControl(button)) continue;
      if (!labels.has(button)) labels.set(button, {nodes: [...button.childNodes], attributes: attributes.map(name => [name, button.getAttribute(name)])});
      const text = help ? 'Close fullscreen help' : expanded ? 'Exit expanded view' :
        alreadyFillsViewport() ? 'Fullscreen help' : 'Expand game (viewport only)';
      if (button.textContent !== text) button.textContent = text;
      if (button.getAttribute('aria-label') !== text) button.setAttribute('aria-label', text);
      button.setAttribute('aria-pressed', String(expanded || help));
      button.setAttribute('title', 'Viewport-only controls cannot hide browser chrome or create OS fullscreen.');
    }
  }
  function clearPending() {
    if (pending?.timer) window.clearTimeout(pending.timer);
    pending = null; serial++;
  }
  function measure() {
    frame = 0;
    if ((!expanded && !help) || destroyed) return;
    const viewport = window.visualViewport;
    const width = Math.max(1, viewport?.width || window.innerWidth || html.clientWidth || 1);
    const height = Math.max(1, viewport?.height || window.innerHeight || html.clientHeight || 1);
    [width, height, Math.max(0, viewport?.offsetTop || 0), Math.max(0, viewport?.offsetLeft || 0)]
      .forEach((value, index) => html.style.setProperty(properties[index], value + 'px'));
  }
  const scheduleMeasure = () => {
    if ((expanded || help) && !frame && !destroyed) frame = window.requestAnimationFrame(measure);
    else if (!expanded && !help) renderLabels();
  };
  function leaveFallback({restoreFocus = true} = {}) {
    if (!expanded && !help) return false;
    expanded = false; help = false;
    if (frame) window.cancelAnimationFrame(frame); frame = 0;
    controls?.remove(); controls = null;
    if (!saved.htmlClass) html.classList.remove(expandedClass);
    if (!saved.bodyClass) saved.body.classList.remove(expandedClass);
    for (const [name, value, priority] of saved.properties) {
      if (value) html.style.setProperty(name, value, priority); else html.style.removeProperty(name);
    }
    const previous = saved; saved = null;
    renderLabels();
    if (restoreFocus && previous.focus?.isConnected) previous.focus.focus?.({preventScroll: true});
    window.scrollTo?.({left: previous.x, top: previous.y, behavior: 'instant'});
    return true;
  }
  function enterFallback(trigger) {
    clearPending();
    if (destroyed || expanded || help || nativeElement() || !document.body) return false;
    const body = document.body;
    saved = {body, htmlClass: html.classList.contains(expandedClass), bodyClass: body.classList.contains(expandedClass),
      properties: properties.map(name => [name, html.style.getPropertyValue(name), html.style.getPropertyPriority(name)]),
      focus: trigger?.isConnected ? trigger : document.activeElement, x: window.scrollX || 0, y: window.scrollY || 0};
    help = alreadyFillsViewport(); expanded = !help;
    if (expanded) {html.classList.add(expandedClass); body.classList.add(expandedClass);}
    measure();
    controls = document.createElement('section');
    controls.setAttribute('data-sq-expanded-controls', '');
    controls.setAttribute('role', 'region'); controls.setAttribute('aria-label', help ? 'Fullscreen help' : 'Viewport-only game controls');
    const exitButton = document.createElement('button');
    exitButton.type = 'button'; exitButton.className = 'sq-expanded-exit'; exitButton.textContent = help ? 'Close fullscreen help' : 'Exit expanded view';
    exitButton.addEventListener('click', event => {event.preventDefault(); event.stopPropagation(); leaveFallback();});
    const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    message.textContent = (help ? 'The game already fills this viewport. Native fullscreen is unavailable or was declined; this button cannot hide browser controls.' :
      'Viewport-only presentation, not OS fullscreen. Browser controls may remain visible.') +
      (embedded() ? ' This stays inside the embedded frame.' : '');
    controls.append(exitButton, message);
    if (ios() && window.navigator?.standalone !== true && !window.matchMedia?.('(display-mode: standalone)')?.matches) {
      const hint = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p');
      summary.textContent = 'Safari tip (optional)';
      text.textContent = 'Safari Share > Add to Home Screen may use separate storage. Profiles and local saves may not transfer automatically.';
      hint.append(summary, text); controls.append(hint);
    }
    body.append(controls); renderLabels(); exitButton.focus({preventScroll: true});
    return true;
  }
  async function toggle(trigger = document.activeElement) {
    if (destroyed || window.electron || !document.body) return false;
    if (!mounted) mount();
    if (expanded || help) return leaveFallback();
    if (nativeElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit !== 'function') return false;
      try {await exit.call(document); return !nativeElement();} catch {return false;}
    }
    if (pending) return false;
    const api = nativeAPI();
    if (!api || nativeFailed) return enterFallback(trigger);
    const id = ++serial; pending = {id, trigger};
    try {
      const result = api.request.call(api.target);
      if (result?.then) await result;
      if (destroyed || pending?.id !== id) return expanded || help || Boolean(nativeElement());
      if (nativeElement()) {clearPending(); renderLabels(); return true;}
      if (result?.then) {nativeFailed = true; return enterFallback(trigger);}
      // Prefixed APIs may return void and announce completion asynchronously.
      pending.timer = window.setTimeout(() => {
        if (pending?.id === id && !nativeElement()) {nativeFailed = true; enterFallback(trigger);}
      }, 1000);
      return true;
    } catch {
      if (!destroyed && pending?.id === id) {nativeFailed = true; return enterFallback(trigger);}
      return expanded || help;
    }
  }
  async function exit() {
    if (expanded || help) return leaveFallback();
    if (!nativeElement()) return false;
    return toggle();
  }
  function onClick(event) {
    const button = event.target?.closest?.(MOBILE_FULLSCREEN_BUTTON_SELECTOR);
    if (destroyed || !button || button.disabled || event.defaultPrevented || event.button > 0 || !isControl(button) || window.electron) return;
    // Leave the native desktop button/renderer listener untouched when its API works.
    if (!expanded && !help && !nativeFailed && typeof document.body?.requestFullscreen === 'function' &&
        document.fullscreenEnabled !== false && !mobile()) {
      if (!nativeElement()) {
        clearPending(); const id = ++serial; pending = {id, trigger: button};
        pending.timer = window.setTimeout(clearPending, 5000);
      }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    void toggle(button);
  }
  function onNativeChange() {
    if (nativeElement()) {clearPending(); if (expanded || help) leaveFallback({restoreFocus: false});}
    renderLabels();
  }
  function onNativeError(event) {
    if (!pending || destroyed || nativeElement() || ![document, document.body, html].includes(event.target)) return;
    const trigger = pending.trigger; nativeFailed = true; enterFallback(trigger);
  }
  function onKey(event) {
    if ((expanded || help) && event.key === 'Escape') {event.preventDefault(); event.stopImmediatePropagation(); leaveFallback();}
  }
  const onPageHide = () => {clearPending(); leaveFallback({restoreFocus: false});};
  function mount() {
    if (destroyed || mounted || !document.body) return;
    mounted = true;
    style = document.createElement('style'); style.setAttribute('data-sq-mobile-fullscreen', ''); style.textContent = MOBILE_FULLSCREEN_CSS;
    (document.head || html).append(style);
    if (typeof window.MutationObserver === 'function') {
      observer = new window.MutationObserver(records => {
        // Ignore frame-by-frame HUD text updates; only button-containing changes matter.
        if (records.some(record => record.target?.closest?.(MOBILE_FULLSCREEN_BUTTON_SELECTOR) ||
            [...record.addedNodes, ...record.removedNodes].some(node =>
              node.matches?.(MOBILE_FULLSCREEN_BUTTON_SELECTOR) || node.querySelector?.(MOBILE_FULLSCREEN_BUTTON_SELECTOR)))) renderLabels();
      });
      observer.observe(html, {subtree: true, childList: true});
    }
    renderLabels();
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, onNativeChange);
  for (const name of ['fullscreenerror', 'webkitfullscreenerror']) document.addEventListener(name, onNativeError, true);
  document.addEventListener('DOMContentLoaded', mount, {once: true});
  for (const name of ['resize', 'orientationchange']) window.addEventListener(name, scheduleMeasure, {passive: true});
  window.visualViewport?.addEventListener('resize', scheduleMeasure, {passive: true});
  window.visualViewport?.addEventListener('scroll', scheduleMeasure, {passive: true});
  window.addEventListener('pagehide', onPageHide);
  const controller = {
    get mode() {return destroyed ? 'destroyed' : help ? 'help' : expanded ? 'expanded' : nativeElement() ? 'native' : pending ? 'native-pending' : 'windowed';},
    toggle, exit,
    destroy() {
      if (destroyed) return;
      clearPending(); leaveFallback(); destroyed = true;
      observer?.disconnect(); style?.remove();
      for (const [button, record] of labels) restoreLabel(button, record);
      document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('DOMContentLoaded', mount);
      for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.removeEventListener(name, onNativeChange);
      for (const name of ['fullscreenerror', 'webkitfullscreenerror']) document.removeEventListener(name, onNativeError, true);
      for (const name of ['resize', 'orientationchange']) window.removeEventListener(name, scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure); window.visualViewport?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('pagehide', onPageHide); installations.delete(document);
    },
  };
  installations.set(document, controller); mount();
  return controller;
}
