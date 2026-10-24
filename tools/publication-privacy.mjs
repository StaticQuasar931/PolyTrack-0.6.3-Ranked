const PRIVATE_PATHS = [
  /^workers\/ranked\/test\/quota-rules-candidate\.test\.js$/i,
  /^docs\/security(?:\/|$)/i,
  /\.rules(?:\.|$)/i,
  /(?:^|\/)(?:firebase-config\.local|service-account|serviceAccount)(?:\.|$)/i,
  /(?:^|\/)[^/]*(?:firebase-adminsdk|service[_-]account|credentials)[^/]*\.json$/i,
  /(?:^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|[^/]+\.(?:pem|p12|key))$/i
];

export function privatePublicationPaths(paths) {
  return paths.filter(path => {
    const normalized = String(path).replaceAll('\\', '/').replace(/^\.\//, '');
    if (/(?:^|\/)\.env\.example$/.test(normalized)) return false;
    return PRIVATE_PATHS.some(pattern => pattern.test(normalized));
  });
}
