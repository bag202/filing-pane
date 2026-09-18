# Filing Pane

Static front end for an Outlook add-in that suggests which folder to file the
selected thread into. Three ranked folders plus a search box; nothing is moved
unless the button is pressed.

No build step, no dependencies to install. These files are served as-is.

## Files

| | |
|---|---|
| `taskpane.html` | The pane itself |
| `auth.html` | Sign-in target, opened in an Office dialog |
| `classifier.js` | Retrieval over previously-filed mail, then one LLM call to rank |
| `graph.js` | Microsoft Graph: folder tree, thread moves, example-bank storage |
| `commands.html` | Required by the add-in manifest; does nothing |
| `assets/` | Icons referenced by the manifest |

The add-in manifest is **not** here. It is uploaded to the Microsoft 365 admin
centre, not served from the web, and its URLs have to match wherever these
files end up.

## Publishing

Served files must be reachable over HTTPS at a stable address. The address is
written into the manifest and registered as a redirect URI in Entra, so moving
the files breaks the add-in until both are updated.

### A note on origins

GitHub Pages serves every project site for an account from one origin
(`<account>.github.io`), distinguished only by path. `localStorage` is scoped
per **origin**, not per path — and this page keeps cached access tokens there.

Any other Pages site under the same account can therefore read them. A custom
domain gives this page its own origin and removes the issue; without one, do
not enable Pages on other repositories in the same account.

## What is not in these files

No credentials and no mailbox data. The Entra client and tenant IDs are
present and are public identifiers by design, not secrets — what protects the
app is the redirect-URI allowlist, which cannot be changed without access to
the app registration.

The example bank — sender addresses, subject lines, folder names — lives in the
user's OneDrive behind their own token, never beside these files. The LLM API
key lives in the browser's `localStorage`, entered through the pane.

To a visitor without the user's credentials the page is inert: no bank, no
mailbox access.

## Third-party scripts

`msal-browser` is pinned to an exact version and hash-checked with Subresource
Integrity. Bumping it means recomputing the hash:

    curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A

`office.js` carries no SRI: Microsoft updates it continuously and publishes no
stable hash, so pinning one would break the add-in on their next release.
