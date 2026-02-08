import { Controller, Get, Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { MarketManagerService } from './services/market-manager.service';
import { KrakenWebSocketService } from './services/kraken-websocket.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

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
      instrumentDataReady: this.krakenService.isInstrumentDataReady(),
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
  // Populated from the instrument WS channel (no REST API call needed)
  @Get('available-markets')
  getAvailableMarkets() {
    const markets = this.krakenService.getAvailableMarkets();
    return {
      markets,
      count: markets.length,
    };
  }

  // Get the precision data for rounding purposes so we don't display excessive decimals in the front-end
  // Populated from the instrument WS channel (no REST API call needed)
  @Get('all-market-precision')
  getAllMarketPrecision() {
    return this.krakenService.getMarketPrecisions();
  }
}
