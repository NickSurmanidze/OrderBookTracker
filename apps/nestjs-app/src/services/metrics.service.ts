import { Injectable, Logger } from '@nestjs/common';

interface OrderBookMetricsBucket {
  timestamp: number;
  count: number;
}

// Tracks metrics related to order book updates per symbol per minute
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
   * Check if a symbol has any active metrics (count > 0)
   */
  hasActiveMetrics(symbol: string): boolean {
    const count = this.getOrderBooksPerMinute(symbol);
    return count > 0;
  }

  /**
   * Remove all metrics for a symbol only if they have decayed to 0
   * Called periodically to clean up inactive symbols
   */
  removeSymbolMetricsIfInactive(symbol: string): boolean {
    if (!this.hasActiveMetrics(symbol)) {
      this.buckets.delete(symbol);
      this.logger.debug(`Removed inactive metrics for symbol: ${symbol}`);
      return true;
    }
    return false;
  }

  /**
   * Force remove all metrics for a symbol immediately
   * Only use when symbol is invalid or permanently removed
   */
  forceRemoveSymbolMetrics(symbol: string): void {
    this.buckets.delete(symbol);
    this.logger.debug(`Force removed metrics for symbol: ${symbol}`);
  }
}
