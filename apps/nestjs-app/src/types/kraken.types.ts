export interface KrakenBookSnapshot {
  channel: 'book';
  type: 'snapshot';
  data: [
    {
      symbol: string;
      bids: [string, string][]; // [price, qty]
      asks: [string, string][]; // [price, qty]
      checksum: number;
    },
  ];
}

export interface KrakenBookUpdate {
  channel: 'book';
  type: 'update';
  data: [
    {
      symbol: string;
      bids?: [string, string][]; // [price, qty]
      asks?: [string, string][]; // [price, qty]
      checksum: number;
    },
  ];
}

export interface KrakenSubscriptionMessage {
  method: 'subscribe' | 'unsubscribe';
  params: {
    channel: 'book';
    symbol: string[];
    depth?: number;
  };
  req_id?: number;
}

export interface KrakenSubscriptionStatus {
  method: 'subscribe' | 'unsubscribe';
  result: {
    channel: 'book';
    depth: number;
    snapshot: boolean;
    symbol: string;
  };
  success: boolean;
  time_in: string;
  time_out: string;
  req_id?: number;
}

import { Decimal } from 'decimal.js';

export interface OrderBookEntry {
  price: Decimal; // Use Decimal for precise arithmetic
  quantity: Decimal; // Use Decimal for precise arithmetic
  originalPrice: string; // Original string from JSON to preserve exact representation for checksums
  originalQty: string; // Original string from JSON to preserve exact representation for checksums
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  checksum: number;
  lastUpdate: Date;
}

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

export interface InMemoryStore {
  [symbol: string]: MarketData;
}

export type KrakenMessage =
  | KrakenBookSnapshot
  | KrakenBookUpdate
  | KrakenSubscriptionStatus;
