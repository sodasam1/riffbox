# Phone upload: the Outbox Shortcuts (iPhone)

**What you get:** in Voice Memos, tap *Share* then *Send to Riffbox*. Two taps and no website. If the upload
cannot happen right then (no signal, server restarting), the memo waits in an **Outbox** folder on your phone and
goes up the next time you share another memo or run *Flush Riffbox Outbox*. A memo is only removed from the Outbox
after the server has confirmed it.

**Honest status:** the server side is built and tested here. The Shortcuts themselves can only be built and tried on
your phone, and I cannot run Shortcuts from my side. The action names below are from memory of the Shortcuts app
(iOS 17/18); where the wording on your screen differs a little, pick the closest action. Anything I am unsure of is
marked **(check)**. Do the steps in order; each part has a CHECK.

**Needs:** the app deployed with this change (a routine deploy), an iPhone, and the upload token.

## 0. The upload token
The token is the `RIFFBOX_UPLOAD_TOKEN` line in `/etc/riffbox.conf` on the server. It can only *add* recordings: it
cannot read, change or delete anything.
```sh
doas grep RIFFBOX_UPLOAD_TOKEN /etc/riffbox.conf
```
Copy the long value after the `=`. Get it onto the phone by a private route (a locked note in Notes, or AirDrop to
yourself from a Mac; not email). You will paste it **once**, into the Flush shortcut. Delete the note afterwards.

If you ever lose the phone: change that line in `/etc/riffbox.conf`, `doas rcctl restart riffbox`, and paste the new
value into the one place below. Nothing else changes.

## 1. Check the token works (2 minutes)
In the Shortcuts app, make a new shortcut called **Riffbox token test** with these actions:
1. **Get Contents of URL**: URL `https://sanjaysubramanian.com/ideas/api/token-check`; tap *Show More*; Method `GET`;
   Headers: add one, key `Authorization`, value `Bearer ` followed by your token (the word Bearer, a space, the token).
2. **Get Dictionary Value**: get the value for `message` in the result of step 1.
3. **Show Result** (or *Show Notification*) of that value.

Run it. CHECK: it says `Riffbox: the upload token works.` If it says `not allowed`, the token is wrong or has a stray
space. If it errors with no reply, the phone cannot reach the server (try the site in Safari).

## 2. Make the Outbox folder
In the **Files** app, under *On My iPhone* (or iCloud Drive), make a folder named **Riffbox Outbox**.
(*On My iPhone* keeps the memos off iCloud; either works. Use the same one everywhere below.)

## 3. The shortcut that uploads: "Flush Riffbox Outbox"
New shortcut, name it exactly **Flush Riffbox Outbox**:
1. **Get Contents of Folder**: the folder *Riffbox Outbox* (choose it with the folder picker).
2. **Repeat with Each** item from step 1, and inside the loop:
   1. **Get Contents of URL**: URL `https://sanjaysubramanian.com/ideas/api/upload`; Method `POST`; Headers: key
      `Authorization`, value `Bearer ` + your token (paste it here, the only place it lives). *Request Body*: `Form`,
      with two fields:
      - type **File**, key `file`, value: *Repeat Item*
      - type **Text**, key `title`, value: the **Name** of *Repeat Item* (the server drops a trailing `.m4a` itself)
   2. **Get Dictionary Value**: get the **Value** for `id` in **Contents of URL** (choose that variable as the
      input; the default is the previous action).
   3. **Set Variable**: name it `replyId`, value: that **Dictionary Value**.
   4. **Get Dictionary Value**: get the **Value** for `message` in **Contents of URL** (again choose *Contents of URL*
      as the input).
   5. **Set Variable**: name it `replyMessage`, value: that **Dictionary Value**. (The two Dictionary Value outputs
      look identical in the variable list, so the named variables keep them apart.)
   6. **If**: set its input to the variable **replyId** (not the default, which would now be the message, and every
      reply has a message, including errors). Condition: *has any value*.
      - **Show Notification**: **replyMessage** (it reads *Uploaded "Idea, Nov 8 3:42pm" to the Riffbox Inbox.* or
        *Already in Riffbox as ...*).
      - **Delete Files**: *Repeat Item*; turn *Delete Immediately* on, or the file goes to Recently Deleted. **(check)**
   7. **Otherwise**: **Show Notification**: **replyMessage** (or the text `Riffbox: no reply`). Do not delete the file.
   8. **End If**, then **End Repeat**.

Why the `id` test: Shortcuts cannot easily read the HTTP status, but the server only includes `id` when it has the
recording (a new one or one it already had). Anything else leaves the file in the Outbox.

CHECK (before any sharing): put one small memo into *Riffbox Outbox* by hand (Files app), run **Flush Riffbox Outbox**.
Expect a notification *Uploaded ...*, the file gone from the Outbox, and the recording in the Riffbox **Inbox**.
Run it again with the same memo: expect *Already in Riffbox as ...* (nothing doubled).

## 4. The shortcut you use: "Send to Riffbox"
New shortcut, name it **Send to Riffbox**. In its settings (the *i* button): turn on **Show in Share Sheet** and
under accepted types keep **Audio** and **Files** (untick the rest). **(check)**: confirm it appears when sharing
from Voice Memos.

Actions:
1. **Date** (*Current Date*), then **Format Date**: *Date Format* `Custom`, format string `MMM d h:mm`
   → this makes `Nov 8 3:42`.
2. **Date** (*Current Date*), then **Format Date**: custom format string `a`, then **Change Case** → `lowercase`
   → `pm`.
3. **Text**: `Idea, ` then the first result, then the second result, with no space between them → `Idea, Nov 8 3:42pm`.
   (This is the same name the website gives a memo uploaded at that moment. The `am`/`pm` wording follows your phone's
   language setting.)
4. **Rename File**: *Shortcut Input* to the **Text** from step 3. **(check)**: some versions keep the old extension
   and some drop it; both work, the server identifies the audio by its content.
5. **Save File**: the renamed file to the folder *Riffbox Outbox*; turn **Ask Where to Save** off.
6. **Run Shortcut**: **Flush Riffbox Outbox**.

The date is read at the moment you share, and the name is stored in the saved file. A memo that sits in the Outbox
for a day therefore still gets its own, correct name when it finally uploads.

Add it to your favourites in the share sheet (scroll to the bottom of the share sheet, *Edit Actions*, add *Send to
Riffbox* to *Favorites*) so it sits near the top.

## 5. Control Center (iOS 18)
- To flush by hand: Control Center, press the **+** (add a control), add the **Shortcuts** control and choose
  **Flush Riffbox Outbox**. Apple describes this in [What's new in Shortcuts for iOS 18](https://support.apple.com/121131).
- To start a recording: the **Voice Memos** control, if your iOS offers it in the control list. **(check)**

## 6. The phone test (do all of these once)
| Try | Expect |
|---|---|
| Record a short memo, Share, **Send to Riffbox** | a notification *Uploaded ...*; the memo is in the Inbox; the Outbox folder is empty |
| Share the same memo again | *Already in Riffbox as ...*; no second copy |
| Airplane mode on, share a memo | an error or *no reply*; the memo is still in the Outbox |
| Airplane mode off, run **Flush Riffbox Outbox** | it uploads, with the name it got when you shared it |
| A longer memo (a few minutes, Lossless quality) | uploads; if it fails, note the length and tell me |
| Lock the phone right after tapping the shortcut | tell me what happened; the Outbox keeps the memo either way |

## If Shortcuts cannot upload files at all
Some people report file uploads from Shortcuts misbehaving (the *Form* body is reported to work, the *File* body
less so). If step 3 fails in a way you cannot fix: **keep the Outbox half**. Change *Send to Riffbox* to end after
**Save File**. Then to upload: open Riffbox, press *choose files*, open the *Riffbox Outbox* folder, select all of
the memos at once, and upload them in one go (the uploader takes many files at a time). It is still two taps per
memo plus one batch. Tell me what the failure looks like and I will adjust the server (there is a base64 variant I
can add).

## What the server does for this
- The reply to an upload always carries a `message` you can show (*Uploaded ...*, *Already in Riffbox ...*, or the reason).
- A file whose name lost its extension is identified from its content (m4a, wav, mp3, flac, ogg, caf, aiff, aac).
  Text and other non-audio files are still refused.
- Uploading the same audio twice never makes two recordings, so a retry is always safe.
- `GET /api/token-check` (token or login) answers *the upload token works*; it is only for step 1.
