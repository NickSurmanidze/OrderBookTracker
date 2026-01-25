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

interface MarketDataMessage {
  market: string;
  timestamp: string;
  asks: Array<{ price: number; quantity: number }>;
  bids: Array<{ price: number; quantity: number }>;
  spread: string;
  midPrice: string;
}

@WebSocketGateway({
  cors: {
    origin: 'http://localhost:3000',
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
  private clientSubscriptions = new Map<string, Set<string>>(); // socketId -> Set<markets>
  private broadcastInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly krakenService: KrakenWebSocketService,
    private readonly marketManager: MarketManagerService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
    this.startBroadcasting();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSubscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Get client's markets and unsubscribe from each
    const clientMarkets = this.clientSubscriptions.get(client.id);
    if (clientMarkets) {
      for (const market of clientMarkets) {
        this.marketManager.unsubscribeClientFromMarket(client.id, market);
      }
    }

    this.clientSubscriptions.delete(client.id);
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

    // Normalize market symbols to lowercase
    const normalizedMarkets = data.markets.map((market) =>
      market.toLowerCase(),
    );

    this.logger.log(
      `Client ${client.id} subscribing to markets: ${normalizedMarkets.join(', ')}`,
    );

    const clientMarkets = this.clientSubscriptions.get(client.id) || new Set();

    // Subscribe to new markets
    for (const market of normalizedMarkets) {
      if (!clientMarkets.has(market)) {
        clientMarkets.add(market);
        this.marketManager.subscribeClientToMarket(client.id, market);
      }
    }

    this.clientSubscriptions.set(client.id, clientMarkets);

    client.emit('subscribed', {
      markets: Array.from(clientMarkets),
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

    // Normalize market symbols to lowercase
    const normalizedMarkets = data.markets.map((market) =>
      market.toLowerCase(),
    );

    this.logger.log(
      `Client ${client.id} unsubscribing from markets: ${normalizedMarkets.join(', ')}`,
    );

    const clientMarkets = this.clientSubscriptions.get(client.id) || new Set();

    // Unsubscribe from markets
    for (const market of normalizedMarkets) {
      if (clientMarkets.has(market)) {
        clientMarkets.delete(market);
        this.marketManager.unsubscribeClientFromMarket(client.id, market);
      }
    }

    this.clientSubscriptions.set(client.id, clientMarkets);

    client.emit('unsubscribed', {
      markets: Array.from(clientMarkets),
      message: `Unsubscribed from ${normalizedMarkets.length} markets`,
    });
  }

  @SubscribeMessage('getActiveMarkets')
  handleGetActiveMarkets(@ConnectedSocket() client: Socket) {
    const clientMarkets = this.clientSubscriptions.get(client.id) || new Set();
    client.emit('activeMarkets', { markets: Array.from(clientMarkets) });
  }

  private startBroadcasting() {
    this.broadcastInterval = setInterval(() => {
      this.broadcastMarketData();
    }, 1000); // Broadcast every second
  }

  private broadcastMarketData() {
    const allMarketData = this.krakenService.getAllMarketData();

    // Get all unique markets that any client is subscribed to
    const subscribedMarkets = new Set<string>();
    for (const clientMarkets of this.clientSubscriptions.values()) {
      for (const market of clientMarkets) {
        subscribedMarkets.add(market);
      }
    }

    // Broadcast data for each subscribed market
    for (const market of subscribedMarkets) {
      const marketData = allMarketData[market];
      if (
        marketData &&
        marketData.orderbook.asks.length > 0 &&
        marketData.orderbook.bids.length > 0
      ) {
        const simplifiedData: MarketDataMessage = {
          market: market.toUpperCase(), // Send back in uppercase for display
          timestamp: new Date().toISOString(),
          asks: marketData.orderbook.asks.slice(0, 2), // Top 2 asks closest to mid price
          bids: marketData.orderbook.bids.slice(0, 2), // Top 2 bids closest to mid price
          spread: marketData.orderbook.spread,
          midPrice: marketData.orderbook.midPrice,
        };

        // Send to all clients subscribed to this market
        for (const [
          clientId,
          clientMarkets,
        ] of this.clientSubscriptions.entries()) {
          if (clientMarkets.has(market)) {
            this.server.to(clientId).emit('marketUpdate', simplifiedData);
          }
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
