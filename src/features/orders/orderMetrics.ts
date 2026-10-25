import { z } from 'zod'

const count = z.number().int().nonnegative()
const money = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).refine(Number.isSafeInteger)
const units = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
export const orderMetricsSchema = z.object({
  generated: count, whatsappOpened: count, accepted: count, completed: count, cancelled: count, expired: count,
  corrected: count.default(0), returned: count.default(0),
  acceptedAmountCents: money, completedAmountCents: money,
  byFulfillment: z.record(z.string(), count),
  byPaymentMethod: z.array(z.object({ name: z.string(), count, amountCents: money })),
  validDeliveredByCompletionDate: count.default(0), validDeliveredCommercialCases: count.default(0), physicalDispatches: count.default(0),
  receivedReturnUnits: units.default('0'), sellableRestockedReturnUnits: units.default('0'),
})
