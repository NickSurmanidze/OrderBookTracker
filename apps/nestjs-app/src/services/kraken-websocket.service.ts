import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crc32 from 'buffer-crc32';
import JSONbig from 'json-bigint';
import { Decimal } from 'decimal.js';
import { MetricsService } from './metrics.service';
import {
  KrakenMessage,
  KrakenBookSnapshot,
  KrakenBookUpdate,
  KrakenSubscriptionMessage,
  KrakenSubscriptionStatus,
  KrakenInstrumentPair,
} from '../schemas/kraken.schema';
import { OrderBookEntry, MarketData } from '../types/types';
import { KrakenWebSocketMessageSchema } from '../schemas/kraken.schema';

interface QueuedMessage {
  type: 'snapshot' | 'update';
  symbol: string;
  data: {
    symbol: string;
    bids?: any[];
    asks?: any[];
    checksum?: number;
    timestamp?: string; // Kraken's ISO timestamp
  };
  timestamp: number; // Our enqueueing timestamp
  rawJson?: string; // Raw JSON string to extract exact numeric representations
}

// This service ensures kraken ws connection, orderbook parsing and local caching
// To ensure stability during the bursts of events - I use queues per symbol for ordered processing
// and based on the logs - we can see if the queue is getting clogged and we need to scale number of workers to process data
@Injectable()
export class KrakenWebSocketService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KrakenWebSocketService.name);
  private ws: WebSocket | null = null;
  // Usually I would not hardcode URLs, but this is a stable Kraken endpoint and this is not a prod app
  private readonly KRAKEN_WS_URL = 'wss://ws.kraken.com/v2';
  // All the unique pairs we track here (based on at least 1 client subscribed)
  private readonly subscribedSymbols = new Set<string>();

  // We use unique reqId for all messages sent over WS so we can know which answer is to which message
  private reqIdCounter = 1;

  private reconnectAttempts = 0;
  private rateLimitAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;
  private isConnecting = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  // Track symbols that Kraken rejected
  private invalidSymbols = new Set<string>();
  // Callback to check if a market is actively tracked by clients
  private isMarketTrackedCallback: ((symbol: string) => boolean) | null = null;
  private pendingRequests = new Map<
    number,
    { type: 'subscribe' | 'unsubscribe'; symbol: string }
  >(); // Track request context
  private queueMonitoringInterval: NodeJS.Timeout | null = null;

  // In-memory store for caching market data
  private inMemoryStore: { [symbol: string]: MarketData } = {};

  // Instrument channel cache: available pairs and their precisions from Kraken WS
  private instrumentPairs: KrakenInstrumentPair[] = [];
  private cachedAvailableMarkets: string[] = [];
  private cachedMarketPrecisions: Record<
    string,
    { price: number; volume: number }
  > = {};
  private instrumentDataReady = false;

  // Queue system for ordered message processing
  private symbolQueues = new Map<string, QueuedMessage[]>();
  private processingQueues = new Set<string>();
  private resyncingSymbols = new Set<string>(); // Track symbols currently resyncing
  private validationTimers = new Map<string, NodeJS.Timeout>(); // Debounced validation timers
  private readonly MAX_QUEUE_SIZE = 1000; // Prevent memory issues
  private readonly VALIDATION_DELAY_MS = 100; // Wait 100ms before validating to allow batched updates

  constructor(private readonly metricsService: MetricsService) {
    super();
  }

  /**
   * Set callback to check if a market is actively tracked by clients
   * This helps avoid reconnections for recently unsubscribed symbols
   */
  setMarketTrackedCallback(callback: (symbol: string) => boolean): void {
    this.isMarketTrackedCallback = callback;
  }

  onModuleInit() {
    this.logger.log('Initializing Kraken WebSocket connection...');
    this.connect();
    this.startQueueMonitoring();
  }

  onModuleDestroy() {
    this.logger.log('Destroying Kraken WebSocket connection...');
    this.disconnect();
    this.stopQueueMonitoring();
  }

  private connect(): void {
    if (this.isConnecting) {
      this.logger.warn('Already connecting to Kraken WebSocket, skipping...');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.warn('Already connected to Kraken WebSocket, skipping...');
      return;
    }

    this.isConnecting = true;
    this.logger.log('Attempting to connect to Kraken WebSocket...');

    try {
      this.ws = new WebSocket(this.KRAKEN_WS_URL);

      if (!this.ws) {
        throw new Error('Failed to create WS instance');
      }

      this.ws.on('open', () => {
        this.logger.log('Connected to Kraken WebSocket');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        // Reset rate limit attempts only after successful connection and some time
        if (this.rateLimitAttempts > 0) {
          this.logger.log(
            'Resetting rate limit attempts after successful connection',
          );
          setTimeout(() => {
            this.rateLimitAttempts = 0;
          }, 30000); // Reset after 30 seconds of stable connection
        }
        this.emit('connected');

        // Subscribe to instrument channel to get available pairs and precisions
        this.subscribeToInstrumentChannel();
        // Auto-subscribe to markets after connection
        setTimeout(() => {
          const existingMarkets = Object.keys(this.inMemoryStore);

          if (existingMarkets.length > 0) {
            this.logger.log(
              `Re-subscribing to ${existingMarkets.length} existing markets: ${existingMarkets.join(', ')}`,
            );

            // Re-subscribe to all existing markets
            existingMarkets.forEach((normalizedSymbol) => {
              // Only resubscribe if this market is still actively tracked
              if (
                this.isMarketTrackedCallback &&
                !this.isMarketTrackedCallback(normalizedSymbol)
              ) {
                this.logger.debug(
                  `Skipping re-subscription to ${normalizedSymbol} - no longer tracked by clients`,
                );
                // Clean up data for markets that are no longer tracked
                delete this.inMemoryStore[normalizedSymbol];
                return;
              }

              this.logger.log(`Re-subscribing to ${normalizedSymbol}`);

              // Reset subscription status to subscribing
              this.inMemoryStore[normalizedSymbol].subscriptionStatus =
                'subscribing';

              // Re-subscribe to the market
              this.subscribeToMarket(normalizedSymbol);
            });
          }
        }, 1000);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const rawJson = data.toString();

          // Log raw JSON for snapshot messages to debug checksum
          // if (rawJson.includes('snapshot') && rawJson.includes('checksum')) {
          //   const sample =
          //     rawJson.length > 600
          //       ? rawJson.substring(0, 600) + '...'
          //       : rawJson;
          //   this.logger.debug(`Raw WebSocket message: ${sample}`);
          // }

          // Use json-bigint with storeAsString to preserve exact numeric representation
          // This keeps trailing zeros like "90087.0" instead of converting to 90087
          // we need to preserve this data to compute the checksum
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
          const JSONParser = JSONbig({ storeAsString: true }) as any;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          const parsedData = JSONParser.parse(rawJson) as unknown;

          // Validate with Zod schema
          const parseResult =
            KrakenWebSocketMessageSchema.safeParse(parsedData);
          if (!parseResult.success) {
            this.logger.error(
              'Failed to validate Kraken message schema',
              JSON.stringify(parseResult.error.format(), null, 2),
              rawJson.substring(0, 500),
            );
            return;
          }

          const message = parseResult.data as KrakenMessage;
          this.handleKrakenMessage(message, rawJson);
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
        // Don't emit error event to prevent crashing - handle gracefully
        this.handleWebSocketError(error);
      });
    } catch (error) {
      this.isConnecting = false;
      this.logger.error(
        `Failed to connect to Kraken WebSocket: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.scheduleReconnect();
    }
  }

  private disconnect(): void {
    if (this.ws) {
      try {
        // Only close if WebSocket is in a state that allows closing
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch (error) {
        this.logger.warn(
          `Error closing WebSocket: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
      this.ws = null;
      this.emit('disconnected', 1000, 'Manual disconnect');
    }

    // Clear all queues on disconnect
    this.symbolQueues.clear();
    this.processingQueues.clear();

    // Clear pending requests
    this.pendingRequests.clear();

    // Stop queue monitoring
    this.stopQueueMonitoring();
  }

  private scheduleReconnect(): void {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.warn(
        `Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Reinitializing markets...`,
      );
      this.reinitializeMarkets();
      return;
    }

    this.reconnectAttempts++;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.logger.log(
        `Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`,
      );
      this.connect();
    }, this.RECONNECT_DELAY);
  }

  /**
   * Handle WebSocket errors gracefully without crashing the application
   */
  private handleWebSocketError(error: Error): void {
    this.logger.warn(`Handling WebSocket error gracefully: ${error.message}`);

    // Check if this is a rate limit error (429)
    if (error.message.includes('429')) {
      this.handleRateLimitError();
      return;
    }

    // Mark WebSocket as null to prevent further operations
    this.ws = null;

    // Schedule reconnection
    this.scheduleReconnect();
  }

  /**
   * Restart the connection to Kraken WebSocket
   */
  private restartConnection(): void {
    // Prevent multiple simultaneous reconnection attempts
    if (this.isConnecting) {
      this.logger.debug(
        'Already reconnecting, skipping duplicate restart request',
      );
      return;
    }

    this.logger.warn('Restarting Kraken WebSocket connection...');

    // Disconnect current connection safely
    try {
      this.disconnect();
    } catch (error) {
      this.logger.warn(
        `Error during disconnect: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Force cleanup even if disconnect fails
      this.ws = null;
    }

    // Clear reconnect attempts to allow immediate reconnection
    this.reconnectAttempts = 0;

    // Reconnect after a short delay
    setTimeout(() => {
      this.connect();
    }, 1000);
  }

  /**
   * Handle rate limit errors (429) with exponential backoff and market reinitialization
   */
  private handleRateLimitError(): void {
    this.rateLimitAttempts++;

    this.logger.warn(
      `Rate limit detected (429). Attempt ${this.rateLimitAttempts}. Clearing markets and reinitializing with delay...`,
    );

    // Mark WebSocket as null
    this.ws = null;

    // Clear all market data to force fresh snapshots
    this.clearAllMarkets();

    // Use exponential backoff for rate limit errors with longer delays
    const baseDelay = 10000; // Start with 10 seconds
    const rateLimitDelay = Math.min(
      120000, // Max 2 minutes
      baseDelay * Math.pow(2, this.rateLimitAttempts - 1),
    );

    this.logger.log(
      `Waiting ${rateLimitDelay}ms before reinitializing due to rate limit...`,
    );

    setTimeout(() => {
      this.reinitializeMarkets();
    }, rateLimitDelay);
  }

  /**
   * Clear all market data and reinitialize connections
   */
  private clearAllMarkets(): void {
    this.logger.log('Clearing all market data for reinitialization...');

    // Clear in-memory store
    this.inMemoryStore = {};

    // Clear all queues
    this.symbolQueues.clear();
    this.processingQueues.clear();

    // Clear invalid symbols list to allow retry (in case they become valid)
    this.invalidSymbols.clear();
    this.logger.log('Cleared invalid symbols blacklist for retry');

    // Emit clear event to clients
    this.emit('marketsCleared');
  }

  /**
   * Reinitialize all markets after clearing
   */
  private reinitializeMarkets(): void {
    this.logger.log('Reinitializing markets after clearing...');

    // Clear any existing timeouts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reset reconnect attempts for fresh start (but keep rate limit attempts)
    this.reconnectAttempts = 0;

    // Add a delay before reconnecting to be gentle with Kraken
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 2000); // 2 second delay before reconnecting
  }

  /**
   * Start monitoring queue sizes every second for debugging purposes
   * If we see some queues growing too large, we can investigate further
   */
  private startQueueMonitoring(): void {
    this.queueMonitoringInterval = setInterval(() => {
      this.logQueueStatistics();
    }, 1000); // Every 1 second
  }

  /**
   * Stop the queue monitoring
   */
  private stopQueueMonitoring(): void {
    if (this.queueMonitoringInterval) {
      clearInterval(this.queueMonitoringInterval);
      this.queueMonitoringInterval = null;
    }
  }

  /**
   * Log queue statistics including unprocessed items
   */
  private logQueueStatistics(): void {
    if (this.symbolQueues.size === 0) {
      return;
    }

    const queueStats: {
      [symbol: string]: { pending: number; processing: boolean };
    } = {};
    let totalPending = 0;
    let totalProcessing = 0;

    // Collect stats for all queues
    for (const [symbol, queue] of this.symbolQueues.entries()) {
      const pendingCount = queue.length;
      const isProcessing = this.processingQueues.has(symbol);

      queueStats[symbol] = {
        pending: pendingCount,
        processing: isProcessing,
      };

      totalPending += pendingCount;
      if (isProcessing) totalProcessing++;
    }

    // Only log if there are pending items or issues
    if (totalPending > 0 || totalProcessing > 0) {
      this.logger.debug(
        `📊 Queue Status - Total: ${totalPending} pending across ${this.symbolQueues.size} queues, ${totalProcessing} processing`,
      );

      // Only show detailed queue info if there are pending items
      const queueDetails: string[] = [];
      for (const [symbol, stats] of Object.entries(queueStats)) {
        if (stats.pending > 0 || stats.processing) {
          const statusIcon = stats.processing ? '🔄' : '⏳';
          queueDetails.push(`${statusIcon} ${symbol}: ${stats.pending}`);
        }
      }

      if (queueDetails.length > 0) {
        this.logger.debug(`📋 Active Queues: ${queueDetails.join(', ')}`);
      }
    }

    // Warn if any queue is getting too large
    const largeQueues = Object.entries(queueStats)
      .filter(([, stats]) => stats.pending > 100)
      .map(([symbol]) => symbol);

    if (largeQueues.length > 0) {
      this.logger.warn(
        `⚠️ Large queues detected (>100 items): ${largeQueues.join(', ')}`,
      );
    }

    // Warn if queues are backing up significantly
    if (totalPending > 500) {
      this.logger.warn(
        `⚠️ High total queue load: ${totalPending} items pending across all queues`,
      );
    }
  }

  /**
   * Add message to symbol-specific queue for ordered processing
   */
  private enqueueMessage(
    message: KrakenBookSnapshot | KrakenBookUpdate,
    rawJson?: string,
  ): void {
    const symbolsToProcess = new Set<string>();

    // FIRST: Enqueue ALL items from this message to prevent race conditions
    for (const data of message.data) {
      const symbol = data.symbol;
      const normalizedSymbol = symbol.toUpperCase();

      if (!this.symbolQueues.has(normalizedSymbol)) {
        this.symbolQueues.set(normalizedSymbol, []);
      }

      const queue = this.symbolQueues.get(normalizedSymbol)!;

      // Prevent memory issues by limiting queue size
      if (queue.length >= this.MAX_QUEUE_SIZE) {
        // NOTE: This is where we should scale processing workers if needed
        // Maybe should be console.error instead of warn to catch attention on cloud logs
        this.logger.warn(
          `Queue for ${symbol} is full (${this.MAX_QUEUE_SIZE}), dropping oldest messages`,
        );
        queue.shift(); // Remove oldest message
      }

      const queuedMessage: QueuedMessage = {
        type: message.type,
        symbol: symbol,
        data: data,
        timestamp: Date.now(),
        rawJson,
      };

      queue.push(queuedMessage);
      symbolsToProcess.add(normalizedSymbol);
    }

    // THEN: Trigger processing for all affected symbols after all items are enqueued
    for (const normalizedSymbol of symbolsToProcess) {
      if (!this.processingQueues.has(normalizedSymbol)) {
        setImmediate(() => {
          void this.processSymbolQueue(normalizedSymbol);
        });
      }
    }
  }

  /**
   * Process queued messages for a symbol in order
   */
  private async processSymbolQueue(normalizedSymbol: string): Promise<void> {
    // Prevent processing if already processing or service is shutting down
    if (this.processingQueues.has(normalizedSymbol) || !this.ws) {
      return;
    }

    this.processingQueues.add(normalizedSymbol);

    try {
      const queue = this.symbolQueues.get(normalizedSymbol);
      if (!queue || queue.length === 0) {
        this.processingQueues.delete(normalizedSymbol);
        return;
      }

      while (queue.length > 0) {
        const queuedMessage = queue.shift()!;

        try {
          // Skip processing if symbol is resyncing (don't log to avoid spam)
          if (this.resyncingSymbols.has(normalizedSymbol)) {
            continue;
          }

          if (queuedMessage.type === 'snapshot') {
            this.processBookSnapshot(queuedMessage);
            // After snapshot, we can safely process any pending updates
            // No need to clear queue as updates build on the snapshot
          } else if (queuedMessage.type === 'update') {
            this.processBookUpdate(queuedMessage);
          }

          // Synchronous validation after each message processing
          try {
            // Validate orderbook integrity (negative or zero spread)
            // Note: Checksum validation is now done inside processBookUpdate and processBookSnapshot
            // to ensure it's verified against the exact state immediately after applying changes
            this.validateOrderbookIntegrity(normalizedSymbol);
          } catch (validationError) {
            this.logger.warn(
              `Validation error for ${normalizedSymbol}:`,
              validationError,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error processing ${queuedMessage.type} for ${queuedMessage.symbol}:`,
            error,
          );
        }

        // Small delay to prevent blocking the event loop
        if (queue.length > 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      // Schedule debounced validation after all updates are processed
      this.scheduleValidation(normalizedSymbol);
    } finally {
      this.processingQueues.delete(normalizedSymbol);
    }
  }

  /**
   * Schedule a debounced validation - waits for updates to settle before checking,
   * if there is a burst of updates and all of them should be applied before checking for integrity (negative or zero spread)
   */
  private scheduleValidation(normalizedSymbol: string): void {
    // Clear any existing validation timer
    const existingTimer = this.validationTimers.get(normalizedSymbol);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule validation after delay to allow batched updates to complete
    const timer = setTimeout(() => {
      this.validateOrderbookIntegrity(normalizedSymbol);
      this.validationTimers.delete(normalizedSymbol);
    }, this.VALIDATION_DELAY_MS);

    this.validationTimers.set(normalizedSymbol, timer);
  }

  private handleKrakenMessage(message: any, rawJson?: string): void {
    // Process message without logging individual events

    // Handle error responses
    if ('error' in message) {
      const errorMessage = message as {
        error: string;
        symbol?: string;
        req_id?: number;
      };

      // Determine log level based on error type and context
      const requestContext = errorMessage.req_id
        ? this.pendingRequests.get(errorMessage.req_id)
        : null;
      const isSubscriptionNotFound =
        errorMessage.error.includes('Subscription Not Found') ||
        errorMessage.error.includes('not found');
      const isUnsubscribeError = requestContext?.type === 'unsubscribe';

      // "Subscription Not Found" during unsubscribe is expected, not an error
      if (isSubscriptionNotFound && isUnsubscribeError) {
        this.logger.debug(
          `Subscription not found for ${errorMessage.symbol || 'unknown symbol'} - already unsubscribed`,
        );
      } else {
        this.logger.error(
          `Kraken API error: ${errorMessage.error} for ${errorMessage.symbol || 'unknown symbol'}`,
        );
      }

      // If this is a subscription error, clean up the invalid market
      if (errorMessage.symbol && errorMessage.req_id) {
        const normalizedSymbol = errorMessage.symbol.toUpperCase();
        const requestContext = this.pendingRequests.get(errorMessage.req_id);

        // Clean up the pending request
        this.pendingRequests.delete(errorMessage.req_id);

        if (requestContext?.type === 'subscribe') {
          // Check if this is a race condition (Already subscribed) vs truly invalid symbol
          const isAlreadySubscribed =
            errorMessage.error.includes('Already subscribed');
          const isInvalidSymbol =
            errorMessage.error.includes('Invalid symbol') ||
            errorMessage.error.includes('Unknown symbol') ||
            errorMessage.error.includes('not found');

          if (isAlreadySubscribed) {
            // This is a race condition, not an invalid symbol
            // Just update the subscription status
            this.logger.warn(
              `${normalizedSymbol} already subscribed (race condition). Marking as subscribed.`,
            );

            if (this.inMemoryStore[normalizedSymbol]) {
              this.inMemoryStore[normalizedSymbol].subscriptionStatus =
                'subscribed';
            }
            this.subscribedSymbols.add(normalizedSymbol);
            return;
          }

          // Only blacklist for truly invalid symbols
          if (isInvalidSymbol) {
            this.invalidSymbols.add(normalizedSymbol);
            this.logger.warn(
              `Added ${normalizedSymbol} to invalid symbols blacklist due to invalid symbol error`,
            );

            if (this.inMemoryStore[normalizedSymbol]) {
              this.logger.warn(
                `Removing invalid market ${normalizedSymbol} from store due to subscription API error`,
              );
              // Store the error before removing
              this.inMemoryStore[normalizedSymbol].lastError =
                `Kraken API error: ${errorMessage.error}`;
              this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'error';

              // Emit error event to notify clients
              this.emit('marketError', {
                symbol: normalizedSymbol,
                error: errorMessage.error,
                type: 'invalid_symbol',
              });

              // Clean up after a delay to allow clients to see the error within these n secs
              setTimeout(() => {
                delete this.inMemoryStore[normalizedSymbol];
                this.subscribedSymbols.delete(normalizedSymbol);
              }, 5000);
            }
          } else {
            // Other subscription errors - log but don't blacklist
            this.logger.warn(
              `Subscription error for ${normalizedSymbol}: ${errorMessage.error}. Not blacklisting.`,
            );
            if (this.inMemoryStore[normalizedSymbol]) {
              this.inMemoryStore[normalizedSymbol].lastError =
                errorMessage.error;
              this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'error';
            }
          }
        } else if (requestContext?.type === 'unsubscribe') {
          // For unsubscribe errors, just clean up without making noise
          // "Subscription Not Found" is expected during resyncs
          if (
            errorMessage.error.includes('Subscription Not Found') ||
            errorMessage.error.includes('not found')
          ) {
            this.logger.debug(
              `Unsubscribe found subscription already gone for ${normalizedSymbol}. State cleaned.`,
            );
          } else {
            this.logger.warn(
              `Unsubscribe error for ${normalizedSymbol}: ${errorMessage.error}. Cleaning up subscription state.`,
            );
          }

          // Clean up subscription state even if unsubscribe failed
          this.subscribedSymbols.delete(normalizedSymbol);
          if (this.inMemoryStore[normalizedSymbol]) {
            delete this.inMemoryStore[normalizedSymbol];
          }
        }
      } else if (errorMessage.symbol) {
        // Fallback for errors without req_id (shouldn't happen with proper tracking)
        const normalizedSymbol = errorMessage.symbol.toUpperCase();
        this.logger.warn(
          `Received error for ${normalizedSymbol} without request context: ${errorMessage.error}`,
        );
      }
      return;
    }

    // Handle subscription status responses
    if ('method' in message && 'success' in message) {
      this.handleSubscriptionStatus(message as KrakenSubscriptionStatus);
      return;
    }

    // Handle book data
    if ('channel' in message) {
      const channelMessage = message as {
        channel: string;
        type?: string;
        data?: any;
      };

      if (channelMessage.channel === 'instrument') {
        const instrType: string = String(channelMessage.type ?? '');
        const instrData = channelMessage.data as
          | { pairs?: unknown[] }
          | undefined;
        const instrPairs: KrakenInstrumentPair[] = (
          Array.isArray(instrData?.pairs) ? instrData.pairs : []
        ) as KrakenInstrumentPair[];
        this.handleInstrumentMessage(instrType, instrPairs);
        return;
      }

      if (channelMessage.channel === 'book') {
        if (channelMessage.type === 'snapshot') {
          this.enqueueMessage(channelMessage as KrakenBookSnapshot, rawJson);
        } else if (channelMessage.type === 'update') {
          this.enqueueMessage(channelMessage as KrakenBookUpdate, rawJson);
        }
      }
    }
  }

  /**
   * Process book snapshot from queue
   */
  private processBookSnapshot(queuedMessage: QueuedMessage): void {
    const data = queuedMessage.data;
    const symbol = queuedMessage.symbol;
    const normalizedSymbol = symbol.toUpperCase();

    // this.logger.debug(`Processing book snapshot for ${symbol}`);
    this.metricsService.incrementOrderBookCount(symbol);

    // Safely access bids and asks with type guards
    const bids = Array.isArray(data.bids)
      ? this.parseOrderBookEntries(data.bids, queuedMessage.rawJson)
      : [];
    const asks = Array.isArray(data.asks)
      ? this.parseOrderBookEntries(data.asks, queuedMessage.rawJson)
      : [];

    // Calculate mid-price and spread using standard financial formulas:
    // - Mid-price: The average between the best bid and the best ask
    //   Formula: (Best Bid + Best Ask) / 2
    // - Spread: The difference between top ask and top bid as a percentage
    //   Formula: (Top Ask Price - Top Bid Price) / Mid Price * 100
    const bestBid = Decimal.max(...bids.map((b) => b.price));
    const bestAsk = Decimal.min(...asks.map((a) => a.price));
    const midPrice = bestBid.plus(bestAsk).dividedBy(2);
    const spreadPercentage = bestAsk
      .minus(bestBid)
      .dividedBy(midPrice)
      .times(100);

    // Update in-memory store
    this.inMemoryStore[symbol.toUpperCase()] = {
      orderbooksPerMinute: this.metricsService.getOrderBooksPerMinute(symbol),
      orderbook: {
        spread: spreadPercentage.toString(),
        midPrice: midPrice.toString(),
        asks: asks.sort((a, b) => a.price.comparedTo(b.price)),
        bids: bids.sort((a, b) => b.price.comparedTo(a.price)),
        lastUpdate: new Date().toISOString(),
        lastProcessedTimestamp: data.timestamp, // Initialize with snapshot timestamp
      },
      subscriptionStatus: 'subscribed',
    };

    // Verify checksum if provided - use raw data from Kraken
    if ('checksum' in data && typeof data.checksum === 'number') {
      if (data.asks && data.bids) {
        this.verifyChecksum(
          normalizedSymbol,
          data.checksum,
          data.asks,
          data.bids,
          queuedMessage.rawJson,
        );
      }
    }

    this.emit('marketUpdate', symbol);
  }

  /**
   * Process book update from queue
   */
  private processBookUpdate(queuedMessage: QueuedMessage): void {
    const data = queuedMessage.data;
    const symbol = queuedMessage.symbol;

    this.metricsService.incrementOrderBookCount(symbol);

    const normalizedSymbol = symbol.toUpperCase();
    const marketData = this.inMemoryStore[normalizedSymbol];

    if (!marketData) {
      // Before treating this as an error, check if this symbol is still being tracked
      // This prevents race condition where we get updates for recently unsubscribed symbols
      if (
        this.isMarketTrackedCallback &&
        !this.isMarketTrackedCallback(normalizedSymbol)
      ) {
        this.logger.debug(
          `Ignoring book update for unsubscribed symbol: ${normalizedSymbol}`,
        );
        return;
      }

      this.logger.error(
        `Received update for uninitialized market ${symbol}. Triggering reconnection to get fresh snapshots...`,
      );

      // This indicates we missed the initial snapshot or there's a connection issue
      // Restart the connection to get fresh snapshots for all markets
      this.restartConnection();
      return;
    }

    // Check message ordering using Kraken's timestamp to prevent out-of-order processing
    if (data.timestamp && marketData.orderbook.lastProcessedTimestamp) {
      if (data.timestamp <= marketData.orderbook.lastProcessedTimestamp) {
        this.logger.warn(
          `Skipping out-of-order update for ${normalizedSymbol}: ` +
            `message timestamp ${data.timestamp} <= last processed ${marketData.orderbook.lastProcessedTimestamp}. ` +
            `This prevents checksum mismatches from race conditions.`,
        );
        return;
      }
    }

    // Update bids and asks with delta changes - with type safety
    if (Array.isArray(data.bids)) {
      const bidDeltas = this.parseOrderBookEntries(
        data.bids,
        queuedMessage.rawJson,
      );
      this.applyBookDeltas(marketData.orderbook.bids, bidDeltas);
    }
    if (Array.isArray(data.asks)) {
      const askDeltas = this.parseOrderBookEntries(
        data.asks,
        queuedMessage.rawJson,
      );
      this.applyBookDeltas(marketData.orderbook.asks, askDeltas);
    }

    // After applying ALL updates in the message, truncate to subscribed depth (10 levels)
    // This is critical - Kraken expects checksums on exactly the subscribed depth
    marketData.orderbook.bids.sort((a, b) => b.price.comparedTo(a.price));
    marketData.orderbook.asks.sort((a, b) => a.price.comparedTo(b.price));

    // Truncate to exactly 10 levels (our subscribed depth) - this is what Kraken uses for checksum
    marketData.orderbook.bids = marketData.orderbook.bids.slice(0, 10);
    marketData.orderbook.asks = marketData.orderbook.asks.slice(0, 10);

    // CRITICAL: Create snapshot immediately after truncation, before any other operations
    // This ensures we verify the exact state that corresponds to this update's checksum
    let orderbookSnapshot: {
      asks: OrderBookEntry[];
      bids: OrderBookEntry[];
    } | null = null;

    if ('checksum' in data && typeof data.checksum === 'number') {
      // Deep clone the orderbook state immediately to avoid race conditions
      orderbookSnapshot = {
        asks: marketData.orderbook.asks.map((ask) => ({
          price: new Decimal(ask.price),
          quantity: new Decimal(ask.quantity),
          originalPrice: ask.originalPrice,
          originalQty: ask.originalQty,
        })),
        bids: marketData.orderbook.bids.map((bid) => ({
          price: new Decimal(bid.price),
          quantity: new Decimal(bid.quantity),
          originalPrice: bid.originalPrice,
          originalQty: bid.originalQty,
        })),
      };
    }

    // Recalculate mid-price and spread using standard financial formulas:
    // - Mid-price: The average between the best bid and the best ask
    //   Formula: (Best Bid + Best Ask) / 2
    // - Spread: The difference between top ask and top bid as a percentage
    //   Formula: (Top Ask Price - Top Bid Price) / Mid Price * 100
    if (
      marketData.orderbook.bids.length > 0 &&
      marketData.orderbook.asks.length > 0
    ) {
      const bestBid = Decimal.max(
        ...marketData.orderbook.bids.map((b) => b.price),
      );
      const bestAsk = Decimal.min(
        ...marketData.orderbook.asks.map((a) => a.price),
      );
      const midPrice = bestBid.plus(bestAsk).dividedBy(2);
      const spreadPercentage = bestAsk
        .minus(bestBid)
        .dividedBy(midPrice)
        .times(100);

      // Don't validate here - will be validated after all queued updates are processed
      marketData.orderbook.spread = spreadPercentage.toString();
      marketData.orderbook.midPrice = midPrice.toString();
      marketData.orderbook.lastUpdate = new Date().toISOString();

      // Update last processed timestamp to enforce ordering
      if (data.timestamp) {
        marketData.orderbook.lastProcessedTimestamp = data.timestamp;
      }

      // Update metrics
      marketData.orderbooksPerMinute =
        this.metricsService.getOrderBooksPerMinute(symbol);
    }

    // Verify checksum if provided - must verify immediately while snapshot matches the state
    if (
      orderbookSnapshot !== null &&
      'checksum' in data &&
      typeof data.checksum === 'number'
    ) {
      // CRITICAL: Verify the checksum immediately against the snapshot we just captured
      // The checksum from Kraken corresponds to the exact orderbook state after this update
      // If we skip verification and apply more updates, the checksum won't match anymore
      this.verifyChecksumWithSnapshot(
        normalizedSymbol,
        data.checksum,
        orderbookSnapshot,
      );
    }

    this.emit('marketUpdate', symbol);
  }

  /**
   * Format price level for checksum calculation according to Kraken spec:
   * - Remove decimal point from price and quantity (KEEP trailing zeros as-is)
   * - Strip leading zeros from BOTH price AND quantity
   * - Concatenate price and quantity
   * Accepts either raw Kraken data or OrderBookEntry
   * @param rawJson - Optional raw JSON string to extract exact numeric representation
   */
  private formatPriceLevelForChecksum(
    entry:
      | OrderBookEntry
      | { price: unknown; qty?: unknown; quantity?: unknown }
      | unknown[],
    exactNumbersMap?: Map<string, { price: string; qty: string }>,
  ): string {
    let priceStr: string;
    let qtyStr: string;

    if (Array.isArray(entry)) {
      // Raw Kraken format: [price, qty]
      priceStr = String(entry[0]);
      qtyStr = String(entry[1]);
    } else if ('qty' in entry) {
      // Raw Kraken object format: {price, qty}
      // Look up exact representation from pre-built map
      if (exactNumbersMap) {
        const key = `${this.normalizeNumberString(String(entry.price))}|${this.normalizeNumberString(String(entry.qty))}`;
        const exact = exactNumbersMap.get(key);
        if (exact) {
          priceStr = exact.price;
          qtyStr = exact.qty;
        } else {
          priceStr = String(entry.price);
          qtyStr = String(entry.qty);
        }
      } else {
        priceStr = String(entry.price);
        qtyStr = String(entry.qty);
      }
    } else {
      // OrderBookEntry with numeric values: {price, quantity}
      // Use preserved original strings if available, otherwise convert from float
      if ('originalPrice' in entry && typeof entry.originalPrice === 'string') {
        priceStr = entry.originalPrice || String(entry.price);
        qtyStr = entry.originalQty || String(entry.quantity);
      } else {
        const e = entry as OrderBookEntry;
        priceStr = String(e.price);
        qtyStr = String(e.quantity ?? 0);
        // Log when we're using converted floats instead of original strings
        // This helps debug checksum mismatches
      }
    }

    // Remove decimal point (keep trailing zeros exactly as Kraken sends them)
    const priceNoDec = priceStr.replace('.', '');
    const qtyNoDec = qtyStr.replace('.', '');

    // Strip leading zeros (but keep at least one digit)
    const priceClean = priceNoDec.replace(/^0+/, '') || '0';
    const qtyClean = qtyNoDec.replace(/^0+/, '') || '0';

    return priceClean + qtyClean;
  }

  /**
   * Format price level for checksum calculation using original string values
   * This ensures trailing zeros are preserved exactly as Kraken sends them
   */
  private formatPriceLevelForChecksumFromStrings(
    priceStr: string,
    qtyStr: string,
  ): string {
    // Remove decimal point (keep trailing zeros exactly as Kraken sends them)
    const priceNoDec = priceStr.replace('.', '');
    const qtyNoDec = qtyStr.replace('.', '');

    // Strip leading zeros (but keep at least one digit)
    const priceClean = priceNoDec.replace(/^0+/, '') || '0';
    const qtyClean = qtyNoDec.replace(/^0+/, '') || '0';

    return priceClean + qtyClean;
  }

  /**
   * Extract ALL price/qty pairs from raw JSON in a single pass, preserving exact
   * string representation including trailing zeros.
   *
   * CRITICAL: This function CANNOT be removed!
   *
   * Even though we use json-bigint with storeAsString: true, it still strips trailing zeros:
   * - Kraken sends: "0.00000000" → json-bigint returns: "0"
   * - Kraken sends: "1.67751120" → json-bigint returns: "1.6775112"
   *
   * Kraken's CRC32 checksum calculation uses the EXACT string representation including
   * trailing zeros. Without this function, all checksum verifications will fail.
   *
   * Returns a Map keyed by "normalizedPrice|normalizedQty" → { price, qty } with exact strings.
   * By extracting ALL pairs in one pass we avoid the previous per-entry regex approach which
   * could match the wrong entry when one price was a numeric prefix of another.
   */
  private extractAllExactNumbers(
    rawJson: string,
  ): Map<string, { price: string; qty: string }> {
    const result = new Map<string, { price: string; qty: string }>();

    // Match ALL occurrences of "price":<number>,"qty":<number> in the raw JSON.
    // The regex uses [,}\s] lookahead after qty to ensure we capture the full number
    // and don't stop short or overshoot into the next field.
    const pattern = /"price":(\d+(?:\.\d+)?),\s*"qty":(\d+(?:\.\d+)?)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(rawJson)) !== null) {
      const rawPrice = match[1];
      const rawQty = match[2];

      // Normalize to match what json-bigint with storeAsString produces
      const normalizedPrice = this.normalizeNumberString(rawPrice);
      const normalizedQty = this.normalizeNumberString(rawQty);

      // Key by normalized values (what json-bigint gives us after parsing)
      const key = `${normalizedPrice}|${normalizedQty}`;

      // Store each unique normalized pair. If the same normalized pair appears
      // multiple times (extremely unlikely in a single orderbook message) the
      // first occurrence wins — they'd have the same trailing-zero pattern anyway.
      if (!result.has(key)) {
        result.set(key, { price: rawPrice, qty: rawQty });
      }
    }

    return result;
  }

  /**
   * Normalize a number string to a canonical decimal form:
   * - "90038.0"       → "90038"
   * - "0.00000000"    → "0"
   * - "1.67751120"    → "1.6775112"
   * - "12345"         → "12345" (no-op)
   * - "7.9e-7"        → "0.00000079"  (expand scientific notation)
   */
  private normalizeNumberString(s: string): string {
    // Handle scientific notation by expanding to full decimal form.
    // json-bigint may return small numbers like 0.00000079 as "7.9e-7";
    // the raw JSON always uses decimal notation, so we must expand to match.
    if (s.includes('e') || s.includes('E')) {
      try {
        s = new Decimal(s).toFixed();
      } catch {
        // If Decimal.js can't parse it, fall through with original string
      }
    }
    if (!s.includes('.')) return s;
    // Strip trailing zeros after decimal, then strip trailing dot if it remains
    const stripped = s.replace(/0+$/, '').replace(/\.$/, '');
    return stripped || '0';
  }

  /**
   * Helper function to safely extract price from orderbook entry
   * Handles both object format {price, qty} and array format [price, qty]
   */
  private getPriceFromEntry(entry: unknown): number {
    const typedEntry = entry as { price?: unknown; [key: number]: unknown };
    const priceValue = typedEntry.price ?? typedEntry[0];
    return parseFloat(String(priceValue));
  }

  /**
   * Calculate CRC32 checksum using raw Kraken data (preserves precision)
   * Uses top 10 asks (ascending) and top 10 bids (descending)
   * @param rawJson - The raw JSON string to extract exact numeric representations
   */
  private calculateChecksumFromRaw(
    rawAsks: unknown[],
    rawBids: unknown[],
    rawJson?: string,
  ): number {
    // CRITICAL: Sort asks ascending (lowest first) and bids descending (highest first)
    // Kraken's checksum is calculated on sorted data
    const sortedAsks = [...rawAsks].sort((a, b) => {
      return this.getPriceFromEntry(a) - this.getPriceFromEntry(b); // Ascending
    });

    const sortedBids = [...rawBids].sort((a, b) => {
      return this.getPriceFromEntry(b) - this.getPriceFromEntry(a); // Descending
    });

    // Take top 10 of each
    const top10Asks = sortedAsks.slice(0, 10);
    const top10Bids = sortedBids.slice(0, 10);

    // Pre-extract ALL exact numbers from rawJson once (not per-entry)
    const exactNumbersMap = rawJson
      ? this.extractAllExactNumbers(rawJson)
      : undefined;

    // Build checksum string: asks first, then bids
    let checksumString = '';
    const askStrings: string[] = [];
    for (const ask of top10Asks) {
      const formatted = this.formatPriceLevelForChecksum(
        ask as OrderBookEntry | { price: unknown; qty: unknown },
        exactNumbersMap,
      );
      askStrings.push(formatted);
      checksumString += formatted;
    }
    const bidStrings: string[] = [];
    for (const bid of top10Bids) {
      const formatted = this.formatPriceLevelForChecksum(
        bid as OrderBookEntry | { price: unknown; qty: unknown },
        exactNumbersMap,
      );
      bidStrings.push(formatted);
      checksumString += formatted;
    }

    // this.logger.debug(
    //   `Checksum calculation from raw:\n` +
    //     `  Full string: "${checksumString}"\n` +
    //     `  Length: ${checksumString.length}\n` +
    //     `  Ask strings: ${JSON.stringify(askStrings)}\n` +
    //     `  Bid strings: ${JSON.stringify(bidStrings)}`,
    // );

    // Calculate CRC32 using buffer-crc32
    // Pass string, it returns a Buffer. Read as unsigned 32-bit BE integer
    const crcBuffer = crc32(checksumString);
    return crcBuffer.readUInt32BE(0);
  }

  /**
   * Calculate CRC32 checksum using current orderbook state (for updates)
   * Uses top 10 asks (ascending) and top 10 bids (descending)
   */
  private calculateChecksumFromCurrentState(normalizedSymbol: string): number {
    const marketData = this.inMemoryStore[normalizedSymbol];
    if (!marketData) return 0;

    const { asks, bids } = marketData.orderbook;

    // Get top 10 asks sorted ascending (lowest to highest)
    const top10Asks = [...asks]
      .sort((a, b) => a.price.comparedTo(b.price))
      .slice(0, 10);

    // Get top 10 bids sorted descending (highest to lowest)
    const top10Bids = [...bids]
      .sort((a, b) => b.price.comparedTo(a.price))
      .slice(0, 10);

    // Check if we have originalPrice/originalQty preserved
    const asksWithOriginal = top10Asks.filter((a) => a.originalPrice).length;
    const bidsWithOriginal = top10Bids.filter((b) => b.originalPrice).length;
    const hasOriginalStrings = asksWithOriginal > 0 || bidsWithOriginal > 0;

    if (!hasOriginalStrings) {
      this.logger.warn(
        `Checksum calculation for ${normalizedSymbol}: No originalPrice/originalQty found in orderbook entries. ` +
          `This will cause checksum mismatch. Asks: ${asksWithOriginal}/${top10Asks.length}, Bids: ${bidsWithOriginal}/${top10Bids.length}`,
      );
    } else if (
      asksWithOriginal < top10Asks.length ||
      bidsWithOriginal < top10Bids.length
    ) {
      this.logger.warn(
        `Checksum calculation for ${normalizedSymbol}: Partial original strings preserved. ` +
          `Asks: ${asksWithOriginal}/${top10Asks.length}, Bids: ${bidsWithOriginal}/${top10Bids.length}. May cause mismatch.`,
      );
    }

    // Build checksum string: asks first, then bids
    let checksumString = '';
    const askStrings: string[] = [];
    const askDetails: string[] = [];
    for (const ask of top10Asks) {
      const formatted = this.formatPriceLevelForChecksum(ask);
      askStrings.push(formatted);
      checksumString += formatted;
      askDetails.push(
        `${ask.price.toString()}/${ask.quantity.toString()} (orig: ${ask.originalPrice || 'none'}/${ask.originalQty || 'none'})`,
      );
    }
    const bidStrings: string[] = [];
    const bidDetails: string[] = [];
    for (const bid of top10Bids) {
      const formatted = this.formatPriceLevelForChecksum(bid);
      bidStrings.push(formatted);
      checksumString += formatted;
      bidDetails.push(
        `${bid.price.toString()}/${bid.quantity.toString()} (orig: ${bid.originalPrice || 'none'}/${bid.originalQty || 'none'})`,
      );
    }

    // Log detailed checksum calculation when original strings are missing
    if (
      !hasOriginalStrings ||
      asksWithOriginal < top10Asks.length ||
      bidsWithOriginal < top10Bids.length
    ) {
      this.logger.debug(
        `Checksum details for ${normalizedSymbol}:\n` +
          `  Top 10 Asks: ${askDetails.join(', ')}\n` +
          `  Top 10 Bids: ${bidDetails.join(', ')}\n` +
          `  Formatted asks: ${askStrings.join(', ')}\n` +
          `  Formatted bids: ${bidStrings.join(', ')}\n` +
          `  Checksum string: "${checksumString}" (length: ${checksumString.length})`,
      );
    }

    // this.logger.debug(
    //   `Checksum calculation from local state:\n` +
    //     `  Full string: "${checksumString}"\n` +
    //     `  Length: ${checksumString.length}\n` +
    //     `  Ask strings: ${JSON.stringify(askStrings)}\n` +
    //     `  Bid strings: ${JSON.stringify(bidStrings)}\n` +
    //     `  First ask original: price=${top10Asks[0]?.originalPrice}, qty=${top10Asks[0]?.originalQty}\n` +
    //     `  First bid original: price=${top10Bids[0]?.originalPrice}, qty=${top10Bids[0]?.originalQty}`,
    // );

    // Calculate CRC32 using buffer-crc32
    const crcBuffer = crc32(checksumString);
    return crcBuffer.readUInt32BE(0);
  }

  /**
   * Verify checksum against Kraken's provided value using raw data (for snapshots)
   * If mismatch detected, trigger resync
   */
  private verifyChecksum(
    normalizedSymbol: string,
    krakenChecksum: number,
    rawAsks: any[],
    rawBids: any[],
    rawJson?: string,
  ): void {
    if (!Array.isArray(rawAsks) || !Array.isArray(rawBids)) {
      this.logger.debug(`Skipping checksum verification - missing data`);
      return;
    }

    // Calculate checksum from raw snapshot data
    const calculatedChecksum = this.calculateChecksumFromRaw(
      rawAsks,
      rawBids,
      rawJson,
    );

    // Debug: Also calculate from our local stored copy to compare
    // const localChecksum =
    //   this.calculateChecksumFromCurrentState(normalizedSymbol);

    // this.logger.debug(
    //   `Checksum comparison for ${normalizedSymbol}:\n` +
    //     `  Kraken's checksum:      ${krakenChecksum}\n` +
    //     `  From raw snapshot:      ${calculatedChecksum} ${calculatedChecksum === krakenChecksum ? '✅' : '❌'}\n` +
    //     `  From local orderbook:   ${localChecksum} ${localChecksum === krakenChecksum ? '✅' : '❌'}\n` +
    //     `  Raw asks sample: ${JSON.stringify(rawAsks.slice(0, 2))}\n` +
    //     `  Raw bids sample: ${JSON.stringify(rawBids.slice(0, 2))}`,
    // );

    if (calculatedChecksum !== krakenChecksum) {
      this.logger.warn(
        `Checksum mismatch for ${normalizedSymbol}: ` +
          `expected ${krakenChecksum}, got ${calculatedChecksum}. ` +
          `Asks: ${rawAsks.length}, Bids: ${rawBids.length}. Resyncing...`,
      );
      this.resyncMarket(normalizedSymbol);
    }
  }

  /**
   * Verify checksum using provided orderbook snapshot (prevents race conditions)
   * If mismatch detected, trigger resync
   */
  private verifyChecksumWithSnapshot(
    normalizedSymbol: string,
    krakenChecksum: number,
    orderbookSnapshot: { asks: OrderBookEntry[]; bids: OrderBookEntry[] },
  ): void {
    const calculatedChecksum =
      this.calculateChecksumFromSnapshot(orderbookSnapshot);

    if (calculatedChecksum !== krakenChecksum) {
      const askCount = orderbookSnapshot.asks.length;
      const bidCount = orderbookSnapshot.bids.length;

      // Get top 10 asks sorted ascending (lowest to highest)
      const top10Asks = [...orderbookSnapshot.asks]
        .sort((a, b) => a.price.comparedTo(b.price))
        .slice(0, 10);

      // Get top 10 bids sorted descending (highest to lowest)
      const top10Bids = [...orderbookSnapshot.bids]
        .sort((a, b) => b.price.comparedTo(a.price))
        .slice(0, 10);

      const askDetails = top10Asks.map(
        (a) =>
          `${a.price.toString()}/${a.quantity.toString()} (orig: ${a.originalPrice || 'NONE'}/${a.originalQty || 'NONE'})`,
      );
      const bidDetails = top10Bids.map(
        (b) =>
          `${b.price.toString()}/${b.quantity.toString()} (orig: ${b.originalPrice || 'NONE'}/${b.originalQty || 'NONE'})`,
      );

      this.logger.warn(
        `Checksum mismatch for ${normalizedSymbol}: ` +
          `expected ${krakenChecksum}, got ${calculatedChecksum}. ` +
          `Orderbook has ${askCount} asks, ${bidCount} bids. Resyncing...`,
      );

      this.logger.debug(
        `CHECKSUM MISMATCH DETAILS for ${normalizedSymbol}:\n` +
          `  Expected: ${krakenChecksum}\n` +
          `  Calculated: ${calculatedChecksum}\n` +
          `  Top 10 Asks:\n    ${askDetails.join('\n    ')}\n` +
          `  Top 10 Bids:\n    ${bidDetails.join('\n    ')}`,
      );

      // Recalculate with debug logging to show the exact checksum string used
      this.calculateChecksumFromSnapshot(orderbookSnapshot, true);

      this.resyncMarket(normalizedSymbol);
    }
  }

  /**
   * Calculate checksum from orderbook snapshot (race condition safe)
   * Assumes snapshot is already sorted and truncated to top 10 levels
   */
  private calculateChecksumFromSnapshot(
    orderbookSnapshot: {
      asks: OrderBookEntry[];
      bids: OrderBookEntry[];
    },
    debugLog: boolean = false,
  ): number {
    const { asks, bids } = orderbookSnapshot;

    // Snapshot should already be sorted and truncated to 10 levels from processBookUpdate
    // Do NOT sort again as it may cause subtle ordering issues with floating point prices
    const top10Asks = asks.slice(0, 10);
    const top10Bids = bids.slice(0, 10);

    // Check if we have originalPrice/originalQty preserved
    const asksWithOriginal = top10Asks.filter((a) => a.originalPrice).length;
    const bidsWithOriginal = top10Bids.filter((b) => b.originalPrice).length;
    const hasOriginalStrings = asksWithOriginal > 0 || bidsWithOriginal > 0;

    if (!hasOriginalStrings) {
      this.logger.warn(
        `Checksum calculation: No originalPrice/originalQty found in orderbook entries. ` +
          `This will cause checksum mismatch. Asks: ${asksWithOriginal}/${top10Asks.length}, Bids: ${bidsWithOriginal}/${top10Bids.length}`,
      );
    }

    // Build checksum string: asks first, then bids
    // ALWAYS use original strings when available for accurate checksum
    let checksumString = '';
    const debugParts: string[] | null = debugLog ? [] : null;

    for (const ask of top10Asks) {
      if (ask.originalPrice && ask.originalQty) {
        const formatted = this.formatPriceLevelForChecksumFromStrings(
          ask.originalPrice,
          ask.originalQty,
        );
        checksumString += formatted;
        if (debugLog && debugParts) {
          debugParts.push(
            `ASK ${ask.originalPrice}/${ask.originalQty} → ${formatted}`,
          );
        }
      } else {
        // Fallback to converted values if original strings not available (will cause mismatch)
        const formatted = this.formatPriceLevelForChecksum(ask);
        checksumString += formatted;
        if (debugLog && debugParts) {
          debugParts.push(
            `ASK ${ask.price.toString()}/${ask.quantity.toString()} [NO ORIG] → ${formatted}`,
          );
        }
      }
    }
    for (const bid of top10Bids) {
      if (bid.originalPrice && bid.originalQty) {
        const formatted = this.formatPriceLevelForChecksumFromStrings(
          bid.originalPrice,
          bid.originalQty,
        );
        checksumString += formatted;
        if (debugLog && debugParts) {
          debugParts.push(
            `BID ${bid.originalPrice}/${bid.originalQty} → ${formatted}`,
          );
        }
      } else {
        // Fallback to converted values if original strings not available (will cause mismatch)
        const formatted = this.formatPriceLevelForChecksum(bid);
        checksumString += formatted;
        if (debugLog && debugParts) {
          debugParts.push(
            `BID ${bid.price.toString()}/${bid.quantity.toString()} [NO ORIG] → ${formatted}`,
          );
        }
      }
    }

    // Log the exact checksum calculation only when requested
    if (debugLog && debugParts) {
      this.logger.debug(
        `Checksum calculation breakdown:\n${debugParts.join('\n')}\n` +
          `Full string: "${checksumString}" (length: ${checksumString.length})`,
      );
    }

    // Calculate CRC32 using buffer-crc32 - Kraken expects Big Endian byte order
    const crcBuffer = crc32(checksumString);
    return crcBuffer.readUInt32BE(0);
  }

  /**
   * Verify checksum using current orderbook state (for updates)
   * If mismatch detected, trigger resync
   */
  private verifyChecksumWithCurrentState(
    normalizedSymbol: string,
    krakenChecksum: number,
  ): void {
    const calculatedChecksum =
      this.calculateChecksumFromCurrentState(normalizedSymbol);

    if (calculatedChecksum !== krakenChecksum) {
      const marketData = this.inMemoryStore[normalizedSymbol];
      const askCount = marketData?.orderbook.asks.length || 0;
      const bidCount = marketData?.orderbook.bids.length || 0;

      // Log detailed information about the mismatch
      const top10Asks = [...(marketData?.orderbook.asks || [])]
        .sort((a, b) => a.price.comparedTo(b.price))
        .slice(0, 10);
      const top10Bids = [...(marketData?.orderbook.bids || [])]
        .sort((a, b) => b.price.comparedTo(a.price))
        .slice(0, 10);

      const askDetails = top10Asks.map(
        (a) =>
          `${a.price.toString()}/${a.quantity.toString()} (orig: ${a.originalPrice || 'NONE'}/${a.originalQty || 'NONE'})`,
      );
      const bidDetails = top10Bids.map(
        (b) =>
          `${b.price.toString()}/${b.quantity.toString()} (orig: ${b.originalPrice || 'NONE'}/${b.originalQty || 'NONE'})`,
      );

      this.logger.warn(
        `Checksum mismatch for ${normalizedSymbol}: ` +
          `expected ${krakenChecksum}, got ${calculatedChecksum}. ` +
          `Orderbook has ${askCount} asks, ${bidCount} bids. Resyncing...`,
      );

      this.logger.debug(
        `CHECKSUM MISMATCH DETAILS for ${normalizedSymbol}:\n` +
          `  Expected: ${krakenChecksum}\n` +
          `  Calculated: ${calculatedChecksum}\n` +
          `  Top 10 Asks:\n    ${askDetails.join('\n    ')}\n` +
          `  Top 10 Bids:\n    ${bidDetails.join('\n    ')}`,
      );

      // Now calculate and log the actual checksum string
      const checksumAskStrings: string[] = [];
      const checksumBidStrings: string[] = [];
      for (const ask of top10Asks) {
        const formatted = this.formatPriceLevelForChecksum(ask);
        checksumAskStrings.push(formatted);
      }
      for (const bid of top10Bids) {
        const formatted = this.formatPriceLevelForChecksum(bid);
        checksumBidStrings.push(formatted);
      }
      const fullChecksumString =
        checksumAskStrings.join('') + checksumBidStrings.join('');

      this.logger.debug(
        `CHECKSUM STRING BREAKDOWN:\n` +
          `  Ask formatted: [${checksumAskStrings.join(', ')}]\n` +
          `  Bid formatted: [${checksumBidStrings.join(', ')}]\n` +
          `  Full checksum string: "${fullChecksumString}"\n` +
          `  String length: ${fullChecksumString.length}\n` +
          `  Note: Asks sorted ascending (${top10Asks[0]?.price.toString()} to ${top10Asks[9]?.price.toString()}), ` +
          `Bids sorted descending (${top10Bids[0]?.price.toString()} to ${top10Bids[9]?.price.toString()})`,
      );

      this.resyncMarket(normalizedSymbol);
    }
  }

  /**
   * Validate orderbook integrity after processing all queued updates
   */
  private validateOrderbookIntegrity(normalizedSymbol: string): void {
    const marketData = this.inMemoryStore[normalizedSymbol];
    if (!marketData) return;

    if (
      marketData.orderbook.bids.length > 0 &&
      marketData.orderbook.asks.length > 0
    ) {
      const bestBid = Decimal.max(
        ...marketData.orderbook.bids.map((b) => b.price),
      );
      const bestAsk = Decimal.min(
        ...marketData.orderbook.asks.map((a) => a.price),
      );

      // Check if orderbook is invalid after processing ALL updates
      if (bestBid.greaterThanOrEqualTo(bestAsk)) {
        // Log detailed orderbook state for debugging
        const topBids = marketData.orderbook.bids
          .sort((a, b) => b.price.comparedTo(a.price))
          .slice(0, 5)
          .map((b) => `${b.price.toString()}@${b.quantity.toString()}`)
          .join(', ');
        const topAsks = marketData.orderbook.asks
          .sort((a, b) => a.price.comparedTo(b.price))
          .slice(0, 5)
          .map((a) => `${a.price.toString()}@${a.quantity.toString()}`)
          .join(', ');

        this.logger.warn(
          `Invalid orderbook for ${normalizedSymbol} after processing queue: bestBid (${bestBid.toString()}) >= bestAsk (${bestAsk.toString()}). ` +
            `Bids: ${marketData.orderbook.bids.length}, Asks: ${marketData.orderbook.asks.length}. ` +
            `Top bids: [${topBids}], Top asks: [${topAsks}]. Resyncing...`,
        );
        this.resyncMarket(normalizedSymbol);
      }
    }
  }

  private handleBookUpdate(message: KrakenBookUpdate): void {
    // This method is kept for compatibility but now delegates to queue system
    this.enqueueMessage(message);
  }

  private handleSubscriptionStatus(message: KrakenSubscriptionStatus): void {
    const status = message.success ? 'SUCCESS' : 'FAILED';

    // Handle different channel types
    let symbol = 'unknown';
    if (message.result?.channel === 'book' && 'symbol' in message.result) {
      symbol = message.result.symbol;
    } else if (message.result?.channel === 'instrument') {
      symbol = 'instrument';
    }

    this.logger.log(
      `Subscription status: ${message.method} ${symbol} - ${status}`,
    );

    if (
      message.success &&
      message.method === 'subscribe' &&
      message.result?.channel === 'book' &&
      'symbol' in message.result
    ) {
      const normalizedSymbol = message.result.symbol.toUpperCase();
      this.subscribedSymbols.add(normalizedSymbol);

      // Update market data subscription status
      if (this.inMemoryStore[normalizedSymbol]) {
        this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'subscribed';
        this.logger.log(
          `Market ${message.result.symbol} successfully subscribed and ready for data`,
        );
      }
    } else if (
      message.success &&
      message.method === 'unsubscribe' &&
      message.result?.channel === 'book' &&
      'symbol' in message.result
    ) {
      const normalizedSymbol = message.result.symbol.toUpperCase();

      // Only clean up if we're not actively subscribed
      // This prevents race condition where user re-subscribes before unsubscribe confirmation arrives
      if (this.subscribedSymbols.has(normalizedSymbol)) {
        this.logger.debug(
          `Received unsubscribe confirmation for ${message.result.symbol}, but already re-subscribed. Ignoring cleanup.`,
        );
        return;
      }

      this.subscribedSymbols.delete(normalizedSymbol);

      // Clean up market data completely to prevent re-subscription
      if (this.inMemoryStore[normalizedSymbol]) {
        this.logger.log(
          `Successfully unsubscribed from ${message.result.symbol}, cleaning up data`,
        );
        delete this.inMemoryStore[normalizedSymbol];

        // Clear any queued messages for this symbol
        this.symbolQueues.delete(normalizedSymbol);
        this.processingQueues.delete(normalizedSymbol);
        this.resyncingSymbols.delete(normalizedSymbol); // Clear resync tracking

        // Clear validation timer
        const validationTimer = this.validationTimers.get(normalizedSymbol);
        if (validationTimer) {
          clearTimeout(validationTimer);
          this.validationTimers.delete(normalizedSymbol);
        }

        // Try to clean up metrics if they have decayed to 0
        // Don't force remove during reconnects - let them naturally decay
        this.metricsService.removeSymbolMetricsIfInactive(normalizedSymbol);
      }

      // Remove from invalid symbols blacklist to allow retry
      if (this.invalidSymbols.has(normalizedSymbol)) {
        this.invalidSymbols.delete(normalizedSymbol);
        this.logger.log(
          `Removed ${normalizedSymbol} from invalid symbols blacklist - allowing retry`,
        );
      }
    } else if (!message.success) {
      // Handle subscription failure
      const normalizedSymbol = symbol.toUpperCase();
      if (this.inMemoryStore[normalizedSymbol]) {
        this.logger.error(
          `Failed to subscribe to ${symbol}: ${JSON.stringify(message)}`,
        );

        // If it's an invalid symbol or permanent failure, remove from store
        if (
          symbol !== 'unknown' &&
          (JSON.stringify(message).includes('Invalid symbol') ||
            JSON.stringify(message).includes('Unknown symbol') ||
            JSON.stringify(message).includes('not found'))
        ) {
          this.logger.warn(
            `Removing invalid market ${normalizedSymbol} from store`,
          );
          delete this.inMemoryStore[normalizedSymbol];
          this.subscribedSymbols.delete(normalizedSymbol);
        } else {
          // Mark as error for retryable failures
          this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'error';
          this.inMemoryStore[normalizedSymbol].lastError =
            `Subscription failed: ${JSON.stringify(message).substring(0, 200)}`;
        }
      }
    }
  }

  private parseOrderBookEntries(
    entries: any[],
    rawJson?: string,
  ): OrderBookEntry[] {
    if (!entries || entries.length === 0) {
      return [];
    }

    // Pre-extract ALL exact numbers from rawJson once (not per-entry)
    // This avoids the previous per-entry regex that could match the wrong entry
    // when one price was a numeric prefix of another (e.g. "9003" matching "90038.0")
    const exactNumbersMap = rawJson
      ? this.extractAllExactNumbers(rawJson)
      : null;

    // Handle both array format [price, qty] and object format {price, qty}
    return entries.map((entry) => {
      if (Array.isArray(entry)) {
        // Old format: [price, qty]
        const [price, qty] = entry as [string, string];
        const priceStr = String(price);
        const qtyStr = String(qty);
        return {
          price: new Decimal(priceStr),
          quantity: new Decimal(qtyStr),
          originalPrice: priceStr,
          originalQty: qtyStr,
        };
      } else {
        // New format: {price, qty}
        const entryObj = entry as { price: any; qty: any };
        let priceStr = String(entryObj.price);
        let qtyStr = String(entryObj.qty);

        // CRITICAL: Look up exact representation from pre-built map to preserve trailing zeros
        // json-bigint strips trailing zeros ("0.00000000" → "0"), but Kraken's checksum
        // requires the exact string representation including trailing zeros.
        // We must normalize the lookup key the same way we normalized the map key,
        // because json-bigint may return scientific notation (e.g. "7.9e-7") while
        // the raw JSON uses decimal notation ("0.00000079").
        if (exactNumbersMap) {
          const key = `${this.normalizeNumberString(priceStr)}|${this.normalizeNumberString(qtyStr)}`;
          const exact = exactNumbersMap.get(key);
          if (exact) {
            priceStr = exact.price;
            qtyStr = exact.qty;
          } else {
            // Log when lookup fails - this might indicate a problem
            this.logger.warn(
              `Failed to find exact numbers for price=${entryObj.price}, qty=${entryObj.qty} in raw JSON map. ` +
                `Using json-bigint values which may lack trailing zeros.`,
            );
          }
        }

        return {
          price: new Decimal(priceStr),
          quantity: new Decimal(qtyStr),
          originalPrice: priceStr,
          originalQty: qtyStr,
        };
      }
    });
  }

  private applyBookDeltas(
    currentEntries: OrderBookEntry[],
    deltas: OrderBookEntry[],
  ): void {
    for (const delta of deltas) {
      // CRITICAL: All deltas MUST have original strings for accurate checksums
      // If they don't, something is wrong with parseOrderBookEntries
      if (!delta.originalPrice || !delta.originalQty) {
        this.logger.error(
          `CRITICAL: Delta missing original strings! price=${delta.price.toString()}, qty=${delta.quantity.toString()}. ` +
            `This indicates a bug in parseOrderBookEntries. SKIPPING delta to prevent corruption.`,
        );
        continue; // Skip this delta entirely rather than corrupt the orderbook
      }

      // Find existing entry by comparing price values
      // Use Decimal comparison for exact matching regardless of string representation
      const existingIndex = currentEntries.findIndex((entry) => {
        // Compare using Decimal values for precise matching
        return entry.price.equals(delta.price);
      });

      if (delta.quantity.isZero()) {
        // Remove entry
        if (existingIndex !== -1) {
          currentEntries.splice(existingIndex, 1);
        }
      } else if (existingIndex !== -1) {
        // Update existing entry - use values directly from delta (already validated)
        currentEntries[existingIndex].price = delta.price;
        currentEntries[existingIndex].quantity = delta.quantity;
        currentEntries[existingIndex].originalPrice = delta.originalPrice;
        currentEntries[existingIndex].originalQty = delta.originalQty;
      } else {
        // Add new entry - use delta directly (already validated to have original strings)
        currentEntries.push(delta);
      }
    }
  }

  private resyncMarket(symbol: string): void {
    const normalizedSymbol = symbol.toUpperCase();

    // Prevent multiple simultaneous resyncs
    if (this.resyncingSymbols.has(normalizedSymbol)) {
      this.logger.debug(
        `Already resyncing ${symbol}, skipping duplicate resync`,
      );
      return;
    }

    this.logger.log(`Resyncing market: ${symbol}`);
    this.resyncingSymbols.add(normalizedSymbol);

    // Clear the message queue for this symbol to avoid processing stale data
    const queue = this.symbolQueues.get(normalizedSymbol);
    if (queue) {
      const queueSize = queue.length;
      if (queueSize > 0) {
        this.logger.debug(
          `Clearing ${queueSize} queued messages for ${symbol} during resync`,
        );
        queue.length = 0; // Clear array
      }
    }

    // Mark market as resyncing and clear orderbook
    if (this.inMemoryStore[normalizedSymbol]) {
      this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'resyncing';
      // Clear the orderbook data to force fresh snapshot
      this.inMemoryStore[normalizedSymbol].orderbook = {
        asks: [],
        bids: [],
        spread: '0',
        midPrice: '0',
        lastUpdate: new Date().toISOString(),
      };
    }

    // Unsubscribe first (this will remove from subscribedSymbols)
    this.unsubscribeFromMarket(symbol);

    // Wait for unsubscribe to complete, then resubscribe
    setTimeout(() => {
      // Ensure it's removed from subscribedSymbols before resubscribing
      this.subscribedSymbols.delete(normalizedSymbol);
      this.subscribeToMarket(symbol);

      // Clear resyncing flag after subscription establishes
      setTimeout(() => {
        this.resyncingSymbols.delete(normalizedSymbol);
      }, 2000);
    }, 500);
  }

  /**
   * Subscribe to a market
   */
  subscribeToMarket(symbol: string): void {
    // Normalize symbol to uppercase for consistent storage
    const normalizedSymbol = symbol.toUpperCase();

    // Check if this symbol has been marked as invalid
    if (this.invalidSymbols.has(normalizedSymbol)) {
      this.logger.warn(
        `Skipping subscription to known invalid symbol: ${symbol}. Unsubscribe first to retry.`,
      );
      // Emit error to notify clients
      this.emit('marketError', {
        symbol: normalizedSymbol,
        error:
          'Symbol previously marked as invalid. Unsubscribe and try again.',
        type: 'blacklisted_symbol',
      });
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `WebSocket not connected. Queueing subscription for ${symbol}. Connection state: ${this.ws ? this.ws.readyState : 'null'}`,
      );

      // Store the symbol so we can subscribe when connection is restored
      this.subscribedSymbols.add(normalizedSymbol);

      // Initialize empty market data structure
      this.inMemoryStore[normalizedSymbol] = {
        orderbooksPerMinute: 0,
        orderbook: {
          asks: [],
          bids: [],
          spread: '0',
          midPrice: '0',
          lastUpdate: new Date().toISOString(),
        },
        subscriptionStatus: 'subscribing',
        lastError: 'WebSocket not connected - queued for retry',
      };

      return;
    }

    if (this.subscribedSymbols.has(normalizedSymbol)) {
      this.logger.debug(`Already subscribed to ${normalizedSymbol}`);
      return;
    }

    const reqId = this.reqIdCounter++;
    const subscriptionMessage: KrakenSubscriptionMessage = {
      method: 'subscribe',
      params: {
        channel: 'book',
        symbol: [symbol], // Send original symbol to Kraken API
        depth: 10, // 10 levels for most granular real-time updates
      },
      req_id: reqId,
    };

    // Track this request for error handling
    this.pendingRequests.set(reqId, {
      type: 'subscribe',
      symbol: normalizedSymbol,
    });

    this.logger.log(
      `Subscribing to market: ${symbol} (stored as ${normalizedSymbol})`,
    );
    // this.logger.debug(`Sending subscription message:`, subscriptionMessage);
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
      this.logger.debug(
        `Initialized market data store for ${normalizedSymbol}`,
      );

      // Set timeout to mark subscription as failed if no response in 10 seconds
      setTimeout(() => {
        if (
          this.inMemoryStore[normalizedSymbol]?.subscriptionStatus ===
          'subscribing'
        ) {
          this.logger.warn(
            `Subscription timeout for ${symbol} - marking as error`,
          );
          this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'error';
          this.inMemoryStore[normalizedSymbol].lastError =
            `Subscription timeout after 10 seconds`;

          // Schedule cleanup for persistently failed markets
          setTimeout(() => {
            if (
              this.inMemoryStore[normalizedSymbol]?.subscriptionStatus ===
              'error'
            ) {
              this.logger.warn(
                `Removing persistently failed market: ${normalizedSymbol}`,
              );
              delete this.inMemoryStore[normalizedSymbol];
              this.subscribedSymbols.delete(normalizedSymbol);
            }
          }, 30000); // Remove after 30 seconds of error state
        }
      }, 10000);
    }
  }

  /**
   * Unsubscribe from a market
   */
  unsubscribeFromMarket(symbol: string): void {
    // Normalize symbol to uppercase for consistent storage
    const normalizedSymbol = symbol.toUpperCase();

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

    const reqId = this.reqIdCounter++;
    const unsubscriptionMessage: KrakenSubscriptionMessage = {
      method: 'unsubscribe',
      params: {
        channel: 'book',
        symbol: [symbol], // Send original symbol to Kraken API
        depth: 10, // Must match the depth used in subscribe
      },
      req_id: reqId,
    };

    // Track this request for error handling
    this.pendingRequests.set(reqId, {
      type: 'unsubscribe',
      symbol: normalizedSymbol,
    });

    this.logger.log(
      `Unsubscribing from market: ${symbol} (stored as ${normalizedSymbol})`,
    );
    this.ws.send(JSON.stringify(unsubscriptionMessage));

    // Immediately remove from subscribed symbols to stop processing updates
    this.subscribedSymbols.delete(normalizedSymbol);

    // Remove from invalid symbols blacklist immediately to allow re-subscription
    if (this.invalidSymbols.has(normalizedSymbol)) {
      this.invalidSymbols.delete(normalizedSymbol);
      this.logger.log(
        `Removed ${normalizedSymbol} from invalid symbols blacklist during unsubscribe`,
      );
    }

    // Update subscription status immediately
    if (this.inMemoryStore[normalizedSymbol]) {
      this.inMemoryStore[normalizedSymbol].subscriptionStatus = 'unsubscribing';
    }
  }

  /**
   * Get market data for a specific symbol
   */
  getMarketData(symbol: string): MarketData | undefined {
    return this.inMemoryStore[symbol.toUpperCase()];
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

  /**
   * Manually remove a specific market from the store
   */
  removeMarket(symbol: string): void {
    const normalizedSymbol = symbol.toUpperCase();
    if (this.inMemoryStore[normalizedSymbol]) {
      this.logger.log(`Manually removing market: ${normalizedSymbol}`);
      delete this.inMemoryStore[normalizedSymbol];
      this.subscribedSymbols.delete(normalizedSymbol);
    }
  }

  /**
   * Get list of invalid symbols that have been blacklisted
   */
  getInvalidSymbols(): string[] {
    return Array.from(this.invalidSymbols);
  }

  /**
   * Clear the invalid symbols blacklist (for administrative purposes)
   */
  clearInvalidSymbols(): void {
    this.invalidSymbols.clear();
    this.logger.log('Cleared invalid symbols blacklist');
  }

  // ─── Instrument Channel ────────────────────────────────────────────────

  /**
   * Subscribe to the Kraken instrument channel.
   * This provides a snapshot of all tradeable pairs with their precisions,
   * replacing the need for the REST API /AssetPairs call.
   */
  private subscribeToInstrumentChannel(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        'Cannot subscribe to instrument channel - WebSocket not connected',
      );
      return;
    }

    const reqId = this.reqIdCounter++;
    const msg: KrakenSubscriptionMessage = {
      method: 'subscribe',
      params: {
        channel: 'instrument',
        snapshot: true,
      },
      req_id: reqId,
    };

    this.logger.log(
      'Subscribing to instrument channel for pair reference data',
    );
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Handle instrument channel snapshot and update messages.
   * Builds and maintains the available markets + precision cache.
   */
  private handleInstrumentMessage(
    type: string,
    pairs: KrakenInstrumentPair[],
  ): void {
    if (pairs.length === 0) {
      if (type === 'snapshot') {
        this.logger.warn(
          'Instrument snapshot received with no pairs — skipping',
        );
      }
      return;
    }

    if (type === 'snapshot') {
      // Full replacement
      this.instrumentPairs = pairs;
      this.logger.log(`Instrument snapshot received: ${pairs.length} pairs`);
    } else {
      // Incremental update — merge by symbol
      for (const updatedPair of pairs) {
        if (!updatedPair.symbol) continue;
        const idx = this.instrumentPairs.findIndex(
          (p) => p.symbol === updatedPair.symbol,
        );
        if (idx !== -1) {
          const merged: KrakenInstrumentPair = {
            ...this.instrumentPairs[idx],
            ...updatedPair,
          };
          this.instrumentPairs[idx] = merged;
        } else {
          this.instrumentPairs.push(updatedPair);
        }
      }
      this.logger.debug(
        `Instrument update received: ${pairs.length} pairs updated`,
      );
    }

    this.rebuildInstrumentCache();
  }

  /**
   * Rebuild the derived caches (available markets list + precision map)
   * from the raw instrument pairs array.
   */
  private rebuildInstrumentCache(): void {
    const markets: string[] = [];
    const precisions: Record<string, { price: number; volume: number }> = {};

    for (const pair of this.instrumentPairs) {
      // Only include online / tradeable pairs
      if (pair.status && pair.status !== 'online') continue;
      if (!pair.symbol) continue;

      const symbol = pair.symbol; // Already in "BASE/QUOTE" format from Kraken WS v2
      markets.push(symbol);

      const normalizedSymbol = symbol.toUpperCase();
      precisions[normalizedSymbol] = {
        price: pair.price_precision ?? 8,
        volume: pair.qty_precision ?? 8,
      };
    }

    // Add commonly used aliases (Kraken uses XBT internally for BTC)
    const commonAliases: [string, string][] = [
      ['BTC/USD', 'XBT/USD'],
      ['BTC/EUR', 'XBT/EUR'],
    ];
    for (const [alias, xbtEquivalent] of commonAliases) {
      if (!markets.includes(alias) && markets.includes(xbtEquivalent)) {
        markets.push(alias);
        precisions[alias.toUpperCase()] = precisions[
          xbtEquivalent.toUpperCase()
        ] ?? { price: 8, volume: 8 };
      }
    }

    this.cachedAvailableMarkets = markets.sort();
    this.cachedMarketPrecisions = precisions;
    this.instrumentDataReady = true;

    this.emit('instrumentDataReady');
    this.logger.log(
      `Instrument cache rebuilt: ${this.cachedAvailableMarkets.length} available markets`,
    );
  }

  /**
   * Get sorted list of all available / tradeable market symbols.
   * Populated from the instrument WS channel.
   */
  getAvailableMarkets(): string[] {
    return this.cachedAvailableMarkets;
  }

  /**
   * Get precision data for all markets (price + volume decimals).
   * Populated from the instrument WS channel.
   */
  getMarketPrecisions(): Record<string, { price: number; volume: number }> {
    return this.cachedMarketPrecisions;
  }

  /**
   * Whether the instrument snapshot has been received and the cache is ready.
   */
  isInstrumentDataReady(): boolean {
    return this.instrumentDataReady;
  }
}
