import type { QuotaBuddiesApi } from '../../preload/preload';

declare global {
  interface Window {
    qb: QuotaBuddiesApi;
  }
}

export const qb = (): QuotaBuddiesApi => window.qb;
