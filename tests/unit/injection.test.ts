import { describe, expect, it } from "vitest";
import {
  AUTO_MAX_ESTIMATED_TOKENS,
  AUTO_MAX_RECORDS,
  ENVELOPE_END,
  ENVELOPE_START,
  TRUST_RULE_TEXT,
} from "../../src/core/injection/constants.js";
import {
  buildRecallBundle,
  escapeEnvelopeMarkers,
  messagesContainEnvelopeMarker,
  renderEnvelope,
  type EnvelopeRecord,
} from "../../src/core/injection/envelope.js";
import { estimateEnvelopeTokens, estimateTokens } from "../../src/core/injection/estimator.js";
import {
  countEnvelopesInMessages,
  findUserAnchorIndex,
  injectEnvelopeIntoMessages,
} from "../../src/core/injection/inject.js";
import {
  createRequestContext,
  getActiveBundle,
  invalidateBundle,
  setActiveBundle,
} from "../../src/core/injection/request-context.js";

function record(
  partial: Partial<EnvelopeRecord> & { text: string; score: number },
): EnvelopeRecord {
  return {
    role: "user",
    occurredAt: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-a",
    entryId: "entry-a",
    contentHash: "hash-a",
    ...partial,
  };
}

describe("estimator", () => {
  it("uses ceil(UTF8/2) + overhead", () => {
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("你好")).toBe(3); // 6 bytes
    const body = "x".repeat(20);
    expect(estimateEnvelopeTokens(body)).toBe(estimateTokens(body) + 40);
  });
});

describe("envelope", () => {
  it("escapes conflict markers in record text", () => {
    const escaped = escapeEnvelopeMarkers(`before ${ENVELOPE_START} mid ${ENVELOPE_END} after`);
    expect(escaped).not.toContain(ENVELOPE_START);
    expect(escaped).not.toContain(ENVELOPE_END);
    expect(escaped).toContain("[[pi-session-recall\\:envelope\\:v1]]");
  });

  it("builds ≤4 records and ≤600 estimated tokens", () => {
    const ranked = Array.from({ length: 6 }, (_, i) =>
      record({
        sessionId: `sess-${i}`,
        entryId: `e-${i}`,
        contentHash: `h-${i}`,
        text: `authentication detail ${i} ${"word ".repeat(20)}`,
        score: 10 - i,
      }),
    );
    const bundle = buildRecallBundle("req-1", "authentication", ranked);
    expect(bundle).not.toBeNull();
    expect(bundle!.records.length).toBeLessThanOrEqual(AUTO_MAX_RECORDS);
    expect(bundle!.estimatedTokens).toBeLessThanOrEqual(AUTO_MAX_ESTIMATED_TOKENS);
    expect(bundle!.envelopeText.startsWith(ENVELOPE_START)).toBe(true);
    expect(bundle!.envelopeText.endsWith(ENVELOPE_END)).toBe(true);
    expect(bundle!.envelopeText).toContain("requestId: req-1");
  });

  it("drops oversized content until empty", () => {
    const huge = record({
      text: "x".repeat(5000),
      score: 1,
    });
    expect(buildRecallBundle("req-2", "q", [huge])).toBeNull();
  });

  it("detects existing markers in messages", () => {
    expect(
      messagesContainEnvelopeMarker([
        { role: "user", content: [{ type: "text", text: `has ${ENVELOPE_START}` }] },
      ]),
    ).toBe(true);
    expect(messagesContainEnvelopeMarker([{ role: "user", content: "clean" }])).toBe(false);
  });

  it("render includes metadata without query body in trust rule", () => {
    const text = renderEnvelope("rid", [
      record({ text: "body", score: 1, sessionId: "s1", entryId: "e1" }),
    ]);
    expect(text).toContain("sessionId: s1");
    expect(text).toContain("contentHash: hash-a");
    expect(TRUST_RULE_TEXT).not.toMatch(/body|s1|e1/);
  });
});

describe("inject", () => {
  it("appends one envelope text block at user anchor", () => {
    const prompt = "what about authentication";
    const messages = [
      { role: "assistant", content: "hi" },
      { role: "user", content: prompt },
    ];
    const out = injectEnvelopeIntoMessages(
      messages,
      prompt,
      `${ENVELOPE_START}\nok\n${ENVELOPE_END}`,
    );
    expect(out).not.toBeNull();
    expect(countEnvelopesInMessages(out!)).toBe(1);
    expect(messages[1]!.content).toBe(prompt); // 原数组不变
    const content = out![1]!.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe(prompt);
    expect(content[1]!.text).toContain(ENVELOPE_START);
  });

  it("skips when conflict marker present (fail-open)", () => {
    const prompt = "q";
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "text", text: ENVELOPE_START },
        ],
      },
    ];
    expect(injectEnvelopeIntoMessages(messages, prompt, "env")).toBeNull();
  });

  it("finds last matching user prompt", () => {
    const messages = [
      { role: "user", content: "old" },
      { role: "user", content: "new prompt" },
    ];
    expect(findUserAnchorIndex(messages, "new prompt")).toBe(1);
    expect(findUserAnchorIndex(messages, "missing")).toBe(1);
  });
});

describe("request context", () => {
  it("sets and invalidates active bundle", () => {
    const state = createRequestContext();
    const bundle = buildRecallBundle("r", "q", [record({ text: "auth", score: 2 })]);
    expect(bundle).not.toBeNull();
    setActiveBundle(state, bundle, "q");
    expect(getActiveBundle(state)?.requestId).toBe("r");
    invalidateBundle(state);
    expect(getActiveBundle(state)).toBeNull();
    expect(state.activePrompt).toBeNull();
  });
});
