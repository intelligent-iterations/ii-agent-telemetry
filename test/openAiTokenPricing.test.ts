import assert from "node:assert/strict";

import { estimateOpenAiTokenCostUsd } from "../src/eval/openAiTokenPricing.js";

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null, "expected a price, got null");
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

// The Codex models actually in use must be priced. An unpriced model returns
// null, which every caller coerces to 0, so a missing entry renders as a
// confident "$0.00" spend rather than as missing data.
// 100K input stays under the 272K long-context threshold.
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-sol", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (100_000 * 4 + 100_000 * 20) / 1_000_000
);
close(
  estimateOpenAiTokenCostUsd("gpt-5.6", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (100_000 * 4 + 100_000 * 20) / 1_000_000
);
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-terra", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (100_000 * 2 + 100_000 * 12) / 1_000_000
);
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-luna", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (100_000 * 0.2 + 100_000 * 1.2) / 1_000_000
);

// Cached input is discounted, and is capped at the input token count.
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-sol", { inputTokens: 100_000, cachedInputTokens: 100_000, outputTokens: 0 }),
  (100_000 * 0.4) / 1_000_000
);

// Prompts over 272K input tokens bill at 2x input and 1.5x output for the
// whole request.
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-sol", { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (300_000 * 8 + 100_000 * 30) / 1_000_000
);
close(
  estimateOpenAiTokenCostUsd("gpt-5.6-luna", { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  (300_000 * 0.4 + 100_000 * 1.8) / 1_000_000
);

// Case is normalized, and genuinely unknown models still report null rather
// than a fabricated zero.
close(
  estimateOpenAiTokenCostUsd("GPT-5.6-SOL", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 0 }),
  (100_000 * 4) / 1_000_000
);
assert.equal(
  estimateOpenAiTokenCostUsd("not-a-real-model", { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 1_000 }),
  null
);
