# Cursor modes: DO IT, SHOW ME, CATCH ME

Built on `feat/cursor-modes` (M1–M6, 2026-11-20/21). Windows only. The user is always in charge:
nothing here moves the real cursor, blocks or swallows a click, or types in SHOW ME or CATCH ME.

## Where it lives

| Piece           | Pure (tested on any OS)                                                                                                                                         | Windows side                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Input stream | `cursor/euro.rs` (One Euro), `cursor/stream.rs` (120 Hz, velocity, acceleration)                                                                                | `win/mouse_stream.rs`: `WH_MOUSE_LL` thread; the callback only queues `{t, x, y}`                                                                                |
| B. Targets      | `cursor/target.rs` (Target, ≤ 40-item planning summary with content left out)                                                                                   | `win/uia_targets.rs`: invokable controls of the window in front, refreshed on UIA focus/structure events and WinEvents, never polled                             |
| C. Prediction   | `cursor/predict.rs` (minimum-jerk fit with fitted onset, `EndpointModel` trait), `cursor/posterior.rs` (motion × prior, trigger, cue words), `cursor/engine.rs` | none                                                                                                                                                             |
| D. Overlay      | `cursor/scene.rs` (ghost path, glow, expand, caption, status chip, placement)                                                                                   | `win/cursor_layer.rs`: Direct2D on DirectComposition, one click-through, never-activated, capture-excluded window per monitor, drawn only when the scene changes |
| E. SHOW ME      | `cursor/path.rs` (semantic anchors, fuzzy resolution, path cache), `cursor/plan.rs`, `cursor/lesson.rs` (guiding, corrections, step checks, re-plans, fading)   | `cursor_run.rs` (the engine thread)                                                                                                                              |
| F. DO IT        | `cursor/doit.rs` (allowlist, input check), `find.rs`, `settings_uri.rs`, `recipe.rs`, `rename.rs`, `replay.rs`                                                  | `cursor_do.rs`, `win/chores.rs` (Windows Search, Explorer's selection, opening, task dialogs)                                                                    |
| G. CATCH ME     | `cursor/catch.rs` (five rules, catcher, gaps, sensitivity, log)                                                                                                 | `win/catch_facts.rs` (UIA facts, terminal line), `win/catch_chip.rs` (the chip)                                                                                  |
| H. Voice        | `posterior::Cue`                                                                                                                                                | page: `frontend/src/features/screen/cues.ts` (clips made once per language and voice, cached; browser voice offline)                                             |
| I. Settings     | `cursor/settings.rs`, `cursor/telemetry.rs`                                                                                                                     | settings page "Cursor" section; tray "Pause CATCH ME", "Undo rename"                                                                                             |

Server: `POST /api/screen/plan` (SHOW ME path or DO IT action; words and ≤ 40 control names,
strict body, never a screenshot; one question per plan, re-plans in a lesson are free
follow-ups) and `POST /api/screen/recipe` (recipe from page text when there's no JSON-LD; one
question). Schemas in `packages/shared/src/screen-plan.ts` and `screen-recipe.ts`. Intents
`show_me` and `do_it` were added (`screen-intent.v4`) with device-side rules for the plain
phrasings.

## Measured (this machine, release build unless noted)

| What                                                             | Number                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Endpoint error at 50 / 75 / 90 % of the movement                 | 58 / 23 / 18 px (synthetic traces)                                                                            |
| Correct target at 90 %: motion only / with the intent prior      | 84.6 % / 78.3 %¹                                                                                              |
| **False interventions** (right target clicked)                   | **0.67 %** (target < 2 %), 1,200 synthetic traces                                                             |
| Wrong targets caught before the click                            | 28.7 % (adjacent menu items can't be told apart by motion, by design; the after-click check catches the rest) |
| Input + prediction + modes per frame                             | 0.12 ms mean, 0.32 ms worst trace mean                                                                        |
| Drawing a busy frame (1920×1080, software D2D, an upper bound)   | 1.8 ms                                                                                                        |
| CATCH ME idle, only it on (UIA watcher, facts worker, 4 Hz tick) | 0.16 % of one core over 10 s (live)                                                                           |
| Windows Search query for `find_file`                             | ~1.9 s (PowerShell helper start-up dominates)                                                                 |

¹ Half the mixed set clicks the wrong target on purpose, so a prior toward the expected one
lowers accuracy there; on right-target traces it raises it.

Tuning: 3 stable frames was the one change from the spec's thresholds (`stable_frames`); at 1
frame the false rate was 2.67 %. The sweep is `cargo test --release -- --ignored threshold_sweep
--nocapture`. **These numbers come from synthetic traces** (Fitts timing, submovements,
mouse and touchpad timing). Record real ones (below) before trusting them.

## Decisions (owner, 2026-11-20: "use what is best and build everything"; binding)

1. **SHOW ME takes "show me how" and "where is…"** when the window in front has UI Automation
   targets; Neb's hand `show` stays the fallback (screenshot), coach mode stays for study tasks.
2. **Reading Windows Settings' control names is allowed** (local, names only, no screenshot);
   decision 5 still blocks capturing it. `open_setting` only launches `ms-settings:` URIs.
3. **A SHOW ME or DO IT plan spends one question**; re-plans in the same lesson are free
   follow-ups. Chores recognised on the device (`doit::local_action`), cached paths, replays,
   fading and CATCH ME spend nothing.
4. **The input check** (`cursor/doit.rs`) allows `SendInput`/`InjectTouchInput` only in
   `win/mouse.rs` and `win/typing.rs` (Neb's hand and typing, decisions 15–17); DO IT needs none.
5. **CATCH ME has its own consent** (`CATCH_ME_CONSENT`), not a bump of `CONSENT_VERSION`
   (which would switch Screen Coach off for everyone). Tray pause is in memory (resets on restart).
6. **No keyboard hook**: the terminal rule reads the visible prompt line through UI Automation
   every 300 ms, only while a terminal is in front.
7. **Commits**: one per milestone on `feat/cursor-modes`, no attribution lines.
8. **save_recipe** saves through the clips route (the page's picture, the recipe as its text)
   into a "Recipe Book" notebook made if missing. No new storage; the notebook shows the
   picture and keeps the text searchable (a typed recipe card is a follow-up).
9. **No screenshot for planning**: when a window exposes no controls, SHOW ME falls back to Neb's
   hand (which already handles screenshots) instead of sending a crop to the plan route.
10. **Confirmations are native task dialogs** (Cancel is the default); CATCH ME's chip is a
    native non-activating window placed clear of the guarded control, or not shown at all.
11. **DO IT finishes the job when it can** (owner, 2026-11-25: "DO IT is such an awkward phrase
    to use if it stops at the last step"; `fix/do-it-finishes`). Dark and light mode are
    switched (`set_theme`: `AppsUseLightTheme` and `SystemUsesLightTheme` under the current
    user, as Settings writes them, then a `WM_SETTINGCHANGE` "ImmersiveColorSet" broadcast),
    not just opened at Colors. Asked again when it's already that way, nothing opens: Neb
    says so. Any plain wording is recognised on the device (`doit::theme_wanted`); asking how
    or where is still SHOW ME. Prompts `screen-intent.v5`, `screen-plan.v2`.
12. **One model call for a DO IT, not two** (owner, 2026-11-25: "it takes so long to execute
    tasks"; `fix/fewer-round-trips`). When the device's rules don't recognise the words, the
    intent route (`screen-intent.v6`) answers the chore along with `do_it`, checked against the
    allowlist on the desktop (`intent::parse_intent_action`), so DO IT starts at once. Only when
    it sent none, or one that doesn't check out, does DO IT still plan (`/api/screen/plan`). A
    chore chosen this way spends no question, like the ones recognised on the device (this
    narrows decision 3). Older desktop apps ignore the extra field.
13. **Neb renames what the student selected, when they ask it to** (owner, 2026-11-25: "Neb
    should be able to rename things if the user asks it to specifically";
    `feat/rename-on-request`). `rename_files` takes the items selected in the File Explorer
    window in front (never a whole folder by itself) and a rule: a new name (numbered " 1",
    " 2"… for several), a prefix, a suffix, a find-and-replace, a case. **The model never sees
    a file name**: it reads only the words and answers the rule, which `cursor/rename_rule.rs`
    applies on the computer. "Rename this to …" needs no model at all. Extensions are always
    kept, names are checked against Windows' rules, nothing lands on another file's name
    (" (2)" instead), the before → after table comes first with Cancel as the default, and
    the rename shares `batch_rename`'s undo log ("undo the rename", tray → Undo rename). A
    change of case only ("notes" → "Notes") is allowed. Prompts `screen-intent.v7`,
    `screen-plan.v3`.
    - **Every rename is DO IT's, decided on the device** (2026-11-25, after a test where the
      server read "rename the file … to …" as `act` and Neb's hand clicked Rename, then
      couldn't type into File Explorer's name box). Anything that starts "rename …" or "change
      the name of …" goes to DO IT without a model call. A file named aloud ("rename the file
      called notes to Final") is found among the folder's items by its name (exactly, or the
      only one holding it), selected or not; otherwise the selection is renamed.
    - **"Start with" and "end with" keep the name** (owner, 2026-11-25; `fix/rename-start-end`):
      "rename these to start with 2026" adds "2026 " in front of each name, "… to end with
      final" adds " final" after it (no space when the text already ends or starts with `-`,
      `_` or `.`), and so do "… to have v2 at the end", "add 2026 to the start of these names"
      and "put 2026 in front of these files". The add/put form counts only when what it's
      added to is plainly file names ("names", "files", "these", "them"), so "add a title to
      the start of this document" stays typing. All on the device, no model call.
    - **Any wording, and asked as a question** (owner, 2026-11-25: three renames came back as
      answers to something else while the model was busy; `fix/rename-any-wording`).
      `rename_rule::is_request` decides on the device, before typing and before the model:
      "rename … (to) …", "change / update / set the file name to …", "name this …", "call this
      file …", "would you mind renaming…", with casual openings ("can u", "pls", "could you").
      A question about renaming ("how do I rename a file?") is still a lesson.

## Shared path library (designed, not built)

A library entry would be `{ id, app: { process, minVersion }, locale, goalKeys: string[],
steps: Anchor[] (controlType, name, automationId?, process?), verifiedRuns, createdAt }`: the
same `Anchor` as `cursor-paths.json`, never coordinates or content. Nothing syncs today.

## What's kept on the computer

`screen-coach.json` (`cursor` settings), `cursor-paths.json` (paths that worked: types, names,
practice counts), `cursor-counts.json` (fixed counter keys only), `cursor-catch-log.json`
(`{rule, app, at, outcome}`, last 500), `cursor-rename-undo.json` (the last rename), and, only
with the developer switch, `cursor-traces/*.json` (positions and rectangles). Copy traces into
`desktop/src-tauri/tests/traces/` and the replay report includes them (and asserts < 2 %).

## Not verified without a person at the machine

The overlay on a real screen (it is capture-excluded, and tests never capture the user's
screen), real mouse and trackpad traces, Outlook/Gmail/Explorer/terminal UIA trees in the wild,
the chip and dialogs being clicked, cue audio, and the end-to-end plan calls against a deployed
server (route tests use a mocked model).

## Manual checklist (a real Windows laptop, with a mouse AND the trackpad)

Before: Screen Coach on and connected; in its settings, Cursor → read CATCH ME and turn it on.

1. **Debug view**: tick "Show the predicted endpoint live". Move to buttons in any app: a dot
   and ring lead the cursor and the likeliest buttons glow; the caption shows the frame time
   (expect < 2 ms). Try a monitor left of or above the main one, and 100/150/200 % scaling.
2. **Record traces**: tick "Record mouse traces", click ~100 ordinary targets with the mouse,
   then ~100 with the trackpad. Copy `%APPDATA%\…\cursor-traces` into `tests/traces`, run
   `cargo test --release -- replay_report --nocapture`; note the false-intervention rate.
3. **SHOW ME**: open Settings, hold Ctrl+Alt, say "how do I turn on dark mode?". A dotted path
   leads to Personalization; click it; the path moves to Colors. Head deliberately for the
   wrong item and slow down: Colors grows and you hear one word ("below"/"left") before you
   click. Click a wrong item: Neb says what opened and re-plans. Finish, then ask again three
   more times: full path → next button only → corrections only → silent ("You've got this one").
4. **DO IT find**: "find my lease PDF" (with such a file in Documents). It opens, and a 2-second
   caption shows "Found lease.pdf in Documents → …". With two similar files, a dialog asks which.
5. **DO IT setting**: "turn on dark mode for me": dark mode comes on (apps and taskbar), and no
   question is spent; ask again and Neb says it's already on. Then "show me how": a lesson starts.
6. **DO IT recipe**: on a recipe site with JSON-LD, "save this recipe": a clip appears in a
   Recipe Book notebook with ingredients and steps in its text, and no question is spent. On a
   video with no markup, it costs one question.
7. **DO IT rename**: in Explorer, select 5 photos, "rename these photos by date": a table of
   before → after; Cancel changes nothing; Rename renames; tray → Undo rename puts every name back.
   7b. **DO IT rename on request**: select 3 **test** files in Explorer and say "rename these to
   trip": a table shows "Trip 1", "Trip 2", "Trip 3" with the extensions kept; Rename renames,
   "undo the rename" puts them back. Then select one and say "put 2026 in front of this name".
8. **CATCH ME**: Outlook or Gmail, a thread with 6+ people, head for Reply all: amber glow, a line,
   the chip (Continue / Not a mistake / Snooze). Write "attached" with no file and head for Send.
   Edit Notepad without saving and head for ×. Select a folder in Explorer and head for Delete.
   In Windows Terminal type `git reset --hard` (don't press Enter). Each warns once, then stays
   quiet for 2 minutes. "Not a mistake" makes that rule less eager in that app. Tray → Pause.
9. **Silence**: with CATCH ME on, use the computer normally for 10 minutes: no false catches,
   and Task Manager shows Neb idle near 0 % CPU.
10. **Pause promise**: pause Screen Coach mid-lesson: the overlay and hook stop at once.
