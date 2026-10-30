# Cost modes and pricing

MaxPrice puts a dollar figure on every request: what it would cost at Anthropic's API prices. On a subscription plan you don't pay that amount. It measures how much you use, in a unit that adds up across models.

## Cost modes

The cost mode decides where each request's cost comes from. Change it in Settings › Data › **Cost mode**.

| Mode          | What it does                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| **auto**      | The default. Uses the cost Claude Code recorded in its log when there is one; otherwise prices the tokens. |
| **calculate** | Always prices the tokens at the current price snapshot, and ignores any recorded cost.                     |
| **display**   | Shows only the cost Claude Code recorded, so a request with none counts as $0.                             |

Current versions of Claude Code record no cost in their logs, so on recent usage **auto** and **calculate** give the same figures, and **display** shows $0.

The mode applies to every report, [Blocks](blocks.md#blocks) included. It shows only in Settings: nothing else on screen says which mode is on. On the Headless client it is the `cost-mode` setting ([reference](../../../cli/README.md#maxprice-settings-getsetunset)).

## Where prices come from

MaxPrice prices tokens with a price snapshot: a table of each model's token prices, taken from LiteLLM's public list on GitHub. It fetches a fresh one:

- at startup, then once a day;
- when usage turns up on a model the snapshot doesn't price yet;
- when you choose **Refresh prices** in Settings › Application › Pricing.

A fetched snapshot is kept for the next launch. Every release also carries a built-in snapshot, which MaxPrice uses until a fetch succeeds, or when LiteLLM can't be reached. A failed fetch changes nothing and is retried.

The Pricing section's status line says which snapshot is in use: **Live · fetched …** for a fetched one, or **Built-in snapshot · captured …** for the built-in one, each with how many models it prices. On the Headless client, `maxprice pricing refresh` fetches it ([reference](../../../cli/README.md#maxprice-pricing-refresh)).

Every cache write is priced at LiteLLM's one rate for cache writes, the 5-minute cache's, also for writes to Claude's 1-hour cache, which Anthropic bills higher.

## Unpriced models

A model the price snapshot doesn't include is unpriced. Its calculated cost is $0, so totals that include it carry an amber **unpriced** chip, and its model badge an **unpriced** mark. Under **auto** and **display**, a cost Claude Code recorded still counts.

To fix it, choose **Refresh prices** in Settings › Application › Pricing. If the model is still unpriced, LiteLLM doesn't list it yet: a later MaxPrice update brings its price.
