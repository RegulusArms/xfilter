# X Location Filter

A Brave (Chromium) extension that hides posts on x.com from accounts whose **"Account based in"** location isn't on your allow list.

It changes only what your browser shows. Nothing is posted, followed, blocked or changed on X.

It also keeps a [history of the posts you've seen](#post-history), so you can find that post you were reading before your timeline refreshed.

---

## Install in Brave

The extension isn't in the Chrome Web Store, so you load it as an **unpacked extension**.

### Option A: download the archive

1. Download the repository as a ZIP (on GitHub: **Code → Download ZIP**).
2. Extract it somewhere permanent, e.g. `~/extensions/xfilter`. Brave loads the extension from this folder every time, so don't delete or move it afterwards.
3. Continue with [Load it in Brave](#load-it-in-brave).

### Option B: git clone

```bash
git clone <repo-url> ~/extensions/xfilter
```

Continue with [Load it in Brave](#load-it-in-brave).

### Load it in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Click the puzzle-piece icon in the toolbar and pin **X Location Filter**.
5. Open or refresh x.com.

### Updating

- **Archive:** download and extract the new version over the old folder.
- **Git:** run `git pull` in the folder.

Then open `brave://extensions`, click the **reload** arrow on the X Location Filter card, and refresh any open x.com tabs. Tabs that were open before a reload won't work properly until you refresh them.

Your settings and account database are kept across updates and reloads.

---

## Using it

Click the toolbar icon to open the popup.

| Control | What it does |
|---|---|
| **On/off switch** | Turns filtering on or off. When off, every post is shown. |
| **Allowed locations** | Posts are shown only if the author's location **contains** one of these, ignoring case. E.g. `United States`, `Canada`. An empty list filters nothing. |
| **Hide accounts with no location** | Hide authors X shows no location for. |
| **Blur posts while checking** | Blur posts until their author's location is known, instead of showing them. |
| **Show location label on posts** | Adds a small 📍 label with the location to posts that are shown. |
| **Learning mode** | Shows every post (the filter is bypassed) and slows location lookups to one every 30 seconds. See [Learning mode](#learning-mode). |
| **This tab** | Live counts for the current x.com tab: hidden, shown, being checked, lookups running now, lookups made this page. Also shows whether the login token was captured and the last error. |
| **Account database** | Number of saved accounts and how many are waiting for a lookup, plus **Open**, **Export**, **Import** and **Clear**. |
| **History tab** | The posts you've recently had on screen, newest first. See [Post history](#post-history). |
| **Advanced → AboutAccountQuery ID override** | Manual override for X's lookup request ID. See [Finding the query ID](#finding-the-query-id-for-the-override). |

Because matching is by "contains", a short entry like `United` matches both United States and United Kingdom.

---

## How it works

### 1. Finding posts
A script on x.com watches the page for posts and reads each author's handle, e.g. `@bingus`.

### 2. Checking the local database first
Every account the extension has looked up is saved in a local database. If the author is already known, the post is shown or hidden immediately, with no request to X.

- Accounts with a known location are **never looked up again**.
- Accounts X showed no location for are re-checked after 7 days, when one of their posts appears again.
- Locations you set by hand are never overwritten.

### 3. Looking up new accounts
Unknown accounts are saved as **waiting for lookup**. The extension then asks X for the same data that `x.com/<user>/about` shows, using X's own internal request (`AboutAccountQuery`) and your logged-in session.

- The login token and request ID are picked up automatically from X's own traffic. No setup is needed.
- Accounts whose posts are **on screen** are looked up first, then the rest oldest first.
- Each x.com tab runs up to 2 lookups at a time. Tabs share one waiting list and never look up the same account twice.
- The waiting list survives refreshes and restarts. It keeps draining as long as **any x.com tab is open**.

### 4. Rate limits
X allows only a limited number of these lookups per 15-minute window.

- When the limit is hit, all tabs pause until X's reset time, then continue where they left off.
- The popup shows when lookups will resume.
- Posts from accounts still waiting stay blurred, or shown if blurring is off.
- Other errors are retried later with increasing delays (15 min, 30 min, 1 h … up to once a day).

**Tip:** to work through a long waiting list, keep x.com open in its own browser window, **not minimized**, with x.com as that window's active tab. It can sit behind your other windows. A minimized window or a background tab gets slowed down by the browser, and Brave's Memory Saver may put it to sleep. To prevent the sleep, add x.com under **Settings → System → Memory Saver → Always keep these sites active**.

### 5. Hiding
Hidden posts are collapsed in your browser only. Turning the filter off or changing the allow list brings them back instantly.

### Learning mode
Tick **Learning mode** in the popup's Options to build up the account database slowly in the background while you browse normally.

- **Nothing is filtered:** every post is shown and nothing is blurred, whatever your allow list says. Location labels still appear if **Show location label on posts** is on.
- **Lookups keep running, but slowly:** at most **one location lookup every 30 seconds**, counted across all x.com tabs together. Accounts you scroll past are still added to the waiting list, and ones currently on screen are looked up first.
- The popup status line shows when learning mode is on, and the database page's status column shows **off** for every account that isn't waiting for a lookup.
- Untick it to go back to normal: filtering resumes immediately and lookups run at full speed again.

The master on/off switch still wins: with the filter switched off, no lookups run in either mode.

---

## The account database

The database lives in the extension's own storage (IndexedDB), not in x.com's storage. It **stays** if you clear x.com cookies or site data. It's **removed** if you uninstall the extension, so export it first if you want to keep it.

### Viewing and editing
Click **Open** in the popup's **Account database** section to see every saved account in a table. From there you can:

- Search by handle, location or comment, and filter by status: shown, hidden, waiting, no location, edited, has comment.
- Sort by clicking a column header.
- **Edit a location:** it's marked **edited** and lookups never overwrite it. Clearing the field marks the account as having no location.
- **Add comments** to any account.
- **Add accounts** by hand. Without a location, they're queued for lookup.
- **↻ Look up again:** re-queues an account. This clears a hand-set location.
- **× Delete** an account.

Edits save when you press Enter or leave the field, and apply to open x.com tabs immediately.

### Exporting (backup)
1. Click the toolbar icon.
2. In **Account database**, click **Export**.
3. A file named `x-location-filter-YYYY-MM-DD.json` downloads to your Downloads folder.

The file is a JSON array with one object per account:

```json
{
  "handle": "bingus",
  "location": "United States",
  "checkedAt": 1790000000000,
  "firstSeen": 1789000000000,
  "comment": "",
  "manual": false
}
```

- `checkedAt` and `firstSeen` are Unix timestamps in milliseconds.
- `manual: true` means the location was set by hand.
- Accounts still waiting for a lookup also have a `queueAt` field.

### Importing
1. Click **Import** in the popup. It opens in a regular tab, because a file picker would close the popup.
2. Click **Import** again and pick a previously exported `.json` file.

Importing only adds what's missing; nothing already in the database is overwritten:
- Handles that aren't in the database are added.
- An existing account with no location yet (waiting for a lookup, or looked up with none found) takes the imported location, unless you set it by hand.
- An empty comment is filled in from the imported row.

The button then shows how many accounts were added and how many were filled in. Times can be milliseconds (this extension's export) or ISO 8601 strings.

### Viewing the raw database
1. Open `brave://extensions`.
2. On the X Location Filter card, click **service worker**.
3. In the DevTools window that opens, go to **Application → IndexedDB → `xlf` → `accounts`**.

### Clearing
**Clear** in the popup deletes every saved account, after a confirmation. Accounts will be looked up again as you browse.

---

## Post history

The **History** tab in the popup lists the posts you've recently had on screen, newest first, so you can find a post again after X refreshes your timeline.

- A post counts as seen once at least half of it has been on screen for about half a second. Posts the filter hid are never recorded; blurred ones waiting for a lookup are.
- Each entry shows the author, when you saw it, the post text, the first image and the author's location if known. Click an entry to open the post on x.com.
- Seeing a post again moves it back to the top.
- **Keep last** sets how many posts are kept: 100 by default, up to 10,000. Older ones are dropped.
- **Clear** deletes the whole history. The account database is not affected.

History is kept in its own IndexedDB database (`xlf-history`), separate from the account database, and never leaves your browser.

---

## Finding the query ID (for the override)

X gives each internal request an ID that changes from time to time. The extension finds the current one automatically in three ways:

1. From X's own traffic, whenever an about page loads.
2. By searching X's JavaScript files.
3. From a built-in fallback ID.

Use the override only if lookups keep failing with **HTTP 404** or **400** in the popup's **Last error** line. To find the ID:

1. Open x.com and press **F12** to open DevTools.
2. Go to the **Network** tab.
3. In the filter box, type `AboutAccountQuery`.
4. Visit any account's about page, e.g. `https://x.com/bingus/about`.
5. Click the `AboutAccountQuery` request that appears. Its URL looks like:
   ```
   https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=...
   ```
6. Copy the part between `/graphql/` and `/AboutAccountQuery`. That's the ID (`XRqGa7EeokUU5kppkh13EA` in this example).
7. Open the extension popup, expand **Advanced**, paste the ID into **AboutAccountQuery ID override**, and press Tab or click elsewhere to save.

To go back to automatic detection, clear the field.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| Nothing is filtered | Check that the switch is on and at least one location is allowed. Refresh x.com after reloading the extension. |
| **Auth token captured: no** | Refresh x.com and scroll a little. The token is picked up from X's own requests. Make sure you're logged in. |
| **HTTP 401** | Login token problem. Refresh x.com. If it persists, log out and back in to X. |
| **HTTP 404 / 400** | The query ID changed. Set it by hand, see [Finding the query ID](#finding-the-query-id-for-the-override). |
| **HTTP 403** | X may be requiring an anti-bot header this extension can't produce. Please open an issue. |
| **Rate limited until …** | Normal. Lookups resume automatically at that time. Known accounts keep filtering meanwhile. |
| Waiting list isn't shrinking | At least one x.com tab must be open, ideally in its own unminimized window (see the tip under [Rate limits](#4-rate-limits)). |
| Errors for individual accounts | Open the database page, filter **Waiting for lookup**, and hover an account's badge to see its last error. |

Errors are also logged in the x.com tab's DevTools console, prefixed with `[X Location Filter]`.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3). |
| `content.js` / `content.css` | Runs on x.com: finds posts, hides or blurs them, runs lookups. |
| `page-hook.js` | Runs inside the x.com page to read X's login token and query ID from its own requests (read-only). |
| `background.js` | Account database and post history (IndexedDB), and the shared lookup queue. |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup. |
| `db.html` / `db.js` / `db.css` | Account database viewer and editor. |
| `icons/` | Extension icons. |

---

## Notes

- This relies on X's **internal, undocumented** web API, which can change or break at any time.
- All data stays in your browser. The extension makes no requests on its own except X's own lookup requests, made as you.
- Collecting and storing other accounts' profile data may conflict with X's Terms of Service. Use at your own discretion.
