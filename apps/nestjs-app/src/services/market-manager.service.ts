import { Injectable, Logger } from '@nestjs/common';
import { KrakenWebSocketService } from './kraken-websocket.service';
import { MarketData } from '../types/kraken.types';

// This service keeps track of subscribed clients (vue apps) and their market subscriptions
// It manages subscribing/unsubscribing to Kraken markets based on active clients
@Injectable()
export class MarketManagerService {
  private readonly logger = new Logger(MarketManagerService.name);
  private readonly clientSubscriptions = new Map<string, Set<string>>(); // clientId -> Set<symbol>

  constructor(private readonly krakenService: KrakenWebSocketService) {
    // Set up callback to help KrakenWebSocketService avoid unnecessary re-connections
    this.krakenService.setMarketTrackedCallback((symbol: string) => {
      return this.isMarketActivelyTracked(symbol);
    });
  }

  /**
   * Subscribe a client to a market
   */
  subscribeClientToMarket(clientId: string, symbol: string): void {
    this.logger.debug(`Client ${clientId} subscribing to ${symbol}`);

    // Normalize symbol for client tracking (uppercase)
    const normalizedSymbol = symbol.toUpperCase();

    // Track client subscription using normalized symbol
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }

    const clientSymbols = this.clientSubscriptions.get(clientId)!;
    if (clientSymbols.has(normalizedSymbol)) {
      this.logger.debug(
        `Client ${clientId} already subscribed to ${normalizedSymbol}`,
      );
      return;
    }

    clientSymbols.add(normalizedSymbol);

    // Check if this is the first client for this market
    const totalClientsForMarket =
      this.getTotalClientsForMarket(normalizedSymbol);
    if (totalClientsForMarket === 1) {
      // First client for this market, subscribe to Kraken using proper format
      const krakenSymbol = symbol.toUpperCase().includes('/')
        ? symbol.toUpperCase()
        : symbol.toUpperCase();
      this.logger.log(
        `First client for ${normalizedSymbol}, subscribing to Kraken as ${krakenSymbol}`,
      );
      void this.krakenService.subscribeToMarket(krakenSymbol);
    } else {
      this.logger.debug(
        `Market ${normalizedSymbol} already subscribed (${totalClientsForMarket} clients)`,
      );
    }
  }

  /**
   * Unsubscribe a client from a market
   */
  unsubscribeClientFromMarket(clientId: string, symbol: string): void {
    this.logger.debug(`Client ${clientId} unsubscribing from ${symbol}`);

    // Normalize symbol for consistent tracking
    const normalizedSymbol = symbol.toUpperCase();

    const clientSymbols = this.clientSubscriptions.get(clientId);
    if (!clientSymbols || !clientSymbols.has(normalizedSymbol)) {
      this.logger.debug(
        `Client ${clientId} not subscribed to ${normalizedSymbol}`,
      );
      return;
    }

    clientSymbols.delete(normalizedSymbol);

    // Check if this was the last client for this market
    const totalClientsForMarket =
      this.getTotalClientsForMarket(normalizedSymbol);
    if (totalClientsForMarket === 0) {
      // Last client for this market, unsubscribe from Kraken using proper format
      const krakenSymbol = symbol.toUpperCase().includes('/')
        ? symbol.toUpperCase()
        : symbol.toUpperCase();
      this.logger.log(
        `Last client for ${normalizedSymbol}, unsubscribing from Kraken as ${krakenSymbol}`,
      );
      void this.krakenService.unsubscribeFromMarket(krakenSymbol);
    } else {
      this.logger.debug(
        `Market ${normalizedSymbol} still has ${totalClientsForMarket} clients`,
      );
    }
  }

  /**
   * Remove all subscriptions for a client (e.g., when client disconnects)
   */
  removeClient(clientId: string): void {
    this.logger.log(`Removing all subscriptions for client ${clientId}`);

    const clientSymbols = this.clientSubscriptions.get(clientId);
    if (!clientSymbols) {
      return;
    }

    // Unsubscribe from all markets for this client
    for (const symbol of clientSymbols) {
      this.unsubscribeClientFromMarket(clientId, symbol);
    }

    this.clientSubscriptions.delete(clientId);
  }

  /**
   * Get all symbols a client is subscribed to
   */
  getClientSubscriptions(clientId: string): string[] {
    const clientSymbols = this.clientSubscriptions.get(clientId);
    return clientSymbols ? Array.from(clientSymbols) : [];
  }

  /**
   * Get total number of clients subscribed to a market
   */
  private getTotalClientsForMarket(symbol: string): number {
    let count = 0;
    for (const clientSymbols of this.clientSubscriptions.values()) {
      if (clientSymbols.has(symbol)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a market is actively being tracked by any clients
   */
  isMarketActivelyTracked(symbol: string): boolean {
    const normalizedSymbol = symbol.toUpperCase();
    return this.getTotalClientsForMarket(normalizedSymbol) > 0;
  }

  /**
   * Get market data
   */
  getMarketData(symbol: string): MarketData | undefined {
    // Normalize symbol to match internal storage
    const normalizedSymbol = symbol.toUpperCase();
    return this.krakenService.getMarketData(normalizedSymbol);
  }

  /**
   * Get all market data
   */
  getAllMarketData(): { [symbol: string]: MarketData } {
    return this.krakenService.getAllMarketData();
  }

  /**
   * Get all connected clients
   */
  getConnectedClients(): string[] {
    return Array.from(this.clientSubscriptions.keys());
  }

  /**
   * Get subscription summary
   */
  getSubscriptionSummary(): { [symbol: string]: number } {
    const summary: { [symbol: string]: number } = {};

    for (const clientSymbols of this.clientSubscriptions.values()) {
      for (const symbol of clientSymbols) {
        summary[symbol] = (summary[symbol] || 0) + 1;
      }
    }

    return summary;
  }
}
