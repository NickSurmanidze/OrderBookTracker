import { Decimal } from 'decimal.js';

// Orderbook entry with precise arithmetic support
export interface OrderBookEntry {
  price: Decimal; // Use Decimal for precise arithmetic
  quantity: Decimal; // Use Decimal for precise arithmetic
  originalPrice: string; // Original string from JSON to preserve exact representation for checksums
  originalQty: string; // Original string from JSON to preserve exact representation for checksums
}

// Complete orderbook state
export interface OrderBook {
  symbol: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  checksum: number;
  lastUpdate: Date;
}

// Market data structure for client consumption
export interface MarketData {
  orderbooksPerMinute: number;
  orderbook: {
    spread: string;
    midPrice: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
    lastUpdate: string;
    lastProcessedTimestamp?: string; // Last Kraken timestamp we processed to enforce ordering
  };
  subscriptionStatus:
    | 'subscribing'
    | 'subscribed'
    | 'unsubscribing'
    | 'unsubscribed'
    | 'error'
    | 'resyncing';
  lastError?: string;
}

// In-memory store type
export interface InMemoryStore {
  [symbol: string]: MarketData;
}
