# Order Book Spread Tracker

This application displays real-time order book information for multiple Kraken markets.
It allows users to monitor basic market health metrics such as spread and update speed.

## Overview

The system consists of:
• Backend (NestJS)
Connects to the Kraken WebSocket API, maintains local order book state, computes derived metrics, and streams updates to clients.
• Frontend (Vue 3)
Displays real-time data and allows users to select which markets to track.

A backend layer is used to centralize exchange connectivity and to control the rate at which updates are sent to the UI.

## Running the application locally

Prerequisites
• Node.js (LTS)
• pnpm

Steps 1. Install dependencies
`pnpm install `

2. Start the application
   `pnpm dev `

3. Open in browser
   `http://localhost:3000`

If the frontend starts before the backend WebSocket server is ready, a browser refresh may be required.

## How it works

## Frontend

    •	The frontend opens a single WebSocket connection to the backend.
    •	Users can dynamically add or remove markets to track.
    •	Each market widget displays:
    •	Top 3 bids and asks
    •	Mid-price
    •	Spread (percentage)
    •	Order book update speed (ob updates over last 60 seconds)
    •	Supported markets and rounding precision are fetched from a backend REST endpoint.
    •	Time since last orderbook update.

## Backend

    •	The backend keeps an in-memory registry of markets requested by at least one connected client.
    •	A market is subscribed to on Kraken only if it has active frontend subscribers.
    •	When no clients remain, the market is unsubscribed.
    •	If local cache gets out of sync we re-sync immediately so the front-end always gets correct data.

## Order book processing

    •	For each market:
    •	An initial snapshot is received from Kraken.
    •	Incremental updates are applied sequentially to the local snapshot.
    •	A checksum is computed and validated to detect inconsistencies.
    •	If invalid state is detected (e.g. negative spread, checksum mismatch), the local order book is discarded and resynchronized.

## date handling

    •	Incoming Kraken messages are queued per market and processed sequentially.
    •	Updates sent to frontend clients are throttled to limit re-rendering frequency.

## Order book speed

    •	Update speed is computed as a rolling count of order book updates over the last 60 seconds.
    •	This metric is used to detect inactive or stalled markets.
