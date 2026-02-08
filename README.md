# Order Book Spread Tracker

This application displays real-time order book information for multiple Kraken markets.
It allows users to monitor basic market health metrics such as spread and orderbook update speed. Useful for scanning identifying markets with wide spreads where High-Frequency trading bots could be deployed.

## Overview

The system consists of:

- Backend (NestJS)
  Connects to the Kraken WebSocket API, maintains local order book state, computes derived metrics, and streams updates to clients.
- Frontend (Vue 3)
  Displays real-time data and allows users to select which markets to track.

A backend layer is used to centralize exchange connectivity and to control the rate at which updates are sent to the UI.

## Running the application locally

Prerequisites:

- Node.js 18+
- pnpm

Steps:

1. Install dependencies: `pnpm i`
2. Start the application: `pnpm dev`
3. Open in browser: `http://localhost:3000`

NOTE: If the frontend starts before the backend is up and running, you might need to refresh the page.

## How it works

### Frontend

- The frontend opens a single WebSocket connection to the backend.
- Users can dynamically add or remove markets to track.

Each market widget displays:

- Top 3 bids and asks
- Mid-price
- Spread (percentage)
- Order book update speed (ob updates over last 60 seconds)
- Supported markets and rounding precision are fetched from a backend REST endpoint.
- Time since last orderbook update.

### Backend

- The backend keeps an in-memory registry of markets requested by at least one connected client.
- A market is subscribed to on Kraken only if it has active frontend subscribers.
- When no clients remain, the market is unsubscribed.
- If local cache gets out of sync we re-sync immediately so the front-end always gets correct data.

### Order book processing

For each market:

- An initial snapshot is received from Kraken.
- Incremental updates are applied sequentially to the local snapshot.
- A checksum is computed and validated to detect inconsistencies.
- If invalid state is detected (e.g. negative spread, checksum mismatch), the local order book is discarded and resynchronized.
- Incoming Kraken messages are queued per market and processed sequentially.
- Updates sent to frontend clients are throttled to limit re-rendering frequency.

### Order book speed

- Update speed is computed as a rolling count of order book updates over the last 60 seconds.
- This metric is used to detect inactive or stalled markets.

### Potential improvements

- In order to support multiple exchanges in the future, would be better to have exchange-agnostic internal data structure and adapters for each supported exchange, kind of like CCXT or just go with CCXT-PRO which has WS support.
- WS connection redundancy - sometimes exchange would disconnect the WS connection. We are reconnecting automatically but to avoid having delays and gaps in the data caused by the reconnection we could have parallel ws connections, one of which will be always acting as a backup while we reconnect the broken one. This would lead to less downtime. But would be an overkill for this tool.
