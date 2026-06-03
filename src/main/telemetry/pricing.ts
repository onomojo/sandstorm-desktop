/** Bundled offline pricing for Claude models (estimated list price, USD per million tokens). */

interface ModelPricing {
  input: number;      // $ per million input tokens
  output: number;     // $ per million output tokens
  cacheWrite: number; // $ per million cache creation tokens
  cacheRead: number;  // $ per million cache read tokens
}

// Exact model IDs take precedence; prefix matching is used as fallback.
const PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-7':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-6':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-5':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-0':            { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6':          { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5':          { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':           { input: 0.80, output: 4,    cacheWrite: 1.00,  cacheRead: 0.08 },
  'claude-3-5-sonnet-20241022': { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-3-5-sonnet-20240620': { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output: 4,    cacheWrite: 1.00,  cacheRead: 0.08 },
  'claude-3-haiku-20240307':    { input: 0.25, output: 1.25, cacheWrite: 0.30,  cacheRead: 0.03 },
  'claude-3-sonnet-20240229':   { input: 3,    output: 15,   cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-3-opus-20240229':     { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
};

function getPricing(model: string): ModelPricing | null {
  if (PRICING_TABLE[model]) return PRICING_TABLE[model];
  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
    if (model.startsWith(key)) return pricing;
  }
  return null;
}

export interface CostResult {
  cost: number;
  unpriced: boolean;
}

export function computeCost(
  model: string,
  tokens: { input: number; output: number; cacheCreate: number; cacheRead: number }
): CostResult {
  const pricing = getPricing(model);
  if (!pricing) return { cost: 0, unpriced: true };
  const cost =
    (tokens.input * pricing.input / 1_000_000) +
    (tokens.output * pricing.output / 1_000_000) +
    (tokens.cacheCreate * pricing.cacheWrite / 1_000_000) +
    (tokens.cacheRead * pricing.cacheRead / 1_000_000);
  return { cost, unpriced: false };
}
