/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Adapted from larksuite/openclaw-lark, src/card/builder.ts at
 * dde0be3680d6fd5443cab426c8f4b3216266346a.
 *
 * Retained: complete-card text/summary/config construction and toCardKit2.
 * Changes: removed OpenClaw types, reasoning/tool panels, metrics, and Markdown
 * rewriting; exported the text-only subset as buildTextCard. Markdown passes
 * through unchanged so chunk size and source text remain predictable.
 * The original MIT license accompanies this file as LICENSE.
 */

export interface FeishuCard {
  config: Record<string, unknown>;
  header?: Record<string, unknown>;
  elements: Record<string, unknown>[];
}

export function buildTextCard(text: string): FeishuCard {
  const summaryText = text.replace(/[*_`#>[\]()~]/g, '').trim();
  // Array.from avoids cutting a Unicode surrogate pair in the preview.
  const summary = summaryText
    ? { content: Array.from(summaryText).slice(0, 120).join('') }
    : undefined;
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      ...(summary ? { summary } : {}),
    },
    elements: [{ tag: 'markdown', content: text }],
  };
}

export function toCardKit2(card: FeishuCard): Record<string, unknown> {
  const result: Record<string, unknown> = {
    schema: '2.0',
    config: card.config,
    body: { elements: card.elements },
  };
  if (card.header) result.header = card.header;
  return result;
}
