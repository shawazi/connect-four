'use strict';

/**
 * Pure Connect Four rules engine. No I/O, no network, no randomness.
 * The server is the sole owner of this state; clients never send board data,
 * only a column index that this module validates.
 */

const COLS = 7;
const ROWS = 6;
const CONNECT = 4;

const EMPTY = 0;
const RED = 1;
const YELLOW = 2;

/** @returns {number[][]} board[row][col], row 0 is the TOP row. */
function createBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(EMPTY));
}

function createGame() {
  return {
    board: createBoard(),
    turn: RED,
    status: 'playing', // 'playing' | 'won' | 'draw'
    winner: null, // RED | YELLOW | null
    winningCells: [], // [[row, col], ...]
    moveCount: 0,
    lastMove: null, // { row, col, player }
  };
}

/**
 * Validates a column index coming from an untrusted client.
 * Rejects non-integers, NaN, Infinity, out-of-range, and numeric strings.
 */
function isValidColumn(col) {
  return Number.isInteger(col) && col >= 0 && col < COLS;
}

function lowestEmptyRow(board, col) {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (board[row][col] === EMPTY) return row;
  }
  return -1; // column full
}

const DIRECTIONS = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal down-right
  [1, -1], // diagonal down-left
];

/** @returns {number[][]|null} the winning cells, or null if this move did not win. */
function findWinningCells(board, row, col) {
  const player = board[row][col];
  if (player === EMPTY) return null;

  for (const [dr, dc] of DIRECTIONS) {
    const cells = [[row, col]];

    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (
        r >= 0 && r < ROWS && c >= 0 && c < COLS &&
        board[r][c] === player
      ) {
        cells.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }

    if (cells.length >= CONNECT) return cells;
  }
  return null;
}

/**
 * Applies a move for `player` in `col`.
 * Mutates and returns { ok: true, ... } or { ok: false, error } — never throws
 * on bad input, so a malicious client cannot crash the server with a bad payload.
 */
function applyMove(game, player, col) {
  if (game.status !== 'playing') {
    return { ok: false, error: 'game_over' };
  }
  if (player !== RED && player !== YELLOW) {
    return { ok: false, error: 'invalid_player' };
  }
  if (player !== game.turn) {
    return { ok: false, error: 'not_your_turn' };
  }
  if (!isValidColumn(col)) {
    return { ok: false, error: 'invalid_column' };
  }

  const row = lowestEmptyRow(game.board, col);
  if (row === -1) {
    return { ok: false, error: 'column_full' };
  }

  game.board[row][col] = player;
  game.moveCount += 1;
  game.lastMove = { row, col, player };

  const winningCells = findWinningCells(game.board, row, col);
  if (winningCells) {
    game.status = 'won';
    game.winner = player;
    game.winningCells = winningCells;
  } else if (game.moveCount >= ROWS * COLS) {
    game.status = 'draw';
  } else {
    game.turn = player === RED ? YELLOW : RED;
  }

  return { ok: true, row, col, player };
}

module.exports = {
  COLS,
  ROWS,
  CONNECT,
  EMPTY,
  RED,
  YELLOW,
  createGame,
  createBoard,
  applyMove,
  isValidColumn,
  lowestEmptyRow,
  findWinningCells,
};
