import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { MetricsService } from './metrics.service';
import {
  KrakenMessage,
  KrakenBookSnapshot,
  KrakenBookUpdate,
  KrakenSubscriptionMessage,
  KrakenSubscriptionStatus,
  OrderBook,
  OrderBookEntry,
  MarketData,
} from '../types/kraken.types';

@Injectable()
export class KrakenWebSocketService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KrakenWebSocketService.name);
  private ws: WebSocket | null = null;
  private readonly KRAKEN_WS_URL = 'wss://ws.kraken.com/v2';
  private readonly subscribedSymbols = new Set<string>();
  private reqIdCounter = 1;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;
  private storeLoggingInterval: NodeJS.Timeout | null = null;

  // In-memory store for caching market data
  private inMemoryStore: { [symbol: string]: MarketData } = {};

  constructor(private readonly metricsService: MetricsService) {
    super();
  }

  onModuleInit() {
    this.logger.log('Initializing Kraken WebSocket connection...');
    this.connect();
    this.startPeriodicLogging();
  }

  onModuleDestroy() {
    this.logger.log('Destroying Kraken WebSocket connection...');
    this.disconnect();
    this.stopPeriodicLogging();
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.KRAKEN_WS_URL);

      if (!this.ws) {
        throw new Error('Failed to create WebSocket instance');
      }

      this.ws.on('open', () => {
        this.logger.log('Connected to Kraken WebSocket');
        this.reconnectAttempts = 0;
        this.emit('connected');

        // Auto-subscribe to BTC order book for testing
        setTimeout(() => {
          this.logger.log('Auto-subscribing to BTC/USD for testing...');
          this.subscribeToMarket('BTC/USD'); // Use uppercase for Kraken API
        }, 1000);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as KrakenMessage;
          this.handleKrakenMessage(message);
        } catch (error) {
          this.logger.error(
            `Failed to parse Kraken message: ${error instanceof Error ? error.message : 'Unknown error'}`,
            data.toString(),
          );
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.logger.warn(
          `Kraken WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`,
        );
        this.ws = null;
        this.emit('disconnected', code, reason.toString());

        // WebSocket closed, will reconnect automatically
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.logger.error(`Kraken WebSocket error: ${error.message}`);
        this.emit('error', error);
      });
    } catch (error) {
      this.logger.error(
        `Failed to connect to Kraken WebSocket: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.scheduleReconnect();
    }
  }

  private disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.emit('disconnected', 1000, 'Manual disconnect');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
      );
      return;
    }

    this.reconnectAttempts++;
    setTimeout(() => {
      this.logger.log(
        `Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`,
      );
      this.connect();
    }, this.RECONNECT_DELAY);
  }

  /**
   * Start logging the in-memory store every 5 seconds
   */
  private startPeriodicLogging(): void {
    this.storeLoggingInterval = setInterval(() => {
      this.logger.log(`📊 Current In-Memory Store:`);
      console.log(JSON.stringify(this.inMemoryStore, null, 2));
    }, 5000);
  }

  /**
   * Stop the periodic store logging
   */
  private stopPeriodicLogging(): void {
    if (this.storeLoggingInterval) {
      clearInterval(this.storeLoggingInterval);
      this.storeLoggingInterval = null;
    }
  }

  private handleKrakenMessage(message: any): void {
    // Process message without logging individual events

    // Handle error responses
    if ('error' in message) {
      const errorMessage = message as { error: string; symbol?: string };
      this.logger.error(
        `Kraken API error: ${errorMessage.error} for ${errorMessage.symbol || 'unknown symbol'}`,
      );
      return;
    }

    // Handle subscription status responses
    if ('method' in message && 'success' in message) {
      this.handleSubscriptionStatus(message as KrakenSubscriptionStatus);
      return;
    }

    // Handle book data
    if ('channel' in message) {
      const bookMessage = message as { channel: string; type?: string };
      if (bookMessage.channel === 'book') {
        if (bookMessage.type === 'snapshot') {
          this.handleBookSnapshot(message as KrakenBookSnapshot);
        } else if (bookMessage.type === 'update') {
          this.handleBookUpdate(message as KrakenBookUpdate);
        }
      }
    }
  }

  private handleBookSnapshot(message: KrakenBookSnapshot): void {
    const data = message.data[0];
    const symbol = data.symbol;

    this.logger.debug(`Received book snapshot for ${symbol}`);
    this.metricsService.incrementOrderBookCount(symbol);

    const bids = this.parseOrderBookEntries(data.bids);
    const asks = this.parseOrderBookEntries(data.asks);

    // Calculate spread and mid-price
    const bestBid = Math.max(...bids.map((b) => b.price));
    const bestAsk = Math.min(...asks.map((a) => a.price));
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    // Update in-memory store
    this.inMemoryStore[symbol.toLowerCase()] = {
      orderbooksPerMinute: this.metricsService.getOrderBooksPerMinute(symbol),
      orderbook: {
        spread: spread.toFixed(2),
        midPrice: midPrice.toFixed(2),
        asks: asks.sort((a, b) => a.price - b.price),
        bids: bids.sort((a, b) => b.price - a.price),
        lastUpdate: new Date().toISOString(),
      },
      subscriptionStatus: 'subscribed',
    };

    this.emit('marketUpdate', symbol);
  }

  private handleBookUpdate(message: KrakenBookUpdate): void {
    const data = message.data[0];
    const symbol = data.symbol;

    this.metricsService.incrementOrderBookCount(symbol);

    const marketData = this.inMemoryStore[symbol.toLowerCase()];
    if (!marketData) {
      this.logger.warn(
        `Received update for uninitialized market ${symbol}. This should not happen.`,
      );
      return;
    }

    // Update bids and asks with delta changes
    if (data.bids) {
      const bidDeltas = this.parseOrderBookEntries(data.bids);
      this.applyBookDeltas(marketData.orderbook.bids, bidDeltas);
    }
    if (data.asks) {
      const askDeltas = this.parseOrderBookEntries(data.asks);
      this.applyBookDeltas(marketData.orderbook.asks, askDeltas);
    }

    // Recalculate spread and mid-price
    if (
      marketData.orderbook.bids.length > 0 &&
      marketData.orderbook.asks.length > 0
    ) {
      const bestBid = Math.max(
        ...marketData.orderbook.bids.map((b) => b.price),
      );
      const bestAsk = Math.min(
        ...marketData.orderbook.asks.map((a) => a.price),
      );
      const spread = bestAsk - bestBid;
      const midPrice = (bestBid + bestAsk) / 2;

      marketData.orderbook.spread = spread.toFixed(2);
      marketData.orderbook.midPrice = midPrice.toFixed(2);
      marketData.orderbook.lastUpdate = new Date().toISOString();

      // Update metrics
      marketData.orderbooksPerMinute =
        this.metricsService.getOrderBooksPerMinute(symbol);
    }

    this.emit('marketUpdate', symbol);
  }

  private handleSubscriptionStatus(message: KrakenSubscriptionStatus): void {
    const status = message.success ? 'SUCCESS' : 'FAILED';
    const symbol = message.result?.symbol || 'unknown';
    this.logger.log(
      `Subscription status: ${message.method} ${symbol} - ${status}`,
    );

    if (
      message.success &&
      message.method === 'subscribe' &&
      symbol !== 'unknown'
    ) {
      this.subscribedSymbols.add(symbol.toLowerCase());
    } else if (
      message.success &&
      message.method === 'unsubscribe' &&
      symbol !== 'unknown'
    ) {
      this.subscribedSymbols.delete(symbol.toLowerCase());
    }
  }

  private parseOrderBookEntries(entries: any[]): OrderBookEntry[] {
    if (!entries || entries.length === 0) {
      return [];
    }

    // Handle both array format [price, qty] and object format {price, qty}
    return entries.map((entry) => {
      if (Array.isArray(entry)) {
        // Old format: [price, qty]
        const [price, qty] = entry as [string, string];
        return {
          price: parseFloat(String(price)),
          quantity: parseFloat(String(qty)),
        };
      } else {
        // New format: {price, qty}
        const entryObj = entry as { price: string; qty: string };
        return {
          price: parseFloat(String(entryObj.price)),
          quantity: parseFloat(String(entryObj.qty)),
        };
      }
    });
  }

  private applyBookDeltas(
    currentEntries: OrderBookEntry[],
    deltas: OrderBookEntry[],
  ): void {
    for (const delta of deltas) {
      const existingIndex = currentEntries.findIndex(
        (entry) => entry.price === delta.price,
      );

      if (delta.quantity === 0) {
        // Remove entry
        if (existingIndex !== -1) {
          currentEntries.splice(existingIndex, 1);
        }
      } else if (existingIndex !== -1) {
        // Update existing entry
        currentEntries[existingIndex].quantity = delta.quantity;
      } else {
        // Add new entry
        currentEntries.push(delta);
      }
    }
  }

  private validateOrderBook(orderBook: OrderBook): boolean {
    if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      return false;
    }

    const bestBid = Math.max(...orderBook.bids.map((b) => b.price));
    const bestAsk = Math.min(...orderBook.asks.map((a) => a.price));

    return bestBid < bestAsk;
  }

  private resyncMarket(symbol: string): void {
    this.logger.log(`Resyncing market: ${symbol}`);

    // Mark market as resyncing
    if (this.inMemoryStore[symbol.toLowerCase()]) {
      this.inMemoryStore[symbol.toLowerCase()].subscriptionStatus = 'resyncing';
    }

    // Re-establish subscription
    this.unsubscribeToMarket(symbol);
    this.subscribeToMarket(symbol);
  }

  /**
   * Subscribe to a market
   */
  subscribeToMarket(symbol: string): void {
    // Normalize symbol to lowercase for consistent storage
    const normalizedSymbol = symbol.toLowerCase();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket not connected. Cannot subscribe to market.');
      return;
    }

    if (this.subscribedSymbols.has(normalizedSymbol)) {
      this.logger.debug(`Already subscribed to ${normalizedSymbol}`);
      return;
    }

    const subscriptionMessage: KrakenSubscriptionMessage = {
      method: 'subscribe',
      params: {
        channel: 'book',
        symbol: [symbol], // Send original symbol to Kraken API
        depth: 25, // Get top 25 levels
      },
      req_id: this.reqIdCounter++,
    };

    this.logger.log(
      `Subscribing to market: ${symbol} (stored as ${normalizedSymbol})`,
    );
    this.ws.send(JSON.stringify(subscriptionMessage));

    // Initialize in-memory store for this market with normalized key
    if (!this.inMemoryStore[normalizedSymbol]) {
      this.inMemoryStore[normalizedSymbol] = {
        orderbooksPerMinute: 0,
        orderbook: {
          spread: '',
          midPrice: '',
          asks: [],
          bids: [],
          lastUpdate: '',
        },
        subscriptionStatus: 'subscribing',
      };
    }
  }

  /**
   * Unsubscribe from a market
   */
  unsubscribeToMarket(symbol: string): void {
    // Normalize symbol to lowercase for consistent storage
    const normalizedSymbol = symbol.toLowerCase();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error(
        'WebSocket not connected. Cannot unsubscribe from market.',
      );
      return;
    }

    if (!this.subscribedSymbols.has(normalizedSymbol)) {
      this.logger.debug(`Not subscribed to ${normalizedSymbol}`);
      return;
    }

    const unsubscriptionMessage: KrakenSubscriptionMessage = {
      method: 'unsubscribe',
      params: {
        channel: 'book',
        symbol: [symbol], // Send original symbol to Kraken API
      },
      req_id: this.reqIdCounter++,
    };

    this.logger.log(
      `Unsubscribing from market: ${symbol} (stored as ${normalizedSymbol})`,
    );
    this.ws.send(JSON.stringify(unsubscriptionMessage));

    // Update subscription status using normalized key
    if (this.inMemoryStore[normalizedSymbol]) {
      this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'unsubscribed';
    }
  }

  /**
   * Get market data for a specific symbol
   */
  getMarketData(symbol: string): MarketData | undefined {
    return this.inMemoryStore[symbol.toLowerCase()];
  }

  /**
   * Get all market data
   */
  getAllMarketData(): { [symbol: string]: MarketData } {
    return this.inMemoryStore;
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get list of subscribed symbols
   */
  getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }
}
