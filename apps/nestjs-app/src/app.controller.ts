import { Controller, Get, Body, Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { MarketManagerService } from './services/market-manager.service';
import { KrakenWebSocketService } from './services/kraken-websocket.service';

interface KrakenAssetPairInfo {
  status: string;
  wsname?: string;
  pair_decimals?: number;
  lot_decimals?: number;
}

interface KrakenApiResponse {
  error: string[];
  result: Record<string, KrakenAssetPairInfo>;
}

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  private cachedMarkets: string[] | null = null;
  private cachedPrecisionData: Record<
    string,
    { price: number; volume: number }
  > | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly appService: AppService,
    private readonly marketManager: MarketManagerService,
    private readonly krakenService: KrakenWebSocketService,
  ) {}

  // Leaving default endpoint for basic health check
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Endpoint to check the connected clients and which symbols are listened to
  // For debugging purposes
  @Get('status')
  getStatus() {
    return {
      krakenConnected: this.krakenService.isConnected(),
      subscribedSymbols: this.krakenService.getSubscribedSymbols(),
      subscriptionSummary: this.marketManager.getSubscriptionSummary(),
      connectedClients: this.marketManager.getConnectedClients(),
      totalMarkets: Object.keys(this.krakenService.getAllMarketData()).length,
      workingMarkets: Object.values(
        this.krakenService.getAllMarketData(),
      ).filter((m) => m.subscriptionStatus === 'subscribed').length,
      failedMarkets: Object.values(
        this.krakenService.getAllMarketData(),
      ).filter((m) => m.subscriptionStatus === 'error').length,
    };
  }

  // Also for debugging purposes to see what the latest cache includes and check the shape of it
  @Get('markets')
  getAllMarkets() {
    return this.marketManager.getAllMarketData();
  }

  // Return symbols supported by Kraken WebSocket API
  // So we can display a dropdown in the front-end
  // NOTE: WARNING: The "https://api.kraken.com/0/public/AssetPairs" endpoint is not returning all possible pairs!
  // e.g. BTC and ETH are missing. Don't know particularities of this exchange, might need to dig deeper later.
  // For now I added some common aliases manually in the code below.
  // And maybe - we should allow just adding a pair even if not in this list via text input?
  @Get('available-markets')
  async getAvailableMarkets() {
    await this.getCachedSupportedMarketsData();

    return {
      markets: this.cachedMarkets!,
      count: this.cachedMarkets!.length,
      cached: true,
    };
  }

  /**
   * Refresh cache if it's missing or expired
   */
  private async getCachedSupportedMarketsData(): Promise<void> {
    // Check if we have valid cached data
    const now = Date.now();
    if (
      this.cachedMarkets &&
      this.cachedPrecisionData &&
      now - this.cacheTimestamp < this.CACHE_DURATION
    ) {
      return; // Cache is still valid
    }

    this.logger.log('Refreshing markets and precision cache...');

    const response = await fetch('https://api.kraken.com/0/public/AssetPairs');
    const data = (await response.json()) as KrakenApiResponse;

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }

    const assetPairs = data.result;
    const markets: string[] = [];
    const precisionData: Record<string, { price: number; volume: number }> = {};

    // Get all online trading pairs
    for (const [pairKey, pairInfo] of Object.entries(assetPairs)) {
      // Skip if pair is not tradeable
      if (pairInfo.status !== 'online') continue;

      // Use WebSocket name if available, otherwise use the pair key
      const wsname = pairInfo.wsname || pairKey;
      if (wsname && typeof wsname === 'string') {
        // Normalize format: ensure it has a slash separator
        const normalizedName = wsname.includes('/')
          ? wsname
          : wsname.replace(/([A-Z]{3,4})([A-Z]{3,4})/, '$1/$2');
        markets.push(normalizedName);

        // Store precision data (default to 8 if not available)
        precisionData[normalizedName.toUpperCase()] = {
          price: pairInfo.pair_decimals || 8,
          volume: pairInfo.lot_decimals || 8,
        };
      }
    }

    // Add commonly used aliases that might be missing
    const commonAliases = ['BTC/USD', 'ETH/USD', 'BTC/EUR', 'ETH/EUR'];
    for (const alias of commonAliases) {
      if (!markets.includes(alias)) {
        // Check if the XBT equivalent exists
        const xbtEquivalent = alias.replace('BTC/', 'XBT/');
        if (markets.includes(xbtEquivalent)) {
          markets.push(alias);
          // Copy precision data from XBT equivalent
          precisionData[alias.toUpperCase()] = precisionData[
            xbtEquivalent.toUpperCase()
          ] || { price: 8, volume: 8 };
        }
      }
    }

    // Cache the results
    this.cachedMarkets = markets.sort();
    this.cachedPrecisionData = precisionData;
    this.cacheTimestamp = now;

    this.logger.log(`Cache refreshed with ${markets.length} markets`);
  }

  // Get the precision data for rounding purposes so we don't display excessive decimals in the front-end with no reason
  @Get('all-market-precision')
  async getAllMarketPrecision() {
    await this.getCachedSupportedMarketsData();
    return this.cachedPrecisionData || {};
  }
}
