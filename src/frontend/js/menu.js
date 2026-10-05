/**
 * The title screen. DOM, like the settings panel, and for the same reasons.
 *
 * `panel.js` established the conventions this follows: contents built in JS from
 * data, visibility driven by a class rather than the `hidden` attribute — so a
 * closed overlay cannot swallow a game key — and nothing but element
 * construction and event wiring here, with every decision pushed into
 * `menuModel.js` where Node can test it.
 *
 * The bench cannot pixel-check a DOM overlay, which is exactly why the model is
 * separate. What is left here is small enough to read.
 */

import { el } from './dom.js';
import {
  buildItems, scoreRows, replayRows, replayFilters, filterReplays, moveSelection,
  itemAt, modeAt, bestFor, ITEM, SCORE_ROWS,
} from './menuModel.js';

const MAIN_HINT = '↑↓ choose · Enter play · 1–3 quick start · Esc quit · O settings';
const REPLAY_HINT = '←→ mode · ↑↓ choose · Enter watch · Esc back';

export function makeMenu(root, handlers) {
  let open = false;
  let items = [];
  let scores = [];
  let index = 0;
  /** The row buttons, kept so moving the highlight does not rebuild them. */
  let buttons = [];
  /** Whether the quit confirmation is up. Escape opens it; Escape cancels it. */
  let confirming = false;
  /**
   * `'main'` for the mode rows, `'replays'` for the replay picker. The picker
   * lives inside this overlay rather than as a second one, so the key routing in
   * the driver — menu open or not — stays a single question.
   */
  let view = 'main';
  /** Every replay row, from `menuModel.replayRows`, before filtering. */
  let allReplays = [];
  /** The rows the current filter keeps. What the picker shows and indexes. */
  let replays = [];
  const filters = replayFilters();
  /** Index into `filters`. Reset to All every time the picker opens. */
  let filter = 0;

  const title = el('h1', 'menu-title', 'TETRIS');
  const filterBar = el('div', 'menu-filters');
  const list = el('div', 'menu-list');
  const table = el('div', 'menu-scores');
  const hint = el('p', 'menu-hint', MAIN_HINT);

  /* -- the quit confirmation -- */

  // A card over the menu rather than a native `confirm()`: the page has a real
  // overlay language already, and a browser dialog would look like a different
  // application. Built once and shown by class, like every other overlay here.
  const confirmCard = el('div', 'menu-confirm');
  confirmCard.setAttribute('role', 'alertdialog');
  confirmCard.appendChild(el('p', 'menu-confirm-text', 'Quit Tetris?'));
  const confirmActions = el('div', 'menu-confirm-actions');

  const cancelBtn = el('button', 'set-btn', 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => cancelConfirm());

  const quitBtn = el('button', 'set-btn set-btn-primary', 'Quit');
  quitBtn.type = 'button';
  quitBtn.addEventListener('click', () => confirmQuit());

  confirmActions.appendChild(cancelBtn);
  confirmActions.appendChild(quitBtn);
  confirmCard.appendChild(confirmActions);

  root.appendChild(title);
  root.appendChild(filterBar);
  root.appendChild(list);
  root.appendChild(table);
  root.appendChild(hint);
  root.appendChild(confirmCard);

  function setConfirm(next) {
    confirming = next;
    confirmCard.classList.toggle('menu-confirm-on', confirming);
  }

  function openConfirm() {
    setConfirm(true);
  }

  function cancelConfirm() {
    setConfirm(false);
  }

  /**
   * Quit, if the driver wired it up.
   *
   * Not `window.close()`: the page cannot close its own window in this webview,
   * and quitting is the launcher's job — `main.js` routes this to the `quit`
   * bridge method, which is what actually exits the app.
   */
  function confirmQuit() {
    setConfirm(false);
    if (handlers.onQuit) handlers.onQuit();
  }

  /** How many rows the current view has. */
  function count() {
    return view === 'replays' ? replays.length : items.length;
  }

  /** Build the rows for the current view. Only called when the rows change. */
  function buildRows() {
    list.textContent = '';
    buttons = [];
    hint.textContent = view === 'replays' ? REPLAY_HINT : MAIN_HINT;
    filterBar.classList.toggle('menu-filters-on', view === 'replays');
    list.classList.toggle('menu-list-replays', view === 'replays');
    if (view === 'replays') { buildFilters(); buildReplayRows(); return; }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = el('button', 'menu-item');
      row.type = 'button';

      row.appendChild(el('span', 'menu-item-label', item.label));
      if (item.goal) row.appendChild(el('span', 'menu-item-goal', item.goal));
      if (item.kind === ITEM.MODE) {
        const best = bestFor(scores, item.id);
        if (best > 0) row.appendChild(el('span', 'menu-item-best', 'best ' + best));
      }
      row.appendChild(el('span', 'menu-item-blurb', item.blurb));

      // Clicking a row chooses it, which for a mode means playing it. A menu that
      // needed a click and then a second click to confirm would be worse than the
      // number keys it replaced.
      row.addEventListener('click', () => choose(i));
      list.appendChild(row);
      buttons.push(row);
    }
  }

  /** The filter tabs. Clickable, so the mouse can do what left/right does. */
  function buildFilters() {
    filterBar.textContent = '';
    for (let i = 0; i < filters.length; i++) {
      const tab = el('button', 'menu-filter', filters[i].label);
      tab.type = 'button';
      tab.classList.toggle('menu-filter-on', i === filter);
      tab.addEventListener('click', () => setFilter(i));
      filterBar.appendChild(tab);
    }
  }

  function setFilter(i) {
    filter = i;
    replays = filterReplays(allReplays, filters[filter].id);
    index = 0;
    buildRows();
    highlight();
  }

  function buildReplayRows() {
    if (!replays.length) {
      const what = filter === 0 ? 'no replays saved yet'
        : 'no ' + filters[filter].label + ' replays yet';
      list.appendChild(el('p', 'menu-empty', what));
      return;
    }
    for (let i = 0; i < replays.length; i++) {
      const r = replays[i];
      const row = el('button', 'menu-item');
      row.type = 'button';
      row.appendChild(el('span', 'menu-item-date', r.when));
      row.appendChild(el('span', 'menu-item-label', r.mode));
      row.appendChild(el('span', 'menu-item-best', String(r.score)));
      row.appendChild(el('span', 'menu-item-blurb', r.lines + ' lines · ' + r.time));
      row.addEventListener('click', () => choose(i));
      list.appendChild(row);
      buttons.push(row);
    }
  }

  /** The score table for whichever row is highlighted. */
  function buildScores() {
    table.textContent = '';
    if (view === 'replays') {
      const r = replays[index];
      if (r) {
        table.appendChild(el('p', 'menu-empty',
          r.mode + ' · ' + r.when + (r.reason ? ' · ' + r.reason : '') + ' — press Enter'));
      }
      return;
    }
    const item = itemAt(items, index);
    const mode = modeAt(items, index);
    if (!mode) {
      // Highlighted Settings or Replays: neither has scores, and showing the
      // last mode's would read as a bug.
      const what = item && item.kind === ITEM.REPLAYS ? 'replays' : 'settings';
      table.appendChild(el('p', 'menu-empty', what + ' — press Enter'));
      return;
    }
    const rows = scoreRows(scores, mode, SCORE_ROWS);
    if (!rows.length) {
      table.appendChild(el('p', 'menu-empty', 'no ' + mode + ' scores yet'));
      return;
    }
    for (const r of rows) {
      const line = el('div', 'menu-score');
      line.appendChild(el('span', 'menu-score-rank', String(r.rank)));
      line.appendChild(el('span', 'menu-score-value', String(r.score)));
      line.appendChild(el('span', 'menu-score-detail', r.lines + ' lines · ' + r.time));
      table.appendChild(line);
    }
  }

  /** Repaint the highlight. Cheap enough to run on every arrow key. */
  function highlight() {
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('menu-item-on', i === index);
    }
    // The picker can hold a hundred rows and scrolls; keep the highlight on screen.
    if (buttons[index] && buttons[index].scrollIntoView) {
      buttons[index].scrollIntoView({ block: 'nearest' });
    }
    buildScores();
  }

  function choose(i) {
    if (view === 'replays') {
      const r = replays[i];
      if (r && handlers.onWatch) handlers.onWatch(r.id);
      return;
    }
    const item = itemAt(items, i);
    if (!item) return;
    if (item.kind === ITEM.REPLAYS) {
      if (handlers.onReplays) handlers.onReplays();
      return;
    }
    if (item.kind === ITEM.SETTINGS) {
      if (handlers.onSettings) handlers.onSettings();
      return;
    }
    if (handlers.onPlay) handlers.onPlay(item.id);
  }

  /** Leave the picker, with the highlight back on the Replays row. */
  function backToMain() {
    view = 'main';
    const at = items.findIndex((it) => it.kind === ITEM.REPLAYS);
    index = at < 0 ? 0 : at;
    buildRows();
    highlight();
  }

  function setOpen(next) {
    open = next;
    root.classList.toggle('menu-open', open);
    // Never leave the prompt up behind a closed menu: it would reappear over the
    // game the next time the menu opened.
    if (!open) setConfirm(false);
  }

  return {
    open() {
      setConfirm(false);
      if (view !== 'main') { view = 'main'; index = 0; buildRows(); }
      setOpen(true);
      highlight();
    },
    close() {
      setOpen(false);
    },
    isOpen() {
      return open;
    },

    /** Whether the quit confirmation is up. The driver routes keys by this. */
    isConfirming() {
      return confirming;
    },

    /** Answer the confirmation. Called by the card's buttons and the driver. */
    confirmQuit,
    cancelConfirm,

    /**
     * New rows and a fresh score table.
     *
     * Called every time the screen is shown, so the scores are whatever the last
     * run left on disk rather than whatever they were at boot.
     */
    set(nextItems, nextScores) {
      items = nextItems || buildItems();
      scores = nextScores || [];
      view = 'main';
      index = 0;
      buildRows();
      highlight();
    },

    /**
     * Switch to the replay picker. The driver fetches the list and hands it
     * here, so the picker always shows what is on disk now.
     */
    showReplays(list) {
      // The fetch is async: if the menu closed meanwhile, do not reopen a view.
      if (!open) return;
      view = 'replays';
      allReplays = replayRows(list);
      setFilter(0);
    },

    /** One menu action, from `menuModel.keyToAction`. True when it was ours. */
    act(action) {
      // While the prompt is up the rows are inert: Enter confirms, Escape
      // cancels, and the arrows do nothing behind it.
      if (confirming) {
        if (action === 'start') { confirmQuit(); return true; }
        if (action === 'close') { cancelConfirm(); return true; }
        return false;
      }
      if (action === 'up') { index = moveSelection(index, -1, count()); highlight(); return true; }
      if (action === 'down') { index = moveSelection(index, 1, count()); highlight(); return true; }
      if (action === 'start') { choose(index); return true; }
      // In the picker, Escape is "back", not "quit".
      if (action === 'close' && view === 'replays') { backToMain(); return true; }
      if ((action === 'left' || action === 'right') && view === 'replays') {
        setFilter(moveSelection(filter, action === 'left' ? -1 : 1, filters.length));
        return true;
      }
      // Escape no longer plays the stored mode: it asks before quitting. Enter on
      // a row and the 1–3 keys still start a game, so nothing was lost.
      if (action === 'close') { openConfirm(); return true; }
      return false;
    },

    /** For tests and for the driver's own logging. */
    selection() {
      return index;
    },
  };
}
