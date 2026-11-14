export function installExitGuard(window){
  if(!window?.addEventListener)throw TypeError('Window required');
  if(window.__polytrackExitGuard)return window.__polytrackExitGuard;
  let intentionalUntil=0;
  const leave=event=>{if(Date.now()<intentionalUntil)return;event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',leave);
  const api=Object.freeze({allowReload(){intentionalUntil=Date.now()+1500;},cancelReload(){intentionalUntil=0;},dispose(){window.removeEventListener('beforeunload',leave);if(window.__polytrackExitGuard===api)delete window.__polytrackExitGuard;}});
  window.__polytrackExitGuard=api;return api;
}

if(typeof window!=='undefined'&&window.document)installExitGuard(window);
