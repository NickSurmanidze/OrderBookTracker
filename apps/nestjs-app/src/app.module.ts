import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { KrakenWebSocketService } from './services/kraken-websocket.service';
import { MetricsService } from './services/metrics.service';
import { MarketManagerService } from './services/market-manager.service';
import { MarketDataGateway } from './gateways/market-data.gateway';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    MetricsService,
    KrakenWebSocketService,
    MarketManagerService,
    MarketDataGateway,
  ],
})
export class AppModule {}
