import type http from 'node:http';

/**
 * `/.well-known/assetlinks.json`: tells Chrome that the Android app (android/, a Trusted
 * Web Activity) belongs to this site, so the app shows the page without an address bar.
 * Set MIMI_ANDROID_CERT_SHA256 to the SHA-256 fingerprint of the key that signs the APK
 * (several separated by commas); MIMI_ANDROID_PACKAGE when the package name differs.
 * Answers false (not handled) when nothing is set.
 */
export function serveAssetLinks(method: string | undefined, pathname: string, response: http.ServerResponse, env: NodeJS.ProcessEnv = process.env): boolean {
  if (method !== 'GET' || pathname !== '/.well-known/assetlinks.json') return false;
  const fingerprints = (env.MIMI_ANDROID_CERT_SHA256 ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
  if (fingerprints.length === 0) return false;
  const statement = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: env.MIMI_ANDROID_PACKAGE?.trim() || 'app.mimi.android', sha256_cert_fingerprints: fingerprints },
    },
  ];
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
  response.end(JSON.stringify(statement));
  return true;
}
