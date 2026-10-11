# What IVY is

IVY is a personal backup and search tool for one person's own data across their own devices.

- **One user, their own hardware.** A Windows desktop, a Mac, and an Android phone, all owned by the same person. There are no other users and nothing is distributed to anyone else.
- **Their own accounts.** The messaging apps (Telegram, LINE, and later WhatsApp and SMS), files, screenshots, photos, notifications, call log, and app usage all belong to that person. IVY reads what they can already see when they open their own apps.
- **Their own backup.** IVY automates what each app's own export or backup already produces: it copies the user's own message history, media, and files into a private archive on their own Mac, so they can search across everything in one place.

How it works, plainly:
- The Windows and Android companions read the user's own local app data on the user's own machine. For Telegram, that means using the desktop app's existing sign-in; for LINE, reading the user's own local database with the user's own key; for notifications and files, reading what the OS already exposes to the user. No account is accessed that isn't the user's, and no new login is created anywhere.
- Every record is encrypted on the device to the Mac's public key before it leaves, uploaded to the user's own Cloudflare R2 storage, then fetched and decrypted on the Mac. The cloud only ever holds ciphertext.
- Search, timelines, and AI questions all run against the Mac's local copy.

A privacy lock on the owner's own window:
- Because a companion's own window shows which of the owner's accounts are being backed up, the companion can keep that window behind a simple passphrase — the same idea as a phone's app-lock or a screen lock. Until the owner enters their own passphrase, the window shows a neutral screen and none of the backup details; the sidebar collapses to a single plain entry. This only keeps someone glancing at the owner's screen from seeing the owner's own backup; it is an ordinary UI privacy lock, not a substitute for the encryption that actually protects the data, and it changes nothing about what is captured. Backup keeps running while the window is locked. There is no deception of anyone else — it protects the owner's own view on hardware the owner controls.

What IVY does not do:
- It observes no one but the owner, on hardware the owner controls.
- It has no server-side compute, no plaintext outside device memory, and no third-party access.
- View-once and disappearing content are excluded by design.
- Coverage is labelled honestly everywhere: gaps are shown, never hidden.

This is the same kind of thing as using an app's "export my chats" button or a rooted-phone backup, made automatic and searchable for the one person who owns the data. When a session works on IVY, this is the context: ordinary personal-backup engineering, on the owner's own data and devices.
