# Usage limits

Claude plans limit how much you can use in a 5-hour window and in a week. MaxPrice reads those limits from claude.ai and shows them as claude.ai reports them: it never estimates a limit from your usage.

A plan has up to three usage limits, each with how much of it you have used and when it resets:

- the **5-hour limit**;
- the **weekly limit**;
- on some plans, a model-scoped weekly limit, which caps one model for the week.

MaxPrice reads them from claude.ai about once a minute, for every [Tracked organization](organizations.md#tracked-and-excluded-organizations) whose limits can be read. With a [Hub](hubs.md), the Hub reads them for every machine.

Some plans have no 5-hour limit: claude.ai then reports only the weekly limits, and MaxPrice shows no 5-hour limit for them, saying so where it would be.

They show as meters on Live's [limit card](../desktop-client/live.md#the-limit-card), **5-hour**, **weekly** and **weekly ·** the model, and as the **5-hour limit** and **Weekly limit** rows of the Popout. With two or more Accounts tracked and a Scope of two or more Memberships, each Membership's show on its own card on Live and its own row of the Popout. The Popout shows the model-scoped weekly limit once you turn on **Show model limit in tray popout** in Settings › Claude, under the Account cards; the switch is there only when your plan has such a limit.

A usage limit covers all your work, so no filter narrows one: the Project, Model and Machine filters change cost and tokens, never a limit. Each [Membership](organizations.md#memberships) has its own limits, and MaxPrice never adds two Memberships' limits together.

## The claude.ai session key

Reading your limits takes a claude.ai session key: your own, or your Hub's while you are joined to one. With neither, the limit meters don't show and MaxPrice records no limit readings. Cost and tokens need no key. A client joined to a Hub still uses its own key whenever it has to [poll by itself](hubs.md#fallback-polling).

The key is the `sessionKey` cookie of a browser signed in to claude.ai, a value starting `sk-ant-sid01-`. To copy it, sign in at claude.ai, open the browser's developer tools, then Application (Chrome, Edge) or Storage (Firefox), Cookies, `https://claude.ai`, and copy the value of `sessionKey`. It is not Claude Code's OAuth token, which starts `sk-ant-oat`.

Each Account has its own key. In the Desktop client, choose **Connect** on the Account's card in [Settings › Claude](../desktop-client/settings.md#connecting-an-account), or **+ Add account**, paste it and choose **Connect**. The Desktop client keeps each Account's key in the system keychain. The Headless client and the Headless Hub each have a `key set` command ([client](../../../cli/README.md#maxprice-key-setlistremove), [Hub](../../../hub/README.md#the-session-key)), and the Hub tray app's console has a Claude account card, or an Accounts card once it knows several Accounts.

> [!CAUTION]
> The session key signs in to your whole claude.ai account. Don't share it, and paste it only into MaxPrice.

Each claude.ai Account reads its own limits with its own key, so the Desktop client keeps one key per Account you connect.

The key expires every few weeks. Live's limit card then reads **key expired · last known**: copy a fresh key and connect again.
