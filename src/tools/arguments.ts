import { z } from "zod";

/**
 * A Woolworths SKU. It is a string upstream, but every real one looks numeric, so clients
 * routinely send a number. Accepting both and normalising to string here keeps that from
 * becoming an unhelpful validation error at the edge.
 */
export function skuArgument(description: string): z.ZodType<string> {
  return z
    .union([z.string().min(1), z.number().int().nonnegative()])
    .transform((value) => String(value))
    .describe(description);
}
