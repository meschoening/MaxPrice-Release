# Blocks and usage limits

Claude plans limit how much you can use in a 5-hour window and in a week. MaxPrice reads those limits from claude.ai, and splits your usage into Blocks: one Block for each 5-hour window you used Claude Code in.

## Usage limits

A plan has up to three usage limits, each with how much of it you have used and when it resets:

- the **5-hour limit**;
- the **weekly limit**;
- on some plans, a model-scoped weekly limit, which caps one model for the week.

MaxPrice reads them from claude.ai about once a minute, for every [Tracked organization](organizations.md#tracked-and-excluded-organizations) whose limits can be read. With a [Hub](hubs.md), the Hub reads them for every machine.

They show as **5-hour limit used** on Live's Active block tile, **weekly limit used** on This week's tile, the **5-hour limit** and **Weekly limit** rows of the Popout, and the **5h limit** column of Blocks. With two or more Accounts tracked and a Scope of two or more Memberships, each Membership's show on its own card on Live, its own row of the Popout and its own tab of Blocks. In the Desktop client the model-scoped weekly limit shows only in the Popout, once you turn on **Show model limit in tray popout** in Settings › Claude, under the Account cards; the switch is there only when your plan has such a limit.

### The claude.ai session key

Reading your limits takes a claude.ai session key: your own, or your Hub's while you are joined to one. With neither, the limit meters don't show and MaxPrice records no limit readings, so the windows you use meanwhile are [estimated](#exact-ended-early-and-estimated-windows); windows it already recorded stay exact. Cost and tokens need no key. A client joined to a Hub still uses its own key whenever it has to [poll by itself](hubs.md#fallback-polling).

The key is the `sessionKey` cookie of a browser signed in to claude.ai, a value starting `sk-ant-sid01-`. To copy it, sign in at claude.ai, open the browser's developer tools, then Application (Chrome, Edge) or Storage (Firefox), Cookies, `https://claude.ai`, and copy the value of `sessionKey`. It is not Claude Code's OAuth token, which starts `sk-ant-oat`.

Each Account has its own key. In the Desktop client, choose **Connect** on the Account's card in [Settings › Claude](../desktop-client/settings.md#connecting-an-account), or **+ Add account**, paste it and choose **Connect**. The Desktop client keeps each Account's key in the system keychain. The Headless client and the Headless Hub each have a `key set` command ([client](../../../cli/README.md#maxprice-key-setlistremove), [Hub](../../../hub/README.md#the-session-key)), and the Hub tray app's console has a Claude account card, or an Accounts card once it knows several Accounts.

> [!CAUTION]
> The session key signs in to your whole claude.ai account. Don't share it, and paste it only into MaxPrice.

Each claude.ai Account reads its own limits with its own key, so the Desktop client keeps one key per Account you connect.

The key expires every few weeks. Live's tiles then read **⚠ Session expired — reconnect →**, or **⚠ 2 Accounts need reconnecting →** when more than one key has expired: copy a fresh key and connect again.

## Blocks

A Block is one Organization's 5-hour billing period and the usage inside it. With one Account tracked, Blocks belong to [one Organization](organizations.md#whose-limits-a-page-shows), the Scope's or Home's; with two or more, to each [Membership](organizations.md#memberships), and Blocks shows a [tab for each](../desktop-client/blocks.md#a-tab-per-membership). Two Organizations' Blocks are never added together, because each has its own limits. Nor are two Accounts' Blocks in one Organization, such as two Accounts on one Team plan, used by logging in directly or through a Gateway: each Account's seat has its own limits, so each [Account](organizations.md#accounts) forms its own Blocks.

### Exact, ended early and estimated windows

Each row of Blocks carries a dot telling how its window was found:

- **Exact window:** the window claude.ai reported. It ends at the reset time MaxPrice read while you were using it, and starts five hours before.
- **Window ended early:** Anthropic reset the limits ahead of schedule, so the window ends where the next one starts, under five hours in.
- **Estimated window:** no limit readings cover that time, for example before you connected a session key. MaxPrice starts the window at the start of the hour of its first request and ends it five hours later. Its **5h limit** reads **—**.

An estimated window is MaxPrice's guess, so it can overlap an exact one beside it.

### Active block

The Active block is the window you are in now. Live's Active block tile counts down to its reset, with **to reset** under the time and the reset's clock time beside it. Once the window has reset and you have not used Claude Code since, there is no Active block until your next request.

Where two or more Accounts are tracked and the [Scope](organizations.md#the-scope) holds two or more Memberships, each Membership has its own Active block. Live shows a card per Membership in the tile's place ([the limit area](../desktop-client/live.md#the-limit-area)), the Popout heads with the most used one's, as **Active block · Northwind Labs** ([the Popout](../desktop-client/tray.md#the-popout-with-several-memberships)), and the chart's **Block** span frames the one you pick ([Spans](../desktop-client/live.md#spans)).

### Projection

**Projected** is what the Active block will cost by its end if you keep using Claude Code at the rate you have so far: the cost so far, plus the current rate for the time left. Only the Active block has one.

### Typical block

The typical Block, shown as **typical**, is the middle token count of the finished Blocks in the Date range: half used more, half less. The Active block tile sets its token count against it, as **vs typical**.

### Burn rate

The **Burn rate** is the Active block's tokens per minute, from its first request to its last. A finished Block shows **—**.

### Gaps

When more than five hours pass between two requests, Blocks shows a **gap** row for the time between, at $0. A gap is never the Active block.

### Estimated blocks on the Active block tile

The Active block tile adds **est.** to its window when the Organization whose Block it shows reports no 5-hour limit, or its limits can't be read with your key. A note under it says which: **\<Organization\> reports no 5-hour limit — blocks are estimated.** or **Limits for \<Organization\> aren't readable — blocks are estimated.**

## Blocks and the filters

A usage limit covers all your work, so Blocks span every project: the Project filter does not apply to them. The Model and Machine filters narrow each Block's tokens and cost, but its window, projection and limit stay the whole Block's. The Date range keeps the Blocks that start inside it.
