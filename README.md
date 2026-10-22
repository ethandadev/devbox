# devbox

Your Mac in your pocket. A phone-first web app, served by your Mac over Tailscale, with:

- **Terminal**: real shells that keep running when your phone locks, with a key bar for esc, tab, ctrl, arrows and ^C.
- **Code**: Monaco (the editor inside VS Code) with a file browser, tabs, autosave, search across files, quick-open, format, go to line and the command palette. Also previews images and moves files between phone and Mac.
- **Git**: changes and diffs, stage, commit, push and pull, branches, history, stash.
- **Run**: your project's scripts as one-tap buttons, every dev server running on the Mac, and a built-in preview of them on your phone.
- **Screen**: see and control the Mac, logging in with your normal Mac password.

Everything loads from your Mac, never from the internet, so it works on networks where public CDNs are slow or blocked.

## Set up (once, on the Mac)

You need Node.js 18+ (`node -v`) and Tailscale signed in on both the Mac and your phone.

```sh
git clone git@github.com:ethandadev/devbox.git ~/devbox
cd ~/devbox
npm install          # slow from China? add: --registry=https://registry.npmmirror.com
npm run doctor       # checks everything and tells you what to fix
npm start
```

If the SSH clone says "Permission denied (publickey)", this Mac has no GitHub SSH key yet. Use `gh repo clone ethandadev/devbox ~/devbox` instead (after `brew install gh && gh auth login`).

`npm start` prints your phone link:

```
  devbox 2.1.0 is running
  ────────────────────────────────────────────────────────────────
  Open on your phone:
    http://ethans-macbook-pro.tail1234.ts.net:7111/
    http://100.101.102.103:7111/
  On this Mac:  http://localhost:7111/
  Screen:       Screen Sharing is on ✓
  Keep awake:   on (the Mac won't idle-sleep while devbox runs)
```

Open that link on your phone, then use Share → **Add to Home Screen** so it opens full screen like an app. If macOS asks whether `node` may accept incoming connections, click **Allow**.

**Screen Sharing:** System Settings → General → Sharing → turn on **Screen Sharing**. On the phone, log in with your Mac username and password.

**Optional:** `brew install ripgrep` makes code search much faster.

### In mainland China

github.com and registry.npmjs.org are usually blocked, so clone through a GitHub mirror and install from npmmirror:

```sh
git clone https://ghfast.top/https://github.com/ethandadev/devbox.git ~/devbox
#   or: git clone https://gh-proxy.com/https://github.com/ethandadev/devbox.git ~/devbox
cd ~/devbox
npm install --registry=https://registry.npmmirror.com
```

To route all GitHub traffic (including the in-app **Update devbox** button) through the mirror:

```sh
git config --global url."https://ghfast.top/https://github.com/".insteadOf "https://github.com/"
npm config set registry https://registry.npmmirror.com
```

### Keep it running (and start after reboots)

```sh
npm run service
```

This installs pm2 if needed and starts devbox in the background. It then prints one `sudo …` command: run that once so devbox also starts after a reboot. `pm2 logs devbox` shows your link again.

### Updating

In the app, tap the Mac name at the top left → **Update devbox**. It runs `git pull`, installs, and restarts in a terminal you can watch. By hand: `git pull && npm install && pm2 restart devbox`.

## No sign-in: how it stays private

There's no login screen. Instead:

- devbox listens **only on your Tailscale address and on the Mac itself**, never on your home Wi-Fi or the internet. Only devices signed in to your tailnet can reach it. If Tailscale connects after devbox starts, devbox notices within 15 seconds and starts listening there.
- It refuses requests that don't come from its own page. A malicious website open on your phone can't use your terminal or files, even though it's in the same browser.

To require an access code anyway, start with `DEVBOX_AUTH=1 npm start` (or set your own with `DEVBOX_TOKEN=...`).

## Tips

**Terminal**
- Tap the terminal name at the top to switch terminals, open a new one or close one.
- ⋯ menu: paste text, copy output, text size.

**Code**
- 🔍 in the tab bar: **Files** finds a file by typing part of its name (`apts` finds `src/app.ts`). **Text in files** searches inside every file in the project.
- ⋯ menu: All commands (the VS Code command palette), Format document, Go to line, Find and replace, Download to phone.
- File browser: ⋯ on a folder → **Open this folder** makes it your project. Code, Git and Run all follow the project you pick.
- If a file changes on the Mac while it's open, the editor reloads it. If you also had unsaved edits, it asks which version to keep.
- Deleted files go to the Mac's Trash.
- **Language smarts** (errors, autocomplete, hover, go to definition, rename, real colors for your own classes) come from the same language servers VS Code uses. devbox finds them on the Mac and the status bar shows their state. If one is missing, tap the status bar for a one-tap install command (for C/C++: `brew install llvm`; Python: `npm install -g pyright`; also Go, Rust, Swift, shell, Ruby, PHP, Lua, Java, Kotlin, Zig, Dart). Without a server, a built-in highlighter still colors classes and functions.
- ▶ **Run this file** picks a command by file type (Python, Node, Go, Rust, C/C++, Swift, shell and more) and runs it in its own terminal.
- ⋯ → **Preview Markdown**, **Open page in browser** (HTML), **Go to symbol**, **Problems**, **Rename symbol**.
- Folders open instantly: devbox reads the next level ahead and remembers what you opened.

**Git**
- Tap a file to see its diff, then Stage or Discard it.
- If nothing is staged, the button becomes **Commit all changes**.
- Push and pull use the Mac's own logins (SSH keys, Keychain). If a remote asks for a password, run that git command once in the terminal so the Mac remembers it.

**Run**
- Tap a script to run it in a new terminal.
- **Running on your Mac** lists every dev server. **Open** shows it in a built-in preview. Servers that only listen on `localhost` (Vite, Next and so on) are automatically shared to your phone, and only over Tailscale. The 📱/🖥 button switches the preview to desktop width.

**Screen**
- Tap to click, two-finger tap to right-click, two-finger drag to scroll, press and hold then drag to drag.
- Keyboard button to type. ⌘ ⌥ ⌃ ⇧ in the key bar apply to the next key.
- ⋯ → **Paste text on the Mac** sends text to the Mac's clipboard and presses ⌘V. It's the fastest way to type a lot.
- If macOS asks for a permission on the Mac (like "node would like to access your Documents folder"), you can answer it from here.

**Light screen (one window, few bytes)**
- On the Screen tab, switch **Live** to **Light**. Light streams one app window as a single picture that only updates when something changes. It's far lighter than full VNC on a slow network.
- ⋯ → **Choose window** lists the windows open on the Mac. Quality and size adjust to your connection; tap to click, type with the keyboard button.

**Clipboard:** tap the Mac name at the top left to copy the Mac's clipboard or send text to it.

## Settings

| Variable | Default | What it does |
|---|---|---|
| Blur at the top or a dark bar at the bottom of the Home Screen app (iOS 26.1+) | iOS reads the status-bar style only when the app is added. After updating, **delete the devbox icon and add it again** (Safari → Share → Add to Home Screen). |
| `PORT` | `7111` | Port devbox uses |
| `DEVBOX_ROOT` | your home folder | Folder the editor and git can open |
| `DEVBOX_SHELL` | your login shell | Shell for terminals |
| `DEVBOX_KEEP_AWAKE` | `1` | `0` lets the Mac sleep normally |
| `DEVBOX_AUTH` / `DEVBOX_TOKEN` | off | Require an access code |
| `HOST` | Tailscale + localhost | Force one address (e.g. `0.0.0.0`; not recommended without an access code) |
| `DEVBOX_LSP` | on | `0` turns language servers off |
| `VNC_PORT` | `5900` | Screen Sharing port |

## Troubleshooting

| You see | Fix |
|---|---|
| "Can't reach your Mac" | Check Tailscale is connected on the phone, and that the Mac is on and online. |
| Link works on the Mac but not the phone | Use the Tailscale link (not a `192.168…` address). If macOS asks whether `node` may accept incoming connections, click Allow. |
| "Port 7111 is already in use" | devbox is already running (`pm2 list`). |
| "Screen Sharing is off" | System Settings → General → Sharing → Screen Sharing. |
| "Wrong username or password" (Screen) | Use your Mac account's short name (`whoami`) and login password. Under Screen Sharing → ⓘ, check your account is allowed. |
| Push/pull says it needs to log in | Run `git push` once in the terminal so your Mac stores the login, or set up an SSH key. |
| Preview is blank | Some sites refuse to be embedded. Use the ↗ button to open it in a new tab. |

## Tests

`npm test` runs two end-to-end suites in a phone-sized browser against a scratch project and a fake Mac screen server. They cover the terminal, editor, git, run, preview, screen sharing, security and optional sign-in. The first run downloads a test browser.

Third-party code: xterm.js, Monaco Editor, noVNC (bundled in `public/vendor/novnc.js`, MPL-2.0, see `public/vendor/novnc-LICENSE.txt`).
