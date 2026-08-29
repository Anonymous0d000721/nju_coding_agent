export interface StockItem { sku: string; available: number; reserved: number; }
export interface AuditEvent { id: number; requestId: string; type: 'reserved' | 'rejected'; sku: string; quantity: number; reason?: string; }
export interface InventoryState { revision: number; nextAuditId: number; items: StockItem[]; audit: AuditEvent[]; }
export interface ReservationLine { sku: string; quantity: number; }

export class InventoryService {
  constructor(private readonly state: InventoryState) {}
  getStock(sku: string): StockItem {
    const item = this.state.items.find((entry) => entry.sku === sku);
    if (!item) throw new Error(`unknown_sku:${sku}`);
    return { ...item };
  }
  release(sku: string, quantity: number): StockItem {
    const item = this.state.items.find((entry) => entry.sku === sku);
    if (!item) throw new Error(`unknown_sku:${sku}`);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > item.reserved) throw new Error('invalid_release');
    item.reserved -= quantity;
    item.available += quantity;
    this.state.revision += 1;
    return { ...item };
  }
  reserveBatch(_lines: ReservationLine[], _requestId: string): { revision: number; items: StockItem[]; audit: AuditEvent[] } {
    throw new Error('reserveBatch_not_implemented');
  }
  snapshot(): InventoryState { return structuredClone(this.state); }
}
