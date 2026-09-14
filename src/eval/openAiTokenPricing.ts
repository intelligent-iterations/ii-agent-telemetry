export interface TokenPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longContext?: {
    thresholdInputTokens: number;
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
}

export interface TokenUsageForCost {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const OPENAI_TOKEN_PRICES: Record<string, TokenPricing> = {
  "gpt-5.6": {
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 8,
      cachedInputUsdPerMillion: 0.8,
      outputUsdPerMillion: 30
    }
  },
  "gpt-5.6-sol": {
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 8,
      cachedInputUsdPerMillion: 0.8,
      outputUsdPerMillion: 30
    }
  },
  "gpt-5.6-terra": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 4,
      cachedInputUsdPerMillion: 0.4,
      outputUsdPerMillion: 18
    }
  },
  "gpt-5.6-luna": {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 0.4,
      cachedInputUsdPerMillion: 0.04,
      outputUsdPerMillion: 1.8
    }
  },
  "gpt-5.5": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 45
    }
  },
  "gpt-5.5-2026-04-23": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 45
    }
  },
  "gpt-5.4": {
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
    longContext: {
      thresholdInputTokens: 272_000,
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 22.5
    }
  },
  "gpt-5.4-mini": {
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5
  },
  "gpt-5.3-codex": {
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14
  }
};

export function estimateOpenAiTokenCostUsd(model: string, usage: TokenUsageForCost): number | null {
  const pricing = OPENAI_TOKEN_PRICES[normalizeModel(model)];
  if (!pricing) return null;
  const effectivePricing = pricing.longContext && usage.inputTokens > pricing.longContext.thresholdInputTokens
    ? pricing.longContext
    : pricing;
  const cachedInputTokens = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const freshInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  return (
    (freshInputTokens * effectivePricing.inputUsdPerMillion) +
    (cachedInputTokens * effectivePricing.cachedInputUsdPerMillion) +
    (Math.max(0, usage.outputTokens) * effectivePricing.outputUsdPerMillion)
  ) / 1_000_000;
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}
