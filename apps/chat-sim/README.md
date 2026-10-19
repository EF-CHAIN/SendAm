# Chat simulator

From the repository root, run `npm run dev:chat-sim` to start Expo, or
`npm test --workspace=apps/chat-sim -- --runInBand` for the simulator tests.
The app uses Expo SDK 57; use its supported Node version (22.13 or newer).

## Emoji picker

After starting a chat, select the smiley beside the message input. Browse the
**Smileys**, **Currency**, and **Flags** tabs, or search the entire built-in
catalogue by name, keyword, or symbol. Selecting a tab clears the search.
The catalogue includes payment symbols such as ₦ and $, money emojis, and
flags including 🇳🇬, 🇬🇭, and 🇰🇪. It needs no network request or picker package.

Selecting an item inserts it at the message cursor, replacing selected text,
and returns focus to the message with the cursor after the inserted symbol.
Searching does not change the draft or its saved selection. Close the picker
with its close button, the smiley, an outside press, Escape on web, or Android
Back. Dismissing it preserves the draft. Sending or switching accounts closes
it, and the trigger is disabled while a message is being sent.

The popover sits above the composer and scrolls within the available height,
including when the on-screen keyboard reduces the chat area. Controls have
accessible names, selected/expanded states, and 44-point touch targets.

For a manual check, type `send 5 to `, place the cursor after `send `, open the
picker, search for `nigeria`, and select the flag. Confirm the surrounding text
is preserved and further typing starts immediately after the flag. Also try
replacing a selection, selecting a currency symbol, an unmatched search, and
dismissing without inserting anything. Simulator messages use the existing
`EXPO_PUBLIC_API_BASE_URL` configuration; this feature adds no environment variables.
