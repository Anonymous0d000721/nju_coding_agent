import { describe, expect, it } from 'vitest';
import { InventoryService, type InventoryState } from '../src/inventory.js';

const initial = (): InventoryState => ({ revision: 4, nextAuditId: 1, items: [
  { sku: 'book-red', available: 12, reserved: 0 }, { sku: 'book-blue', available: 3, reserved: 1 }, { sku: 'pen-black', available: 40, reserved: 0 },
], audit: [] });

describe('legacy API', () => {
  it('returns copies and releases reserved stock', () => {
    const service = new InventoryService(initial());
    expect(service.getStock('book-blue')).toEqual({ sku: 'book-blue', available: 3, reserved: 1 });
    expect(service.release('book-blue', 1)).toEqual({ sku: 'book-blue', available: 4, reserved: 0 });
  });
});

describe('reserveBatch', () => {
  it('atomically reserves multiple lines and writes one audit event per line', () => {
    const service = new InventoryService(initial());
    const result = service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'pen-black', quantity: 5 }], 'req-1');
    expect(result.items.find((item) => item.sku === 'book-red')).toMatchObject({ available: 10, reserved: 2 });
    expect(result.items.find((item) => item.sku === 'pen-black')).toMatchObject({ available: 35, reserved: 5 });
    expect(result.audit).toHaveLength(2);
    expect(result.audit.every((event) => event.requestId === 'req-1' && event.type === 'reserved')).toBe(true);
  });

  it('rolls back every line when one SKU is unavailable', () => {
    const service = new InventoryService(initial());
    expect(() => service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'book-blue', quantity: 99 }], 'req-2')).toThrow('insufficient_stock:book-blue');
    expect(service.snapshot()).toEqual(initial());
  });

  it('is idempotent and does not duplicate audit events on retry', () => {
    const service = new InventoryService(initial());
    const first = service.reserveBatch([{ sku: 'book-red', quantity: 1 }], 'same-request');
    const second = service.reserveBatch([{ sku: 'book-red', quantity: 1 }], 'same-request');
    expect(second).toEqual(first);
    expect(service.getStock('book-red').available).toBe(11);
    expect(service.snapshot().audit).toHaveLength(1);
  });

  it('rejects invalid quantities and unknown SKUs without mutation', () => {
    const service = new InventoryService(initial());
    for (const lines of [[{ sku: 'book-red', quantity: 0 }], [{ sku: 'missing', quantity: 1 }]]) {
      expect(() => service.reserveBatch(lines, 'bad-' + lines[0].sku)).toThrow();
    }
    expect(service.snapshot()).toEqual(initial());
  });
});
