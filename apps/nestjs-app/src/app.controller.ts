import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { AppService } from './app.service';
import { MarketManagerService } from './services/market-manager.service';
import { KrakenWebSocketService } from './services/kraken-websocket.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly marketManager: MarketManagerService,
    private readonly krakenService: KrakenWebSocketService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('status')
  getStatus() {
    return {
      krakenConnected: this.krakenService.isConnected(),
      subscribedSymbols: this.krakenService.getSubscribedSymbols(),
      subscriptionSummary: this.marketManager.getSubscriptionSummary(),
      connectedClients: this.marketManager.getConnectedClients(),
    };
  }

  @Get('markets')
  getAllMarkets() {
    return this.marketManager.getAllMarketData();
  }

  @Get('markets/:symbol')
  getMarket(@Param('symbol') symbol: string) {
    return this.marketManager.getMarketData(symbol);
  }

  @Post('test/subscribe/:symbol')
  testSubscribe(@Param('symbol') symbol: string) {
    const clientId = 'test-client';
    this.marketManager.subscribeClientToMarket(clientId, symbol);
    return { message: `Subscribed to ${symbol}` };
  }

  @Post('test/unsubscribe/:symbol')
  testUnsubscribe(@Param('symbol') symbol: string) {
    const clientId = 'test-client';
    this.marketManager.unsubscribeClientFromMarket(clientId, symbol);
    return { message: `Unsubscribed from ${symbol}` };
  }
}
