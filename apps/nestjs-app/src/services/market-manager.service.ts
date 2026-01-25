import { Injectable, Logger } from '@nestjs/common';
import { KrakenWebSocketService } from './kraken-websocket.service';
import { MarketData } from '../types/kraken.types';

@Injectable()
export class MarketManagerService {
  private readonly logger = new Logger(MarketManagerService.name);
  private readonly clientSubscriptions = new Map<string, Set<string>>(); // clientId -> Set<symbol>

  constructor(private readonly krakenService: KrakenWebSocketService) {}

  /**
   * Subscribe a client to a market
   */
  subscribeClientToMarket(clientId: string, symbol: string): void {
    this.logger.debug(`Client ${clientId} subscribing to ${symbol}`);

    // Track client subscription
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }

    const clientSymbols = this.clientSubscriptions.get(clientId)!;
    if (clientSymbols.has(symbol)) {
      this.logger.debug(`Client ${clientId} already subscribed to ${symbol}`);
      return;
    }

    clientSymbols.add(symbol);

    // Check if this is the first client for this market
    const totalClientsForMarket = this.getTotalClientsForMarket(symbol);
    if (totalClientsForMarket === 1) {
      // First client for this market, subscribe to Kraken
      this.logger.log(`First client for ${symbol}, subscribing to Kraken`);
      void this.krakenService.subscribeToMarket(symbol);
    } else {
      this.logger.debug(
        `Market ${symbol} already subscribed (${totalClientsForMarket} clients)`,
      );
    }
  }

  /**
   * Unsubscribe a client from a market
   */
  unsubscribeClientFromMarket(clientId: string, symbol: string): void {
    this.logger.debug(`Client ${clientId} unsubscribing from ${symbol}`);

    const clientSymbols = this.clientSubscriptions.get(clientId);
    if (!clientSymbols || !clientSymbols.has(symbol)) {
      this.logger.debug(`Client ${clientId} not subscribed to ${symbol}`);
      return;
    }

    clientSymbols.delete(symbol);

    // Check if this was the last client for this market
    const totalClientsForMarket = this.getTotalClientsForMarket(symbol);
    if (totalClientsForMarket === 0) {
      // Last client for this market, unsubscribe from Kraken
      this.logger.log(`Last client for ${symbol}, unsubscribing from Kraken`);
      void this.krakenService.unsubscribeToMarket(symbol);
    } else {
      this.logger.debug(
        `Market ${symbol} still has ${totalClientsForMarket} clients`,
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
   * Get market data
   */
  getMarketData(symbol: string): MarketData | undefined {
    return this.krakenService.getMarketData(symbol);
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
