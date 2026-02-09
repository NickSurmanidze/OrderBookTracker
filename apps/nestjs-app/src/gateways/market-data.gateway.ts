import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { KrakenWebSocketService } from '../services/kraken-websocket.service';
import { MarketManagerService } from '../services/market-manager.service';

interface MarketErrorData {
  symbol: string;
  error: string;
  type: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/market-data',
})
export class MarketDataGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketDataGateway.name);
  private broadcastInterval: NodeJS.Timeout | null = null;
  private noDataLoggedMarkets = new Set<string>(); // Track markets we've already logged as having no data

  constructor(
    private readonly krakenService: KrakenWebSocketService,
    private readonly marketManager: MarketManagerService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
    this.startBroadcasting();
    this.setupKrakenEventHandlers();
  }

  private setupKrakenEventHandlers() {
    // Listen for markets cleared event (e.g., due to rate limiting)
    this.krakenService.on('marketsCleared', () => {
      this.logger.warn(
        'Markets cleared by Kraken service, notifying all clients to refresh',
      );
      this.server.emit('marketsCleared', {
        message: 'Market data cleared, refreshing...',
        timestamp: new Date().toISOString(),
      });
    });

    // Listen for market errors (e.g., invalid symbols)
    this.krakenService.on('marketError', (errorData: MarketErrorData) => {
      this.logger.warn(
        `Market error for ${errorData.symbol}: ${errorData.error}`,
      );
      this.server.emit('marketError', {
        symbol: errorData.symbol,
        error: errorData.error,
        type: errorData.type,
        timestamp: new Date().toISOString(),
      });
    });
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Remove all client subscriptions from MarketManager
    this.marketManager.removeClient(client.id);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { markets: string[] },
  ) {
    if (!data.markets || !Array.isArray(data.markets)) {
      client.emit('error', {
        message: 'Invalid markets data. Expected array of market symbols.',
      });
      return;
    }

    // Normalize market symbols to uppercase
    const normalizedMarkets = data.markets.map((market) =>
      market.toUpperCase(),
    );

    this.logger.log(
      `Client ${client.id} subscribing to markets: ${normalizedMarkets.join(', ')}`,
    );

    // Get current subscriptions from MarketManager
    const currentSubscriptions = this.marketManager.getClientSubscriptions(
      client.id,
    );

    // Subscribe to new markets
    for (const market of normalizedMarkets) {
      if (!currentSubscriptions.includes(market)) {
        this.logger.log(`Adding market ${market} for client ${client.id}`);
        this.marketManager.subscribeClientToMarket(client.id, market);
      } else {
        this.logger.log(`Client ${client.id} already subscribed to ${market}`);
      }
    }

    // Get updated subscriptions after changes
    const updatedSubscriptions = this.marketManager.getClientSubscriptions(
      client.id,
    );

    this.logger.log(
      `Client ${client.id} now subscribed to: ${updatedSubscriptions.join(', ')}`,
    );

    client.emit('subscribed', {
      markets: updatedSubscriptions,
      message: `Subscribed to ${normalizedMarkets.length} markets`,
    });
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { markets: string[] },
  ) {
    if (!data.markets || !Array.isArray(data.markets)) {
      client.emit('error', {
        message: 'Invalid markets data. Expected array of market symbols.',
      });
      return;
    }

    // Normalize market symbols to uppercase
    const normalizedMarkets = data.markets.map((market) =>
      market.toUpperCase(),
    );

    this.logger.log(
      `Client ${client.id} unsubscribing from markets: ${normalizedMarkets.join(', ')}`,
    );

    // Unsubscribe from markets
    for (const market of normalizedMarkets) {
      this.marketManager.unsubscribeClientFromMarket(client.id, market);
    }

    // Get updated subscriptions after changes
    const updatedSubscriptions = this.marketManager.getClientSubscriptions(
      client.id,
    );

    client.emit('unsubscribed', {
      markets: updatedSubscriptions,
      message: `Unsubscribed from ${normalizedMarkets.length} markets`,
    });
  }

  @SubscribeMessage('getActiveMarkets')
  handleGetActiveMarkets(@ConnectedSocket() client: Socket) {
    const clientMarkets = this.marketManager.getClientSubscriptions(client.id);
    client.emit('activeMarkets', { markets: clientMarkets });
  }

  private startBroadcasting() {
    // Use environment variable or default to 500ms (balance between updates and performance)
    const broadcastIntervalMs = parseInt(
      process.env.BROADCAST_INTERVAL_MS || '500',
      10,
    );
    this.logger.log(
      `Starting market data broadcasting every ${broadcastIntervalMs}ms`,
    );
    this.broadcastInterval = setInterval(() => {
      this.broadcastMarketData();
    }, broadcastIntervalMs);
  }

  private broadcastMarketData() {
    const allMarketData = this.krakenService.getAllMarketData();

    // Get all unique markets that any client is subscribed to
    const subscribedMarkets = new Set<string>();
    const connectedClients = this.marketManager.getConnectedClients();

    for (const clientId of connectedClients) {
      const clientMarkets = this.marketManager.getClientSubscriptions(clientId);
      for (const market of clientMarkets) {
        subscribedMarkets.add(market);
      }
    }

    // NOTE: if we will have a bottleneck here, we can make updates less frequent, or scale horizontally
    // Broadcast data for each subscribed market
    for (const market of subscribedMarkets) {
      const marketData = allMarketData[market];

      if (
        marketData &&
        marketData.orderbook.asks.length > 0 &&
        marketData.orderbook.bids.length > 0
      ) {
        const simplifiedData = {
          symbol: market, // Already in uppercase
          timestamp: new Date().toISOString(),
          lastOrderbookUpdate: marketData.orderbook.lastUpdate, // When orderbook was last updated
          asks: marketData.orderbook.asks
            .sort((a, b) => a.price.comparedTo(b.price)) // Sort asks by price ascending (lowest first)
            .slice(0, 3) // Show top 3 ask levels
            .map((ask) => ({
              price: ask.price.toString(),
              volume: ask.quantity.toString(),
            })),
          bids: marketData.orderbook.bids
            .sort((a, b) => b.price.comparedTo(a.price)) // Sort bids by price descending (highest first)
            .slice(0, 3) // Show top 3 bid levels
            .map((bid) => ({
              price: bid.price.toString(),
              volume: bid.quantity.toString(),
            })),
          spread: marketData.orderbook.spread,
          midPrice: marketData.orderbook.midPrice,
          orderbookSpeed: marketData.orderbooksPerMinute,
        };

        // Send to all clients subscribed to this market
        let sentCount = 0;
        for (const clientId of connectedClients) {
          const clientMarkets =
            this.marketManager.getClientSubscriptions(clientId);
          if (clientMarkets.includes(market)) {
            this.server.to(clientId).emit('market-data', simplifiedData);
            sentCount++;
          }
        }

        if (sentCount === 0) {
          this.logger.warn(
            `Market ${market} has data but no clients subscribed`,
          );
        }

        // Clear the no-data flag since we now have data
        this.noDataLoggedMarkets.delete(market);
      } else {
        // Only log once when data first becomes unavailable
        if (!this.noDataLoggedMarkets.has(market)) {
          this.logger.debug(`Init market data for ${market}`);
          this.noDataLoggedMarkets.add(market);
        }
      }
    }
  }

  onModuleDestroy() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }
  }
}
