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
  buildItems, scoreRows, moveSelection, itemAt, modeAt, bestFor, ITEM, SCORE_ROWS,
} from './menuModel.js';

export function makeMenu(root, handlers) {
  let open = false;
  let items = [];
  let scores = [];
  let index = 0;
  /** The row buttons, kept so moving the highlight does not rebuild them. */
  let buttons = [];

  const title = el('h1', 'menu-title', 'TETRIS');
  const list = el('div', 'menu-list');
  const table = el('div', 'menu-scores');
  const hint = el('p', 'menu-hint',
    '↑↓ choose · Enter play · 1–3 quick start · Esc last mode · O settings');

  root.appendChild(title);
  root.appendChild(list);
  root.appendChild(table);
  root.appendChild(hint);

  /** Build the rows from `items`. Only called when the rows themselves change. */
  function buildRows() {
    list.textContent = '';
    buttons = [];
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

  /** The score table for whichever row is highlighted. */
  function buildScores() {
    table.textContent = '';
    const mode = modeAt(items, index);
    if (!mode) {
      // Highlighted Settings: there is no such thing as a Settings score, and
      // showing the last mode's would read as a bug.
      table.appendChild(el('p', 'menu-empty', 'settings — press Enter'));
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
    buildScores();
  }

  function choose(i) {
    const item = itemAt(items, i);
    if (!item) return;
    if (item.kind === ITEM.SETTINGS) {
      if (handlers.onSettings) handlers.onSettings();
      return;
    }
    if (handlers.onPlay) handlers.onPlay(item.id);
  }

  function setOpen(next) {
    open = next;
    root.classList.toggle('menu-open', open);
  }

  return {
    open() {
      setOpen(true);
      highlight();
    },
    close() {
      setOpen(false);
    },
    isOpen() {
      return open;
    },

    /**
     * New rows and a fresh score table.
     *
     * Called every time the screen is shown, so the scores are whatever the last
     * run left on disk rather than whatever they were at boot.
     */
    set(nextItems, nextScores) {
      items = nextItems || buildItems();
      scores = nextScores || [];
      index = 0;
      buildRows();
      highlight();
    },

    /** One menu action, from `menuModel.keyToAction`. True when it was ours. */
    act(action) {
      if (action === 'up') { index = moveSelection(index, -1, items.length); highlight(); return true; }
      if (action === 'down') { index = moveSelection(index, 1, items.length); highlight(); return true; }
      if (action === 'start') { choose(index); return true; }
      if (action === 'close') { if (handlers.onClose) handlers.onClose(); return true; }
      return false;
    },

    /** For tests and for the driver's own logging. */
    selection() {
      return index;
    },
  };
}
