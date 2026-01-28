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

// Subscription status message
const SubscriptionStatusSchema = z.object({
  method: z.enum(['subscribe', 'unsubscribe']),
  success: z.boolean(),
  result: z
    .object({
      symbol: z.string().optional(),
    })
    .optional(),
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

// Heartbeat message
const HeartbeatSchema = z.object({
  channel: z.literal('heartbeat'),
});

// Discriminated union of all possible messages
export const KrakenMessageSchema = z.discriminatedUnion('type', [
  ErrorMessageSchema.extend({ type: z.literal('error') }),
  SubscriptionStatusSchema.extend({ type: z.literal('subscription') }),
  BookSnapshotSchema,
  BookUpdateSchema,
  StatusUpdateSchema,
]);

// However, the actual messages don't have a top-level 'type' field in the same way
// So let's use a different approach with z.union
export const KrakenWebSocketMessageSchema = z.union([
  ErrorMessageSchema,
  SubscriptionStatusSchema,
  BookSnapshotSchema,
  BookUpdateSchema,
  StatusUpdateSchema,
  HeartbeatSchema,
]);

// Type inference
export type KrakenWebSocketMessage = z.infer<
  typeof KrakenWebSocketMessageSchema
>;
export type BookSnapshot = z.infer<typeof BookSnapshotSchema>;
export type BookUpdate = z.infer<typeof BookUpdateSchema>;
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
