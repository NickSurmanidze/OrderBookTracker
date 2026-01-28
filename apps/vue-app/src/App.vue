<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';

// Configuration
const API_BASE_URL = 'http://localhost:4000';
const WS_BASE_URL = 'ws://localhost:4000';

// Types
interface OrderBookEntry {
  price: number;
  volume: number;
}

interface MarketData {
  symbol: string;
  timestamp: string;
  lastOrderbookUpdate: string;
  asks: OrderBookEntry[];
  bids: OrderBookEntry[];
  spread: string;
  midPrice: string;
  orderbookSpeed: number;
  // Optional error fields
  lastError?: string;
  subscriptionStatus?: string;
}

interface TrackedMarket {
  symbol: string;
  data: MarketData | null;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

interface MarketPrecision {
  price: number;
  volume: number;
}

// State: Markets being actively tracked and displayed in widgets
const trackedMarkets = ref<TrackedMarket[]>([]);

// State: Currently selected market in the dropdown (before adding to tracked)
const selectedMarket = ref<string>('');

// State: All available markets from Kraken API
const availableMarkets = ref<string[]>([]);

// State: Price/volume decimal precision for each market symbol
const marketPrecision = ref<Record<string, MarketPrecision>>({});

// State: Socket.IO client instance
const socket = ref<Socket | null>(null);

// State: Whether we're currently attempting to reconnect
const isReconnecting = ref<boolean>(false);

// State: Timeout handle for reconnection attempts
const reconnectTimeout = ref<number | null>(null);

// State: Search input value for the market dropdown
const searchQuery = ref<string>('');

// State: Whether the market dropdown is currently open
const isDropdownOpen = ref<boolean>(false);

// State: Markets filtered by search query in the dropdown
const searchFilteredMarkets = ref<string[]>([]);

// State: Current timestamp for calculating time since last update (updates every 100ms)
const currentTime = ref<number>(Date.now());
let timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

// Load tracked markets from URL on page load
onMounted(async () => {
  await fetchSymbolsAndPrecisions();
  loadTrackedMarketsFromURL(); // Load empty data structure for tracked markets from url get param
  refreshWsConnection();

  // Update current time every 100ms for live update counter
  timeUpdateInterval = setInterval(() => {
    currentTime.value = Date.now();
  }, 100);
});

onUnmounted(() => {
  if (reconnectTimeout.value) {
    clearTimeout(reconnectTimeout.value);
  }
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
  }
  if (socket.value) {
    socket.value.disconnect();
  }
});

const fetchSymbolsAndPrecisions = async (): Promise<void> => {
  try {
    const [marketsResponse, precisionResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/available-markets`),
      fetch(`${API_BASE_URL}/all-market-precision`),
    ]);
    const marketsData = await marketsResponse.json();
    const precisionData = await precisionResponse.json();

    availableMarkets.value = marketsData.markets;
    searchFilteredMarkets.value = marketsData.markets;
    marketPrecision.value = precisionData;
  } catch (error) {
    console.error('Failed to load available markets:', error);
  }
};

const loadTrackedMarketsFromURL = (): void => {
  const urlParams = new URLSearchParams(window.location.search);
  const marketParams = urlParams.get('markets');
  if (marketParams) {
    const marketList = marketParams
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    // Initialize tracked markets with empty data
    trackedMarkets.value = marketList.map(
      (symbol): TrackedMarket => ({
        symbol,
        data: null,
        status: 'connecting' as const,
      }),
    );

    // Note: Markets will be subscribed after WebSocket connects
    // This prevents subscribing before connection is established
  }
};

const updateMarketSymbolsInUrl = (): void => {
  const marketSymbols = trackedMarkets.value.map((m) => m.symbol);
  const url = new URL(window.location.href);
  if (marketSymbols.length > 0) {
    url.searchParams.set('markets', marketSymbols.join(','));
  } else {
    url.searchParams.delete('markets');
  }
  window.history.replaceState({}, '', url);
};

const refreshWsConnection = (): void => {
  // If connected disconnect first
  if (socket.value) {
    socket.value.disconnect();
  }

  socket.value = io(`${WS_BASE_URL}/market-data`, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });

  socket.value.on('connect', () => {
    console.log('Connected to WebSocket');
    isReconnecting.value = false;

    // Clear any pending reconnection timeout
    if (reconnectTimeout.value) {
      clearTimeout(reconnectTimeout.value);
      reconnectTimeout.value = null;
    }

    // Re-subscribe to ALL tracked markets on connection/reconnection
    // This ensures we resume data flow after backend restarts
    if (trackedMarkets.value.length > 0) {
      console.log(
        'Re-subscribing to',
        trackedMarkets.value.length,
        'markets...',
      );
      trackedMarkets.value.forEach((market) => {
        subscribeToMarket(market.symbol);
      });
    }
  });

  socket.value.on('market-data', (data: MarketData) => {
    // NOTE: commented to reduce console spam
    // console.log('Received market data:', data);
    const marketIndex = trackedMarkets.value.findIndex(
      (m) => m.symbol.toUpperCase() === data.symbol.toUpperCase(),
    );
    if (marketIndex !== -1) {
      // Replace entire object to ensure Vue reactivity
      trackedMarkets.value[marketIndex] = {
        symbol: trackedMarkets.value[marketIndex].symbol,
        data: data,
        status: 'connected' as const,
      };
    } else {
      console.log('No matching market found for:', data.symbol);
    }
  });

  socket.value.on('marketsCleared', (data: { message: string }) => {
    console.log('Markets cleared by server:', data);
    // Clear all market data and set status to connecting using proper reactivity
    trackedMarkets.value = trackedMarkets.value.map(
      (market): TrackedMarket => ({
        symbol: market.symbol,
        data: null,
        status: 'connecting' as const,
      }),
    );

    // Re-subscribe to all markets after a short delay
    setTimeout(() => {
      trackedMarkets.value.forEach((market) => {
        subscribeToMarket(market.symbol);
      });
    }, 1000);
  });

  socket.value.on(
    'marketError',
    (data: { symbol: string; error: string; type?: string }) => {
      console.log('Market error received:', data);
      // Find the market with the error and update its status
      const marketIndex = trackedMarkets.value.findIndex(
        (m) => m.symbol.toUpperCase() === data.symbol.toUpperCase(),
      );
      if (marketIndex !== -1) {
        // Replace entire object to ensure Vue reactivity
        trackedMarkets.value[marketIndex] = {
          symbol: trackedMarkets.value[marketIndex].symbol,
          data: {
            ...(trackedMarkets.value[marketIndex].data || ({} as MarketData)),
            lastError: data.error,
            subscriptionStatus: 'error',
          } as MarketData,
          status: 'error' as const,
        };

        if (data.type === 'invalid_symbol') {
          console.warn(
            `Invalid trading pair: ${trackedMarkets.value[marketIndex].symbol}. This symbol may not exist on Kraken.`,
          );
        }
      }
    },
  );

  socket.value.on('disconnect', () => {
    console.log(
      'Disconnected from WebSocket - Socket.IO will auto-reconnect...',
    );
    // Update all markets to disconnected status using proper reactivity
    trackedMarkets.value = trackedMarkets.value.map(
      (market): TrackedMarket => ({
        ...market,
        status: 'disconnected' as const,
      }),
    );

    isReconnecting.value = true;
  });

  socket.value.on('connect_error', (error: Error) => {
    console.log('WebSocket connection error:', error);
    // Update all markets to error status using proper reactivity
    trackedMarkets.value = trackedMarkets.value.map(
      (market): TrackedMarket => ({
        ...market,
        status: 'error' as const,
      }),
    );

    isReconnecting.value = true;
  });
};

const subscribeToMarket = (symbol: string): void => {
  if (socket.value && socket.value.connected) {
    console.log('Subscribing to market:', symbol);
    socket.value.emit('subscribe', { markets: [symbol] });
  }
};

const unsubscribeFromMarket = (symbol: string): void => {
  if (socket.value && socket.value.connected) {
    console.log('Unsubscribing from market:', symbol);
    socket.value.emit('unsubscribe', { markets: [symbol] });
  }
};

const trackMarket = (): void => {
  if (!selectedMarket.value) return;

  // Check if market is already tracked
  const exists = trackedMarkets.value.find(
    (m) => m.symbol === selectedMarket.value,
  );
  if (exists) return;

  // Add new market
  const newMarket: TrackedMarket = {
    symbol: selectedMarket.value,
    data: null,
    status: 'connecting' as const,
  };

  trackedMarkets.value.push(newMarket);
  subscribeToMarket(selectedMarket.value);
  updateMarketSymbolsInUrl();

  selectedMarket.value = '';
  searchQuery.value = '';
  isDropdownOpen.value = false;
};

// Searchable select functionality
const filterMarkets = (): void => {
  if (!searchQuery.value) {
    searchFilteredMarkets.value = availableMarkets.value;
  } else {
    searchFilteredMarkets.value = availableMarkets.value.filter((market) =>
      market.toUpperCase().includes(searchQuery.value.toUpperCase()),
    );
  }
};

const selectMarket = (market: string): void => {
  // Don't select if market is already tracked
  const isAlreadyTracked = trackedMarkets.value.some(
    (m) => m.symbol === market,
  );
  if (isAlreadyTracked) return;

  selectedMarket.value = market;
  searchQuery.value = market;
  isDropdownOpen.value = false;
};

const onSearchInput = (): void => {
  isDropdownOpen.value = true;
  filterMarkets();

  // If the search query exactly matches an available market, select it
  if (availableMarkets.value.includes(searchQuery.value)) {
    selectedMarket.value = searchQuery.value;
  } else {
    selectedMarket.value = '';
  }
};

const onSearchFocus = (): void => {
  isDropdownOpen.value = true;
  filterMarkets();
};

const onSearchBlur = (): void => {
  // Delay closing to allow for clicks on dropdown items
  setTimeout(() => {
    isDropdownOpen.value = false;
  }, 200);
};

const clearSelection = (): void => {
  selectedMarket.value = '';
  searchQuery.value = '';
  isDropdownOpen.value = false;
};

const removeMarket = (symbol: string): void => {
  unsubscribeFromMarket(symbol);
  trackedMarkets.value = trackedMarkets.value.filter(
    (m) => m.symbol !== symbol,
  );
  updateMarketSymbolsInUrl();
};

const formatPrice = (
  price: number | string | undefined,
  symbol: string,
): string => {
  if (!price) return '0';
  const normalizedSymbol = symbol?.toUpperCase();
  const precision = marketPrecision.value[normalizedSymbol];
  const decimals = precision?.price || 8;
  return parseFloat(String(price)).toFixed(decimals);
};

const formatVolume = (
  volume: number | string | undefined,
  symbol: string,
): string => {
  if (!volume) return '0';
  const normalizedSymbol = symbol?.toUpperCase();
  const precision = marketPrecision.value[normalizedSymbol];
  const decimals = precision?.volume || 8;
  return parseFloat(String(volume)).toFixed(decimals);
};

const formatMidPrice = (
  midPrice: number | string | undefined,
  symbol: string,
): string => {
  if (!midPrice) return '0.00';
  const normalizedSymbol = symbol?.toUpperCase();
  const precision = marketPrecision.value[normalizedSymbol];
  // Use quote precision (price precision) + 1 decimal point
  const decimals = (precision?.price || 8) + 1;
  return parseFloat(String(midPrice)).toFixed(decimals);
};

const formatSpread = (spread: string | undefined): string => {
  if (!spread) return 'n/a';

  // Spread is already calculated as percentage on the backend:
  // Formula: (Top Ask Price - Top Bid Price) / Mid Price * 100
  // If it's not tight - it's not right!
  const spreadPercentage = parseFloat(spread);

  if (isNaN(spreadPercentage)) return 'n/a';

  // Display as percentage with 6 decimal places
  return `${spreadPercentage.toFixed(6)}%`;
};

// this is time since last orderbook update was received from kraken
// Provides an extra level of insight into data freshness if there were no updates for last minute :)
const getTimeSinceUpdate = (market: TrackedMarket): string => {
  if (!market.data?.lastOrderbookUpdate) return 'N/A';

  const lastUpdate = new Date(market.data.lastOrderbookUpdate).getTime();
  const elapsed = currentTime.value - lastUpdate;

  // Show in seconds if > 1 second, otherwise milliseconds
  if (elapsed >= 1000) {
    return `${(elapsed / 1000).toFixed(1)}s`;
  }
  return `${elapsed}ms`;
};

const getTimeSinceUpdateMs = (market: TrackedMarket): number => {
  if (!market.data?.lastOrderbookUpdate) return 0;
  const lastUpdate = new Date(market.data.lastOrderbookUpdate).getTime();
  return currentTime.value - lastUpdate;
};

// Determine if data is stale based on time since last update
const getDataFreshnessStatus = (
  market: TrackedMarket,
): 'fresh' | 'stale' | 'very-stale' => {
  const elapsed = getTimeSinceUpdateMs(market);
  if (elapsed > 60000) return 'very-stale'; // > 60 seconds
  if (elapsed > 5000) return 'stale'; // > 5 seconds
  return 'fresh';
};

// Spread quality thresholds and indicators
const getSpreadStatus = (
  spread: string | undefined,
): {
  quality: 'excellent' | 'good' | 'fair' | 'wide' | 'very-wide';
  icon: string;
  label: string;
} => {
  if (!spread) return { quality: 'fair', icon: '', label: 'N/A' };

  const spreadPercentage = parseFloat(spread);
  if (isNaN(spreadPercentage))
    return { quality: 'fair', icon: '', label: 'N/A' };

  // Spread thresholds:
  // Excellent: < 0.01% - Very tight spread, highly liquid market
  // Good: 0.01% - 0.1% - Normal for liquid markets
  // Fair: 0.1% - 0.5% - Acceptable spread
  // Wide: 0.5% - 1% - Getting wide, caution advised
  // Very Wide: > 1% - Very wide spread, illiquid market

  if (spreadPercentage < 0.01) {
    return { quality: 'excellent', icon: '✓', label: 'Excellent' };
  } else if (spreadPercentage < 0.1) {
    return { quality: 'good', icon: '✓', label: 'Good' };
  } else if (spreadPercentage < 0.5) {
    return { quality: 'fair', icon: '○', label: 'Fair' };
  } else if (spreadPercentage < 1.0) {
    return { quality: 'wide', icon: '⚠', label: 'Wide' };
  } else {
    return { quality: 'very-wide', icon: '⚠', label: 'Very Wide' };
  }
};

// Orderbook speed quality indicators
const getSpeedStatus = (
  speed: number | undefined,
): {
  quality: 'very-active' | 'active' | 'normal' | 'slow' | 'very-slow';
  color: string;
  label: string;
} => {
  if (speed === undefined || speed === null) {
    return { quality: 'normal', color: '#666', label: 'Unknown' };
  }

  // Speed thresholds (orderbooks per minute):
  // Very Active: > 100 ob/min - Extremely liquid, high-frequency updates
  // Active: 50-100 ob/min - Very liquid market
  // Normal: 10-50 ob/min - Healthy update frequency
  // Slow: 1-10 ob/min - Lower liquidity
  // Very Slow: < 1 ob/min - Illiquid or stale data

  if (speed > 100) {
    return { quality: 'very-active', color: '#10b981', label: 'Very Active' };
  } else if (speed > 50) {
    return { quality: 'active', color: '#3b82f6', label: 'Active' };
  } else if (speed > 10) {
    return { quality: 'normal', color: '#999', label: 'Normal' };
  } else if (speed > 1) {
    return { quality: 'slow', color: '#f59e0b', label: 'Slow' };
  } else {
    return { quality: 'very-slow', color: '#ef4444', label: 'Very Slow' };
  }
};
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>Order Book Spread Tracker Dashboard</h1>
      <div class="connection-status">
        <div
          v-if="isReconnecting"
          class="status-indicator reconnecting"
          title="Reconnecting to server..."
        >
          🔄 Reconnecting...
        </div>
        <div
          v-else-if="socket && socket.connected"
          class="status-indicator connected"
          title="Connected to server"
        >
          🟢 Connected
        </div>
        <div
          v-else
          class="status-indicator disconnected"
          title="Disconnected from server"
        >
          🔴 Disconnected
        </div>
      </div>

      <!-- Legend -->
      <div class="legend">
        <div class="legend-section">
          <h4>Spread Quality</h4>
          <div class="legend-items">
            <div class="legend-item">
              <span class="legend-icon spread-excellent">✓</span>
              <span class="legend-label">Excellent (&lt;0.01%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon spread-good">✓</span>
              <span class="legend-label">Good (0.01-0.1%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon spread-fair">○</span>
              <span class="legend-label">Fair (0.1-0.5%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon spread-wide">⚠</span>
              <span class="legend-label">Wide (0.5-1%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon spread-very-wide">⚠</span>
              <span class="legend-label">Very Wide (&gt;1%)</span>
            </div>
          </div>
        </div>

        <div class="legend-section">
          <h4>Last update received</h4>
          <div class="legend-items">
            <div class="legend-item">
              <span class="legend-icon freshness-fresh">⬤</span>
              <span class="legend-label">Fresh (&lt;5s)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon freshness-stale">🟡</span>
              <span class="legend-label">Stale (5-60s)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon freshness-very-stale">🔴</span>
              <span class="legend-label">Very Stale (&gt;60s)</span>
            </div>
          </div>
        </div>

        <div class="legend-section">
          <h4>Update Frequency</h4>
          <div class="legend-items">
            <div class="legend-item">
              <span class="legend-icon speed-very-active">●</span>
              <span class="legend-label">Very Active (&gt;100/min)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon speed-active">●</span>
              <span class="legend-label">Active (50-100/min)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon speed-normal">●</span>
              <span class="legend-label">Normal (10-50/min)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon speed-slow">●</span>
              <span class="legend-label">Slow (1-10/min)</span>
            </div>
            <div class="legend-item">
              <span class="legend-icon speed-very-slow">●</span>
              <span class="legend-label">Very Slow (&lt;1/min)</span>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="widgets-container">
      <!-- Market Widgets -->
      <div
        v-for="market in trackedMarkets"
        :key="market.symbol"
        class="widget market-widget"
      >
        <div class="widget-header">
          <div class="widget-title-row">
            <h3>
              <a
                :href="`https://pro.kraken.com/app/trade/${market.symbol.replace('/', '-')}`"
                target="_blank"
                rel="noopener noreferrer"
                class="market-link"
                :title="`Check ${market.symbol} on Kraken`"
              >
                {{ market.symbol }}
              </a>
            </h3>
            <span
              class="update-time"
              :class="{
                stale: getDataFreshnessStatus(market) === 'stale',
                'very-stale': getDataFreshnessStatus(market) === 'very-stale',
              }"
              :title="
                getDataFreshnessStatus(market) === 'very-stale'
                  ? 'No updates for over 60 seconds - data may be stale!'
                  : getDataFreshnessStatus(market) === 'stale'
                    ? 'No updates for over 5 seconds'
                    : 'Time since last orderbook update'
              "
            >
              <span
                v-if="getDataFreshnessStatus(market) !== 'fresh'"
                class="staleness-icon"
              >
                {{
                  getDataFreshnessStatus(market) === 'very-stale' ? '🔴' : '🟡'
                }}
              </span>
              <span class="time-value">{{ getTimeSinceUpdate(market) }}</span>
            </span>
            <span
              v-if="market.data"
              class="orderbook-speed"
              :style="{
                color: getSpeedStatus(market.data.orderbookSpeed).color,
              }"
              :title="`Update Frequency: ${getSpeedStatus(market.data.orderbookSpeed).label}`"
            >
              ({{ market.data.orderbookSpeed || 0 }} ob/min)
            </span>
          </div>
          <div class="header-actions">
            <button @click="removeMarket(market.symbol)" class="close-btn">
              ×
            </button>
          </div>
        </div>

        <div class="widget-content">
          <div v-if="market.status === 'connecting'" class="status">
            Connecting...
          </div>
          <div
            v-else-if="market.status === 'disconnected'"
            class="status error"
          >
            Disconnected
          </div>
          <div v-else-if="!market.data" class="status">No data</div>
          <div v-else class="order-book">
            <div class="book-section">
              <!-- <h4>Asks</h4> -->
              <div class="book-rows">
                <div
                  v-for="ask in market.data.asks.slice().reverse()"
                  :key="`${ask.price}-${ask.volume}`"
                  class="book-row ask"
                >
                  <span class="price">{{
                    formatPrice(ask.price, market.symbol)
                  }}</span>
                  <span class="volume">{{
                    formatVolume(ask.volume, market.symbol)
                  }}</span>
                </div>
              </div>
            </div>

            <div class="price-info-row">
              <div class="mid-price">
                {{ formatMidPrice(market.data.midPrice, market.symbol) }}
              </div>
              <div
                class="spread"
                :class="`spread-${getSpreadStatus(market.data.spread).quality}`"
                :title="`Spread Quality: ${getSpreadStatus(market.data.spread).label}`"
              >
                <span class="spread-icon">{{
                  getSpreadStatus(market.data.spread).icon
                }}</span>
                <span class="spread-value">{{
                  formatSpread(market.data.spread)
                }}</span>
              </div>
            </div>

            <div class="book-section">
              <!-- <h4>Bids</h4> -->
              <div class="book-rows">
                <div
                  v-for="bid in market.data.bids"
                  :key="`${bid.price}-${bid.volume}`"
                  class="book-row bid"
                >
                  <span class="price">{{
                    formatPrice(bid.price, market.symbol)
                  }}</span>
                  <span class="volume">{{
                    formatVolume(bid.volume, market.symbol)
                  }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add Market Widget -->
      <div class="widget add-market-widget">
        <div class="widget-header">
          <h3>Track Market</h3>
        </div>

        <div class="widget-content">
          <div class="add-market-form">
            <div class="searchable-select">
              <div class="search-input-container">
                <input
                  v-model="searchQuery"
                  @input="onSearchInput"
                  @focus="onSearchFocus"
                  @blur="onSearchBlur"
                  placeholder="Type to search markets..."
                  class="search-input"
                />
                <button
                  v-if="selectedMarket"
                  @click="clearSelection"
                  class="clear-btn"
                  type="button"
                >
                  ×
                </button>
              </div>

              <div
                v-if="isDropdownOpen && searchFilteredMarkets.length > 0"
                class="dropdown"
              >
                <div
                  v-for="market in searchFilteredMarkets.slice(0, 10)"
                  :key="market"
                  @click="selectMarket(market)"
                  :class="{
                    'dropdown-item': true,
                    disabled: trackedMarkets.some((m) => m.symbol === market),
                  }"
                >
                  {{ market }}
                  <span
                    v-if="trackedMarkets.some((m) => m.symbol === market)"
                    class="already-tracked"
                  >
                    (Already tracked)
                  </span>
                </div>
              </div>

              <div
                v-if="isDropdownOpen && searchFilteredMarkets.length === 0"
                class="dropdown"
              >
                <div class="dropdown-item no-results">No markets found</div>
              </div>
            </div>

            <button
              @click="trackMarket"
              :disabled="!selectedMarket"
              class="track-btn"
            >
              Track Market
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  background-color: #1a1a1a;
  color: #e0e0e0;
}

.app {
  min-height: 100vh;
  padding: 20px;
}

.header {
  text-align: center;
  margin-bottom: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.header h1 {
  color: #fff;
  font-size: 2.5em;
  font-weight: 300;
  letter-spacing: 2px;
}

.legend {
  display: flex;
  gap: 40px;
  margin-top: 20px;
  padding: 15px 25px;
  background-color: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border: 1px solid #404040;
}

.legend-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.legend-section h4 {
  color: #999;
  font-size: 0.75em;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.legend-items {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend-icon {
  font-size: 1.2em;
  line-height: 1;
  min-width: 20px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
}

.legend-icon.spread-excellent {
  color: #10b981;
}

.legend-icon.spread-good {
  color: #3b82f6;
}

.legend-icon.spread-fair {
  color: #ffd700;
}

.legend-icon.spread-wide {
  color: #f59e0b;
}

.legend-icon.spread-very-wide {
  color: #ef4444;
}

.legend-icon.freshness-fresh {
  color: #999;
  font-size: 0.8em;
}

.legend-icon.freshness-stale {
  font-size: 1em;
}

.legend-icon.freshness-very-stale {
  font-size: 1em;
}

.legend-icon.speed-very-active {
  color: #10b981;
}

.legend-icon.speed-active {
  color: #3b82f6;
}

.legend-icon.speed-normal {
  color: #999;
}

.legend-icon.speed-slow {
  color: #f59e0b;
}

.legend-icon.speed-very-slow {
  color: #ef4444;
}

.legend-label {
  color: #ccc;
  font-size: 0.85em;
}

.widgets-container {
  display: flex;
  flex-wrap: wrap;
  gap: 30px;
  max-width: 100%;
  margin: 0 auto;
  justify-content: center;
  padding: 0 30px;
}

.widget {
  background-color: #2d2d2d;
  border: 1px solid #404040;
  border-radius: 8px;
  padding: 0;
  min-height: 400px;
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}

.widget-header {
  background-color: #333;
  padding: 15px 20px;
  border-bottom: 1px solid #404040;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-radius: 8px 8px 0 0;
}

.widget-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.widget-header h3 {
  color: #fff;
  font-size: 1.2em;
  font-weight: 500;
}

.market-link {
  color: #fff;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color 0.2s ease;
}

.market-link:hover {
  color: #007acc;
}

.update-time {
  color: #999;
  font-size: 0.85em;
  font-family: 'Courier New', monospace;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.3s ease;
}

.update-time.stale {
  color: #f59e0b;
}

.update-time.very-stale {
  color: #ef4444;
  font-weight: 600;
}

.staleness-icon {
  font-size: 1.1em;
  line-height: 1;
  transform: translateY(-1px);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.time-value {
  display: inline-block;
  min-width: 3ch;
  text-align: right;
}

.orderbook-speed {
  font-weight: 500;
  font-size: 0.85em;
  margin-left: 12px;
  margin-right: 20px;
  transition: color 0.3s ease;
}

.close-btn {
  background: none;
  border: none;
  color: #999;
  font-size: 20px;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: all 0.2s;
}

.close-btn:hover {
  background-color: #555;
  color: #fff;
}

.widget-content {
  padding: 20px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.status {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: #999;
  font-style: italic;
}

.status.error {
  color: #ff6b6b;
}

.connection-status {
  color: #999;
  font-size: 0.9em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.status-connected {
  color: #4ade80;
}

.status-disconnected {
  color: #ef4444;
}

.status-reconnecting {
  color: #f59e0b;
}

.order-book {
  flex: 1;
}

.book-section {
  margin-bottom: 12px;
}

.book-section h4 {
  color: #fff;
  margin-bottom: 10px;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.book-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.book-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
}

.book-row.ask {
  background-color: rgba(255, 107, 107, 0.1);
  border-left: 3px solid #ff6b6b;
}

.book-row.bid {
  background-color: rgba(81, 207, 102, 0.1);
  border-left: 3px solid #51cf66;
}

.price {
  font-weight: 600;
  color: #fff;
}

.volume {
  color: #999;
  font-size: 0.85em;
}

.price-info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin: 15px 0;
}

.mid-price {
  flex: 1;
  text-align: center;
  padding: 12px;
  background-color: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  color: #00bcd4;
  font-weight: 600;
  font-size: 0.9em;
}

.spread {
  flex: 1;
  text-align: center;
  padding: 12px;
  background-color: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  font-weight: 700;
  font-size: 0.9em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.3s ease;
}

/* Spread quality color coding */
.spread-excellent {
  color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.spread-good {
  color: #3b82f6;
  background-color: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.spread-fair {
  color: #ffd700;
  background-color: rgba(255, 215, 0, 0.1);
  border: 1px solid rgba(255, 215, 0, 0.3);
}

.spread-wide {
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.spread-very-wide {
  color: #ef4444;
  background-color: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  animation: subtle-pulse 3s ease-in-out infinite;
}

@keyframes subtle-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
  }
  50% {
    box-shadow: 0 0 8px 2px rgba(239, 68, 68, 0.3);
  }
}

.spread-icon {
  font-size: 1.3em;
  font-weight: bold;
  line-height: 1;
  transform: translateY(-1px);
}

.spread-value {
  font-family: 'Courier New', monospace;
}

.add-market-widget .widget-content {
  justify-content: center;
}

.add-market-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
  align-items: center;
}

/* Searchable Select Styles */
.searchable-select {
  position: relative;
  width: 100%;
}

.search-input-container {
  position: relative;
  width: 100%;
}

.search-input {
  width: 100%;
  padding: 12px 40px 12px 16px;
  background-color: #404040;
  border: 1px solid #555;
  border-radius: 6px;
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  box-sizing: border-box;
}

.search-input:focus {
  outline: none;
  border-color: #007acc;
  box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}

.search-input::placeholder {
  color: #999;
}

.clear-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #999;
  font-size: 20px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clear-btn:hover {
  background-color: #555;
  color: #fff;
}

.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background-color: #404040;
  border: 1px solid #555;
  border-top: none;
  border-radius: 0 0 6px 6px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 1000;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.dropdown-item {
  padding: 12px 16px;
  color: #fff;
  cursor: pointer;
  transition: background-color 0.2s;
  border-bottom: 1px solid #555;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dropdown-item:hover:not(.disabled):not(.no-results) {
  background-color: #555;
}

.dropdown-item.disabled {
  color: #666;
  cursor: not-allowed;
  background-color: #383838;
}

.dropdown-item.no-results {
  color: #999;
  cursor: default;
  font-style: italic;
}

.dropdown-item:last-child {
  border-bottom: none;
}

.already-tracked {
  color: #f39c12;
  font-size: 0.8em;
  font-style: italic;
}

.track-btn {
  width: 100%;
  padding: 12px 24px;
  background-color: #007acc;
  border: none;
  border-radius: 6px;
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.track-btn:hover:not(:disabled) {
  background-color: #0066aa;
}

.track-btn:disabled {
  background-color: #444;
  color: #666;
  cursor: not-allowed;
}

/* Responsive design */
@media (max-width: 768px) {
  .widgets-container {
    grid-template-columns: 1fr;
  }

  .header h1 {
    font-size: 2em;
  }
}
</style>
