export const UPDATE_REMINDER_KEY = 'polytrack-update-reminders-v1';
const visits = new WeakMap();
/** One visit/session is one Document lifetime, including bfcache restores. */
export function updateReminderPreference(document) {
  if (visits.has(document)) return visits.get(document);
  let storage, saved, hidden = false;
  try { storage = document.defaultView?.localStorage; const raw = storage?.getItem(UPDATE_REMINDER_KEY);
    if (typeof raw === 'string' && raw.length <= 128) saved = JSON.parse(raw);
  } catch { /* Optional preferences never affect compatibility. */ }
  let state = saved?.v === 1 && Number.isInteger(saved.d) && saved.d >= 0 && saved.d <= 3 &&
    Number.isInteger(saved.wait) && saved.wait >= 0 && saved.wait <= 3 && typeof saved.off === 'boolean'
    ? {v:1,d:saved.d,wait:Math.max(0,saved.wait-1),off:saved.off} : {v:1,d:0,wait:0,off:false};
  const persist = () => { try { storage?.setItem(UPDATE_REMINDER_KEY, JSON.stringify(state)); } catch {} };
  if (saved) persist();
  const preference = Object.freeze({
    suppressed: () => hidden || state.off || state.wait > 0,
    canTurnOff: () => state.d >= 3,
    dismiss(action) {
      if (!['session','visits','off'].includes(action) || action === 'off' && state.d < 3) return false;
      hidden = true; state = {...state,d:Math.min(3,state.d+1),wait:action === 'visits' ? 3 : 0,off:state.off || action === 'off'};
      persist(); return true;
    }
  });
  visits.set(document, preference); return preference;
}

/** Independent menu chrome, never owns update/reload or compatibility policy. */
export function bindUpdateDismissal({document, button, preference, onDismiss = () => {}, enabled = () => true}) {
  let menu = null, items = [];
  const held = new Set();
  const close = (restore = false) => {
    if (!menu) return;
    menu.remove(); menu = null; items = []; button.setAttribute('aria-expanded','false');
    if (restore && button.isConnected && !button.hidden) button.focus();
  };
  const open = event => {
    if (button.hidden || !enabled()) return;
    event.preventDefault(); event.stopPropagation(); close();
    menu = document.createElement('div'); menu.className = 'site-update-dismissal';
    menu.setAttribute('role','menu'); menu.setAttribute('aria-label','Update reminders');
    Object.assign(menu.style,{position:'fixed',right:'16px',bottom:'72px',maxWidth:'calc(100vw - 32px)',maxHeight:'calc(100dvh - 88px)',overflow:'auto',zIndex:'2147483647',padding:'8px',background:'#182c53',border:'2px solid #7ee7ff',color:'#fff'});
    const choices = [['session','Hide for current session'],['visits','Remind me after 3 visits']];
    if (preference.canTurnOff()) choices.push(['off','Turn off update reminders']);
    items = choices.map(([action,label]) => {
      const item = document.createElement('button'); item.type='button'; item.textContent=label;
      item.setAttribute('role','menuitem'); item.tabIndex=-1;
      Object.assign(item.style,{display:'block',width:'100%',minHeight:'44px',padding:'10px',textAlign:'left',font:'18px/1.3 ForcedSquare,sans-serif',color:'inherit',background:'#213e69',border:'1px solid #6889af',margin:'4px 0',cursor:'pointer'});
      item.addEventListener('click',e=>{e.stopPropagation(); if (!enabled()) { close(); return; }
        if (preference.dismiss(action)) { close(); onDismiss(); } });
      menu.append(item); return item;
    });
    document.body.append(menu); button.setAttribute('aria-expanded','true'); items[0].focus();
  };
  const triggerKey = event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') open(event); };
  const key = event => {
    const code=event.code || event.key;
    if (event.type === 'keyup') { if (held.delete(code)) event.stopImmediatePropagation(); return; }
    if (!menu) return;
    held.add(code);
    // Capture before game shortcuts. Tab retains normal navigation, closing menu.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Tab') close();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const current=items.indexOf(document.activeElement);
      const index=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[index].focus();
    }
  };
  const outside = event => { if (menu && !menu.contains(event.target) && event.target !== button) close(); };
  button.setAttribute('aria-haspopup','menu'); button.setAttribute('aria-expanded','false');
  button.addEventListener('contextmenu',open); button.addEventListener('keydown',triggerKey);
  document.addEventListener('keydown',key,true); document.addEventListener('keyup',key,true); document.addEventListener('pointerdown',outside,true); document.addEventListener('focusin',outside,true);
  return {close, dispose() { close(); held.clear(); button.removeEventListener?.('contextmenu',open); button.removeEventListener?.('keydown',triggerKey);
    document.removeEventListener('keydown',key,true); document.removeEventListener('keyup',key,true); document.removeEventListener('pointerdown',outside,true); document.removeEventListener('focusin',outside,true); }};
}
