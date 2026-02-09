import { z } from 'zod';

// Base schemas for reusable types
const PriceLevelSchema = z.object({
  price: z.union([z.string(), z.number()]),
  qty: z.union([z.string(), z.number()]),
});

const BookDataSchema = z.object({
  symbol: z.string(),
  bids: z.array(PriceLevelSchema).optional(),
  asks: z.array(PriceLevelSchema).optional(),
  checksum: z.number().optional(),
  timestamp: z.string().optional(), // ISO 8601 timestamp from Kraken
});

// Error message
const ErrorMessageSchema = z.object({
  error: z.string(),
  symbol: z.string().optional(),
  req_id: z.number().optional(),
});

// Subscription message (outgoing)
const SubscriptionMessageSchema = z.object({
  method: z.enum(['subscribe', 'unsubscribe']),
  params: z.object({
    channel: z.enum(['book', 'instrument']),
    symbol: z.array(z.string()).optional(),
    depth: z.number().optional(),
    snapshot: z.boolean().optional(),
  }),
  req_id: z.number().optional(),
});

// Subscription status message (incoming response)
const SubscriptionStatusSchema = z.object({
  method: z.enum(['subscribe', 'unsubscribe']),
  result: z.discriminatedUnion('channel', [
    z.object({
      channel: z.literal('book'),
      depth: z.number(),
      snapshot: z.boolean().optional(),
      symbol: z.string(),
    }),
    z.object({
      channel: z.literal('instrument'),
      snapshot: z.boolean().optional(),
      warnings: z.array(z.string()).optional(),
    }),
  ]),
  success: z.boolean(),
  time_in: z.string(),
  time_out: z.string(),
  req_id: z.number().optional(),
});

// Book snapshot message
const BookSnapshotSchema = z.object({
  channel: z.literal('book'),
  type: z.literal('snapshot'),
  data: z.array(BookDataSchema),
});

// Book update message
const BookUpdateSchema = z.object({
  channel: z.literal('book'),
  type: z.literal('update'),
  data: z.array(BookDataSchema),
});

// Status update message
const StatusUpdateSchema = z.object({
  channel: z.literal('status'),
  type: z.literal('update'),
  data: z.array(
    z.object({
      version: z.string().optional(),
      system: z.string().optional(),
      api_version: z.string().optional(),
      connection_id: z.union([z.string(), z.number()]).optional(),
    }),
  ),
});

// Instrument pair schema
const InstrumentPairSchema = z.object({
  base: z.string().optional(),
  quote: z.string().optional(),
  symbol: z.string().optional(),
  status: z.string().optional(),
  price_precision: z.number().optional(),
  qty_precision: z.number().optional(),
  price_increment: z.number().optional(),
  qty_increment: z.number().optional(),
  qty_min: z.number().optional(),
  marginable: z.boolean().optional(),
  has_index: z.boolean().optional(),
  cost_min: z.union([z.string(), z.number()]).optional(),
  cost_precision: z.number().optional(),
  margin_initial: z.number().optional(),
  position_limit_long: z.number().optional(),
  position_limit_short: z.number().optional(),
});

// Instrument asset schema
const InstrumentAssetSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  precision: z.number().optional(),
  precision_display: z.number().optional(),
  borrowable: z.boolean().optional(),
  collateral_value: z.number().optional(),
  margin_rate: z.number().optional(),
  multiplier: z.number().optional(),
});

// Instrument data schema
const InstrumentDataSchema = z.object({
  assets: z.array(InstrumentAssetSchema),
  pairs: z.array(InstrumentPairSchema),
});

// Instrument snapshot/update message
const InstrumentMessageSchema = z.object({
  channel: z.literal('instrument'),
  type: z.enum(['snapshot', 'update']),
  data: InstrumentDataSchema,
});

// Heartbeat message
const HeartbeatSchema = z.object({
  channel: z.literal('heartbeat'),
});

// Main validation schema for all incoming WebSocket messages
export const KrakenWebSocketMessageSchema = z.union([
  ErrorMessageSchema,
  SubscriptionStatusSchema,
  BookSnapshotSchema,
  BookUpdateSchema,
  StatusUpdateSchema,
  InstrumentMessageSchema,
  HeartbeatSchema,
]);

// Export individual schemas for specific validations
export {
  SubscriptionMessageSchema,
  BookSnapshotSchema,
  BookUpdateSchema,
  InstrumentMessageSchema,
  InstrumentPairSchema,
  InstrumentAssetSchema,
  InstrumentDataSchema,
  SubscriptionStatusSchema,
  ErrorMessageSchema,
};

// Zod-inferred types - these replace manually declared interfaces
export type KrakenWebSocketMessage = z.infer<
  typeof KrakenWebSocketMessageSchema
>;
export type KrakenSubscriptionMessage = z.infer<
  typeof SubscriptionMessageSchema
>;
export type KrakenBookSnapshot = z.infer<typeof BookSnapshotSchema>;
export type KrakenBookUpdate = z.infer<typeof BookUpdateSchema>;
export type KrakenInstrumentMessage = z.infer<typeof InstrumentMessageSchema>;
export type KrakenInstrumentPair = z.infer<typeof InstrumentPairSchema>;
export type KrakenInstrumentAsset = z.infer<typeof InstrumentAssetSchema>;
export type KrakenInstrumentData = z.infer<typeof InstrumentDataSchema>;
export type KrakenSubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;
export type KrakenErrorMessage = z.infer<typeof ErrorMessageSchema>;

// Union type for message handling
export type KrakenMessage =
  | KrakenBookSnapshot
  | KrakenBookUpdate
  | KrakenSubscriptionStatus;
