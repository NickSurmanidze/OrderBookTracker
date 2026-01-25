import { Injectable, Logger } from '@nestjs/common';

interface OrderBookMetricsBucket {
  timestamp: number;
  count: number;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly buckets = new Map<string, OrderBookMetricsBucket[]>();
  private readonly BUCKET_SIZE_MS = 1000; // 1 second
  private readonly WINDOW_SIZE_MS = 60 * 1000; // 60 seconds

  /**
   * Increment the order book update count for a symbol
   */
  incrementOrderBookCount(symbol: string): void {
    const now = Date.now();
    const bucketIndex = Math.floor(now / this.BUCKET_SIZE_MS);

    if (!this.buckets.has(symbol)) {
      this.buckets.set(symbol, []);
    }

    const symbolBuckets = this.buckets.get(symbol)!;

    // Find or create the current bucket
    let currentBucket = symbolBuckets.find(
      (b) => Math.floor(b.timestamp / this.BUCKET_SIZE_MS) === bucketIndex,
    );
    if (!currentBucket) {
      currentBucket = { timestamp: now, count: 0 };
      symbolBuckets.push(currentBucket);
    }

    currentBucket.count++;

    // Clean up old buckets
    this.cleanupOldBuckets(symbol);
  }

  /**
   * Get the rolling order books per minute count
   */
  getOrderBooksPerMinute(symbol: string): number {
    this.cleanupOldBuckets(symbol);

    const symbolBuckets = this.buckets.get(symbol);
    if (!symbolBuckets) {
      return 0;
    }

    return symbolBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
  }

  /**
   * Clean up buckets older than the window size
   */
  private cleanupOldBuckets(symbol: string): void {
    const now = Date.now();
    const cutoff = now - this.WINDOW_SIZE_MS;

    const symbolBuckets = this.buckets.get(symbol);
    if (!symbolBuckets) {
      return;
    }

    // Remove buckets older than the window
    const validBuckets = symbolBuckets.filter(
      (bucket) => bucket.timestamp > cutoff,
    );
    this.buckets.set(symbol, validBuckets);
  }

  /**
   * Remove all metrics for a symbol
   */
  removeSymbolMetrics(symbol: string): void {
    this.buckets.delete(symbol);
    this.logger.debug(`Removed metrics for symbol: ${symbol}`);
  }

  /**
   * Get all tracked symbols
   */
  getTrackedSymbols(): string[] {
    return Array.from(this.buckets.keys());
  }
}
