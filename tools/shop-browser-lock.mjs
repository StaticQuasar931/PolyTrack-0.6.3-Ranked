/** Same-origin/account mutation exclusion. No localStorage mutex fallback.
 * ifAvailable deliberately rejects competing tabs instead of queuing stale intent.
 * The callback must settle only after its network operation settles.
 */
export class ShopBrowserLockError extends Error {
  constructor(code) { super(code); this.name = 'ShopBrowserLockError'; this.code = code; }
}
export function createShopBrowserLock({locks = globalThis.navigator?.locks} = {}) {
  return async function withAccountLock(accountId, work, {signal} = {}) {
    if (!/^[a-f0-9]{64}$/.test(accountId) || typeof work !== 'function') {
      throw new ShopBrowserLockError('invalid_shop_lock');
    }
    if (typeof locks?.request !== 'function') throw new ShopBrowserLockError('shop_locks_unavailable');
    if (signal?.aborted) throw new ShopBrowserLockError('shop_lock_cancelled');
    // Do not combine signal with ifAvailable: some implementations reject it.
    return locks.request('polytrack-shop-account-v1:' + accountId,
      {mode: 'exclusive', ifAvailable: true}, async lock => {
        if (!lock) throw new ShopBrowserLockError('shop_busy');
        if (signal?.aborted) throw new ShopBrowserLockError('shop_lock_cancelled');
        return work();
      });
  };
}
