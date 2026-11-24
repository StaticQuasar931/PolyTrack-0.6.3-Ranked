const key = 'polytrack:shortcut-tutorial:community-search:v1';

export function trackShortcutTutorialComplete(storage) {
  try { return storage?.getItem(key) === '1'; } catch { return false; }
}

export function completeTrackShortcutTutorial(storage) {
  try {
    if (!trackShortcutTutorialComplete(storage)) storage?.setItem(key, '1');
  } catch {}
}
