# Mac manual testing guide

This guide is for the Mac build on `feature/macbook`, synced with `origin/main` through `7f4d9fe`. It separates implemented code from behavior that needs your Mac, account, permissions and real applications. Automated tests use synthetic images, fake native input and mocked providers; they do not prove that macOS delivered a click or that an actual browser exposes the expected accessibility controls.

## 1. Open the correct app

1. Quit an older Neb instance. Open `desktop/src-tauri/target/debug/bundle/macos/Neb.app` from this repository.
2. Keep the notebook/API preview running if this is a local development build. Its configured web origin and your existing environment files determine which server/account it uses.
3. Sign in through the browser, return to Neb and confirm that the notebook loads. Quit/reopen once to check the remembered account.
4. Use the menu-bar icon → **Screen Coach settings…**. Read the privacy notice, enable **Allow visible Mac overlays** and **Enable Screen Coach**, then save.
5. In macOS **System Settings → Privacy & Security**, grant Neb **Screen & System Audio Recording** and **Accessibility**. Voice needs **Microphone** permission. Chrome/Brave and music-player scripting need **Automation** permission. If macOS requires a restart after changing permission, quit and reopen Neb.
6. Use ordinary, disposable test documents. Keep payments, real messages, passwords and important files out of the first test session.

These are macOS permission dialogs; enter any OS password yourself. Never paste it into Neb, a notebook, an API key field or this chat.

## 2. Shortcuts and native tools

| Action                     | Mac shortcut or control                                         | Expected result                                        |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Open/summon the notebook   | **Control + Shift + N**                                         | Neb comes forward once per press.                      |
| Show/hide the island       | **Control + Shift + I**, or menu-bar **Show or hide Neb tools** | The floating tools toggle without repeated flickering. |
| Ask about the screen       | Hold **Control + Shift + Space**, speak, then release           | Listening finishes and the question is submitted once. |
| Voice without the shortcut | Click the island microphone, speak, click again                 | Same native question flow.                             |
| Cancel                     | **Escape**, or menu-bar **Stop all screen tasks**               | Pending output/input stops and overlays close.         |
| Circle card save           | **Command + S**                                                 | Opens the clip save flow.                              |
| Circle destination         | **Command + D**                                                 | Opens the notebook destination picker.                 |
| Circle steps               | Arrows, Space, Enter, or visible buttons                        | Next/repeat, pause/resume and ask work as shown.       |

Settings report if a fixed shortcut could not be registered. Use its button/menu alternative in that case. Test the physical keys from another app; simulated keyboard tests cannot establish global-shortcut delivery.

Open the island, change its shape while Select is already active, and verify the next selection uses the new shape. Test Pen, Eraser and Clear. Switch windows/apps/displays while drawing: old annotations must not follow onto an unrelated document. Close/hide must release the mouse so your normal apps remain usable.

## 3. Screen questions and privacy

Start in TextEdit, Preview, Pages/Numbers/Keynote, Word/Excel/PowerPoint, or a verified normal Chrome/Brave window. The positive native producer/role checks intentionally refuse unknown layouts and unknown/private browser state.

1. Ask “What does this paragraph mean?” The capture indicator must appear before pixels are acquired. Expect speech/captions and, where appropriate, tutor ink.
2. Ask “Show that again.” The same explanation should be placed against a fresh capture; it must not invent a new explanation or reuse old pixels after the content moved.
3. Scroll/edit/switch the source while a reply is pending. Stale ink must not be drawn over the changed content. Move/resize the window and test on a Retina display and a display to the left of the main screen.
4. Put synthetic test strings in a document: a test card number, an obvious fake API key and an OTP-looking code with its context. Save only if the preview shows the expected redaction. Enable email/phone redaction separately and repeat with invented details.
5. Try a blocked app, a password field, a private Chrome/Brave window and an unsupported browser. Expect refusal, not a guessed safe state.
6. Start a known call/recording app or use another microphone source with **Pause during detected microphone use or known calls** on. Expect capture refusal. The detector is deliberately limited; it does not prove that every possible screen share is absent.
7. Change account, pause, disable Screen Coach or press Escape while a reply is pending. No old answer, caption or native input should appear afterward.
8. Test display scope with another window on top of the target. Non-target/occluding areas are blacked out; Mac display scope is a conservative composition of the authorized window, not permission to read every app on the display.

## 4. Circle & Ask, saving and notebook readback

1. Select a region with freehand, rectangle and ellipse shapes. The card should show on its **first** opening.
2. Type a question; then test the microphone and **read the question**. If multiple questions are found, choose one. Check that only the intended selected region is discussed.
3. Follow an explanation through Next, Repeat, Pause, Resume and Stop. Check captions and spoken-step timing. Ask a follow-up without selecting the screen again.
4. Change the save preference through **Ask**, **Never** and **Auto**. Auto should show its five-second Undo period; Undo must prevent saving that pending explanation.
5. Use Save/Command+S. Inspect the memory-only preview, adjust its crop, include/exclude notes and source link, then save. The notebook should receive the saved clip/entry and render its image, ink and explanation.
6. Ask “Save this” after a normal tutor answer, including after waiting for its renderer and after the old capture has become stale. Neb should re-place the old ink on a fresh authorized capture when needed.
7. Ask “Save this to [an existing notebook/chapter].” Check the resolved destination. For an ambiguous name, choose explicitly; for a missing chapter, creation needs confirmation.
8. Check a normal Chrome/Brave source link. It must point to the intended page with unnecessary query/fragment data removed. Unknown/unavailable title/link metadata is omitted.
9. Leave a preview open past its expiry, then try Save. It must refuse. Cancel a preview, change account and start a new selection: old images and text must not reappear.

## 5. Notes, guided learning, quizzes and Watch

| Workflow                 | Try                                                     | Expected result                                                                           |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Notes Check              | “Check my notes”; “Check all my notes”                  | Redacted text is compared with your own notes; findings and notebook links work.          |
| Walkthrough              | “Teach me how to …”                                     | Coach pill, steps and relevant arrows appear.                                             |
| Steering                 | “Done”, “I’m stuck”, “yes”, “no”, pause/resume/stop     | The current step changes correctly; stale replies do not resurrect a stopped session.     |
| Resume/recheck           | “Continue where we left off”; “Let me try … on my own”  | Existing server walkthrough/skill state is reused.                                        |
| Completion               | Finish a walkthrough                                    | Finished pill remains visible until you close it.                                         |
| Quiz                     | “Quiz me on this”                                       | Choice and typed/spoken answers, grading, skip, stop and saved review cards work.         |
| Quiz command-like answer | Answer a question with “save this” or “show that again” | It is graded as an answer, not executed as a command.                                     |
| Watch                    | Island or menu-bar Watch control                        | Changed content is checked about every six seconds; identical content is not re-uploaded. |
| Help modes               | Quiet, Hint, Coach, Answer                              | Responses follow the selected level.                                                      |

Watch should suppress itself during other screen tasks and stop after 45 minutes or repeated failures. Pause/account changes must stop it immediately. Test missing network/provider keys as a refusal/error case, then repeat with your real configuration.

## 6. Hand, SHOW ME, DO IT and CATCH ME

Enable **Let Neb click and type** only when ready to test native input. Start in a disposable supported document.

- Ask for a short insertion/rewrite, a normal click, a double-click, scrolling and a safe navigation shortcut. Check Unicode and multiline text. Move focus or press Escape partway through: further input must stop. Check that no modifier or mouse button remains held.
- Ask to activate a sensitive control such as Share/Delete/Sign In. Neb should leave that final action to you. Terminals/system windows and protected fields are not Hand typing destinations.
- In a normal verified Chrome/Brave window, test a harmless document/web control and a normal text field. Private/unknown state must refuse. Executable/local browser URI schemes must not be typed/submitted by the agent.
- Ask **SHOW ME** how to find a control. Follow its path, intentionally head toward a wrong control, then retry. Test a changed layout, missing target, voice corrections and different guidance levels.
- Test each **DO IT** chore: find a disposable file; save a recipe from a supported page; preview/confirm renaming two disposable photos by date; open an allowlisted system settings page. Test **Undo rename**, cancellation and a destination filename collision. No existing file may be overwritten.
- After a chore, inspect the replay and try “show me how.” Confirm the result in Finder/notebook/System Settings rather than relying on the spoken success message.
- Read and enable the separate **CATCH ME** notice. Test reply-all, attachment mention without attachment, unsaved work, deleting selected files/folders and a risky terminal line in **unblocked supported test apps**. Default blocked apps stay blocked until you deliberately change that list. CATCH ME warns; it never presses the final control for you.
- Test Dismiss, Not a mistake and Snooze. Facts/draft text must remain local. Developer debug/traces are optional; traces contain geometry/timing only, are account-scoped and bounded. Test **Forget learned paths** and check the local counts.

Real AX role/name availability and physical input delivery are OS/application acceptance items. Missing or ambiguous evidence must produce a refusal, never a fabricated success.

## 7. Music, pins and artwork

Open Music explicitly with Spotify or Apple Music already running. Check player discovery, title/artist, play/pause/previous/next, supported artwork, and app/track changes during a command. Deny Automation once: the notice must be truthful and avoid repeated prompts until you explicitly retry.

For Chrome/Brave, use a normal foreground YouTube watch page with accessible player controls. Test Play/Pause and available Next/Previous. Unsupported websites, localized/ambiguous controls, private state and background browser windows may refuse. Thumbnail URLs are fixed/validated; artwork failures must not cause repeated downloads every refresh.

Copy a Spotify playlist/album link, choose **Pin copied Spotify link**, reopen the app and check the pin, Open and Unpin. Test an invalid link too. Pins do not require Spotify developer credentials.

## 8. Handoff

Handoff retains the existing server feature/beta flags. A disabled server must refuse clearly; do not enable a production feature merely to run this test.

1. Enable its local encrypted timeline and save a few test moments. Prepare a draft from settings or say “hand this off to …”.
2. Check selected moments, text redaction, preview images, brief edits, image covering, expiry, recipients and sender name. Nothing should upload before **Send**.
3. Cancel, change account, pause or turn the timeline off. Old drafts must disappear; disabling deletes local records for that timeline.
4. With a permitted test account, Send and open the resulting link. Test browser viewing and `neb://handoff/<id>` back into Neb.
5. Pick up the package. Confirm each proposed file/page/repository action. Commands are copied for your review, not executed. Git changes must preserve local work; decline a confirmation once and verify nothing changes.
6. Test invalid IDs, wrong recipient/account, expired/revoked packages and tampered ciphertext as refusal cases.

## 9. Finish your acceptance pass

Check account persistence, offline errors, tray/Dock reopen, quit/restart, reminders and updater status. Development builds normally have updating off. A development `.app` is separate from a Developer ID signed/notarized public DMG and a signed-update acceptance run.

Record **Pass / Fail / Refused as designed**, macOS version, app version, source app/browser, permission state, exact steps and expected/actual result. Do not include API keys, tokens or unredacted personal screenshots in reports.

Rebuild from repository root:

```sh
MACOSX_DEPLOYMENT_TARGET=14.0 pnpm --filter @mew/desktop exec tauri build --debug --bundles app --config src-tauri/tauri.macos.conf.json
```

See [the source parity ledger](../docs/MAC_PARITY.md) for code ownership and verification boundaries, and [release/update preparation](MAC_UPDATES.md) for distribution gates.
