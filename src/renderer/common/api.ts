import type { QuotaBuddyApi } from '../../preload/preload';

declare global {
  interface Window {
    qb: QuotaBuddyApi;
  }
}

export const qb = (): QuotaBuddyApi => window.qb;
