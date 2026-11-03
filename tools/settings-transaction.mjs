// Source fixtures exercise the installed implementation without loading the game.
export function sourceBlock(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing installed source boundary: ${start}`);
  return source.slice(a, b);
}

export function installedSettingsSources(main, patch) {
  const helpers = sourceBlock(patch, '  let settingsPreferenceTransaction=', '  async function currentUserIsModerator(');
  const enhance = sourceBlock(patch, '  function ensureSettingsEnhancements(', '  function lobbyShortcutButtons(');
  const preferences = sourceBlock(patch, '  let lastPlacementUpdateAt=', '  let settingsPreferenceTransaction=');
  const native = sourceBlock(main, 'var qs,Qs,Js,', ';var wo=');
  const globalLiteral = sourceBlock(main, '`:root {', '`,""') + '`';
  const globalCss = new Function('f', 'p', 'g', `return ${globalLiteral}`)('__FONT__', '__FONT__', '__FONT__');
  const settingsLiteral = main.match(/s\.push\(\[e\.id,('(?:\\.|[^'\\])*settings-menu-ui(?:\\.|[^'\\])*')/);
  if (!settingsLiteral) throw new Error('Missing installed native settings CSS');
  const settingsCss = new Function(`return ${settingsLiteral[1]}`)();
  const styles = [];
  const document = {getElementById: () => null, createElement: () => ({textContent: ''}), head: {appendChild: node => styles.push(node.textContent)}};
  const install = sourceBlock(patch, '  function ensureStyles(){', '\n  function setUnofficialMessage(');
  // The omitted helper only supplies Overall footer CSS, not settings styles.
  new Function('document', 'overallFooterLayoutCss', install + ';ensureStyles();')(document, () => '');
  return {helpers, enhance, preferences, native, nativeCss: globalCss + '\n' + settingsCss, installedCss: styles.join('\n')};
}
