# Blocks and usage limits

Claude plans limit how much you can use in a 5-hour window and in a week. MaxPrice reads those limits from claude.ai, and splits your usage into Blocks: one Block for each 5-hour window you used Claude Code in.

## Usage limits

A plan has up to three usage limits, each with how much of it you have used and when it resets:

- the **5-hour limit**;
- the **weekly limit**;
- on some plans, a model-scoped weekly limit, which caps one model for the week.

MaxPrice reads them from claude.ai about once a minute, for every [Tracked organization](organizations.md#tracked-and-excluded-organizations) whose limits can be read. With a [Hub](hubs.md), the Hub reads them for every machine.

They show as **5-hour limit used** on Live's Active block tile, **weekly limit used** on This week's tile, the **5-hour limit** and **Weekly limit** rows of the Popout, and the **5h limit** column of Blocks. In the Desktop client the model-scoped weekly limit shows only in the Popout, once you turn on **Show model limit in tray popout** in Settings › Claude account; the switch is there only when your plan has such a limit.

### The claude.ai session key

Reading your limits takes a claude.ai session key: your own, or your Hub's while you are joined to one. With neither, the limit meters don't show and MaxPrice records no limit readings, so the windows you use meanwhile are [estimated](#exact-ended-early-and-estimated-windows); windows it already recorded stay exact. Cost and tokens need no key. A client joined to a Hub still uses its own key whenever it has to [poll by itself](hubs.md#fallback-polling).

The key is the `sessionKey` cookie of a browser signed in to claude.ai, a value starting `sk-ant-sid01-`. To copy it, sign in at claude.ai, open the browser's developer tools, then Application (Chrome, Edge) or Storage (Firefox), Cookies, `https://claude.ai`, and copy the value of `sessionKey`. It is not Claude Code's OAuth token, which starts `sk-ant-oat`.

In the Desktop client, paste it into Settings › Claude account and choose **Connect**. The Desktop client keeps it in the system keychain. The Headless client and the Headless Hub each have a `key set` command ([client](../../../cli/README.md#maxprice-key-setclear), [Hub](../../../hub/README.md#the-session-key)), and the Hub tray app's console has a Claude account card.

> [!CAUTION]
> The session key signs in to your whole claude.ai account. Don't share it, and paste it only into MaxPrice.

The key expires every few weeks. Live's tiles then read **⚠ Session expired — reconnect →**: copy a fresh key and connect again.

## Blocks

A Block is one Organization's 5-hour billing period and the usage inside it. Blocks belong to the [Quota organization](organizations.md#quota-organization). Two Organizations' Blocks are never added together, because each has its own limits.

### Exact, ended early and estimated windows

Each row of Blocks carries a dot telling how its window was found:

- **Exact window:** the window claude.ai reported. It ends at the reset time MaxPrice read while you were using it, and starts five hours before.
- **Window ended early:** Anthropic reset the limits ahead of schedule, so the window ends where the next one starts, under five hours in.
- **Estimated window:** no limit readings cover that time, for example before you connected a session key. MaxPrice starts the window at the start of the hour of its first request and ends it five hours later. Its **5h limit** reads **—**.

An estimated window is MaxPrice's guess, so it can overlap an exact one beside it.

### Active block

The Active block is the window you are in now. Live's Active block tile counts down to its reset, with **to reset** under the time and the reset's clock time beside it. Once the window has reset and you have not used Claude Code since, there is no Active block until your next request.

Where the scope is All organizations, the tile reads **Active block · \<Home\>**.

### Projection

**Projected** is what the Active block will cost by its end if you keep using Claude Code at the rate you have so far: the cost so far, plus the current rate for the time left. Only the Active block has one.

### Typical block

The typical Block, shown as **typical**, is the middle token count of the finished Blocks in the Date range: half used more, half less. The Active block tile sets its token count against it, as **vs typical**.

### Burn rate

The **Burn rate** is the Active block's tokens per minute, from its first request to its last. A finished Block shows **—**.

### Gaps

When more than five hours pass between two requests, Blocks shows a **gap** row for the time between, at $0. A gap is never the Active block.

### Estimated blocks on the Active block tile

The Active block tile adds **est.** to its window when the Quota organization reports no 5-hour limit, or its limits can't be read with your key. A note under it says which: **\<Organization\> reports no 5-hour limit — blocks are estimated.** or **Limits for \<Organization\> aren't readable — blocks are estimated.**

## Blocks and the filters

A usage limit covers all your work, so Blocks span every project: the Project filter does not apply to them. The Model and Machine filters narrow each Block's tokens and cost, but its window, projection and limit stay the whole Block's. The Date range keeps the Blocks that start inside it.
