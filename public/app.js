"use strict";

/**
 * Connect Four client.
 *
 * The client is a pure renderer + input forwarder. It never computes whose turn
 * it is, whether a move is legal, or who won — every board it draws came from
 * the server. All text from other players is written with textContent, so a
 * hostile name can never become markup.
 */

(function () {
  const ROWS = 6;
  const COLS = 7;
  const RED = 1;
  const YELLOW = 2;

  const $ = (id) => document.getElementById(id);

  const el = {
    conn: $("conn"),
    lobby: $("lobby"),
    game: $("game"),
    nameInput: $("name-input"),
    createBtn: $("create-btn"),
    joinForm: $("join-form"),
    codeInput: $("code-input"),
    joinBtn: $("join-btn"),
    lobbyError: $("lobby-error"),
    roomCode: $("room-code"),
    inviteLink: $("invite-link"),
    copyBtn: $("copy-btn"),
    board: $("board"),
    status: $("status"),
    you: $("you"),
    rematchBtn: $("rematch-btn"),
    leaveBtn: $("leave-btn"),
    chatLog: $("chat-log"),
    chatForm: $("chat-form"),
    chatInput: $("chat-input"),
    chatSend: $("chat-send"),
    chatNote: $("chat-note"),
    pRed: $("p-red"),
    pYellow: $("p-yellow"),
    nameRed: $("name-red"),
    nameYellow: $("name-yellow"),
    scoreRed: $("score-red"),
    scoreYellow: $("score-yellow"),
    scoreDraw: $("score-draw"),
  };

  let ws = null;
  let mySeat = null; // 'red' | 'yellow' | 'spectator'
  let myToken = null;
  let myCode = null;
  let lastState = null;
  let prevMoveKey = null;
  let reconnectDelay = 500;
  let intentionalClose = false;

  // -------------------------------------------------------------------------
  // Local persistence (per room, so a refresh keeps your seat)
  // -------------------------------------------------------------------------

  function saveSession(code, token) {
    try {
      sessionStorage.setItem("c4:" + code, token || "");
      localStorage.setItem("c4:name", el.nameInput.value || "");
    } catch {
      /* storage disabled — reconnect just falls back to a new seat */
    }
  }

  function loadToken(code) {
    try {
      return sessionStorage.getItem("c4:" + code) || null;
    } catch {
      return null;
    }
  }

  try {
    const saved = localStorage.getItem("c4:name");
    if (saved) el.nameInput.value = saved;
  } catch {
    /* ignore */
  }

  // -------------------------------------------------------------------------
  // Board construction (built once; cells are reused every render)
  // -------------------------------------------------------------------------

  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    cells[r] = [];
    for (let c = 0; c < COLS; c++) {
      const btn = document.createElement("button");
      btn.className = "cell";
      btn.type = "button";
      btn.dataset.v = "0";
      btn.setAttribute("role", "gridcell");
      btn.setAttribute("aria-label", `Row ${r + 1}, column ${c + 1}`);
      btn.addEventListener("click", () => dropIn(c));
      el.board.appendChild(btn);
      cells[r][c] = btn;
    }
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  function setConn(state, text) {
    el.conn.dataset.state = state;
    el.conn.textContent = text;
  }

  function connect(onOpen) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.addEventListener("open", () => {
      setConn("open", "connected");
      reconnectDelay = 500;
      if (onOpen) onOpen();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      handle(msg);
    });

    ws.addEventListener("close", () => {
      setConn("closed", "disconnected");
      if (intentionalClose) return;
      setTimeout(() => {
        setConn("connecting", "reconnecting…");
        connect(() => {
          // Re-claim the same seat using the token we were issued.
          if (myCode) {
            sendRaw({
              type: "join",
              code: myCode,
              token: myToken,
              name: myName(),
            });
          }
        });
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });

    ws.addEventListener("error", () => setConn("closed", "connection error"));
  }

  function sendRaw(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function myName() {
    return (el.nameInput.value || "").slice(0, 20);
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  function handle(msg) {
    switch (msg.type) {
      case "hello":
        break;

      case "joined":
        mySeat = msg.seat;
        myCode = msg.code;
        myToken = msg.token || myToken;
        if (myToken) saveSession(myCode, myToken);
        showGame();
        break;

      case "state":
        lastState = msg.state;
        render(msg.state);
        break;

      case "chat_history":
        if (Array.isArray(msg.messages)) {
          el.chatLog.textContent = "";
          seenChatIds.clear();
          msg.messages.forEach(addChatMessage);
        }
        break;

      case "chat":
        addChatMessage(msg.message);
        break;

      case "error":
        onError(msg);
        break;

      default:
        break;
    }
  }

  function onError(msg) {
    const quiet = [
      "not_your_turn",
      "column_full",
      "game_over",
      "waiting",
      "rate_limited",
    ];
    // Chat problems belong next to the chat box, not in the game status line.
    if (msg.code === "chat_rate_limited" || msg.code === "bad_chat") {
      chatNote(
        msg.code === "chat_rate_limited" ? "Slow down a moment." : "Not sent.",
      );
      return;
    }
    if (el.game.classList.contains("hidden")) {
      el.lobbyError.textContent = friendly(msg);
      el.createBtn.disabled = false;
      el.joinBtn.disabled = false;
    } else if (!quiet.includes(msg.code)) {
      el.status.textContent = friendly(msg);
    }
  }

  function friendly(msg) {
    const map = {
      no_such_room: "No game found with that code.",
      bad_code: "That code does not look right.",
      room_full: "That game is full.",
      server_busy: "Server is busy — try again in a moment.",
      already_in_room: "You are already in a game.",
    };
    // Fall back to the server's own message, which is a fixed string, never
    // user-supplied — but it is still set via textContent downstream.
    return map[msg.code] || msg.message || "Something went wrong.";
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function seatNum(seat) {
    return seat === "red" ? RED : seat === "yellow" ? YELLOW : 0;
  }

  function render(s) {
    // Board
    const lm = s.lastMove;
    const moveKey = lm ? `${lm.row}:${lm.col}:${lm.player}` : null;
    const isNewMove = moveKey !== null && moveKey !== prevMoveKey;
    prevMoveKey = moveKey;

    const winSet = new Set((s.winningCells || []).map(([r, c]) => r + ":" + c));
    const myNum = seatNum(mySeat);
    const myTurn = s.status === "playing" && myNum !== 0 && s.turn === myNum;
    const bothHere = !!(s.players.red && s.players.yellow);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = cells[r][c];
        const v = String(s.board[r][c]);
        if (cell.dataset.v !== v) cell.dataset.v = v;

        const isWin = winSet.has(r + ":" + c);
        if (isWin) cell.dataset.win = "true";
        else delete cell.dataset.win;

        if (isNewMove && lm && lm.row === r && lm.col === c) {
          cell.dataset.new = "true";
        } else if (cell.dataset.new) {
          delete cell.dataset.new;
        }

        // A column is only clickable if it is your turn and it has room.
        cell.disabled = !(myTurn && bothHere && s.board[0][c] === 0);
      }
    }

    el.board.dataset.active = String(myTurn && bothHere);
    el.board.dataset.me = String(myNum);

    // Players
    paintPlayer(
      el.pRed,
      el.nameRed,
      s.players.red,
      s.turn === RED && s.status === "playing",
    );
    paintPlayer(
      el.pYellow,
      el.nameYellow,
      s.players.yellow,
      s.turn === YELLOW && s.status === "playing",
    );

    el.scoreRed.textContent = String(s.scores.red);
    el.scoreYellow.textContent = String(s.scores.yellow);
    el.scoreDraw.textContent = String(s.scores.draws);

    // Status line
    el.status.dataset.win = "false";
    if (!bothHere) {
      el.status.textContent = "Waiting for an opponent to join…";
    } else if (s.status === "won") {
      const winnerName =
        s.winner === RED
          ? s.players.red
            ? s.players.red.name
            : "Red"
          : s.players.yellow
            ? s.players.yellow.name
            : "Yellow";
      el.status.dataset.win = "true";
      el.status.textContent =
        s.winner === myNum ? "You win! 🎉" : `${winnerName} wins!`;
    } else if (s.status === "draw") {
      el.status.textContent = "It's a draw.";
    } else if (myNum === 0) {
      const t = s.turn === RED ? s.players.red : s.players.yellow;
      el.status.textContent = `${t ? t.name : "…"} to play`;
    } else if (myTurn) {
      el.status.textContent = "Your turn";
    } else {
      const t = s.turn === RED ? s.players.red : s.players.yellow;
      el.status.textContent = `${t ? t.name : "Opponent"}'s turn`;
    }

    // Rematch
    const over = s.status === "won" || s.status === "draw";
    el.rematchBtn.classList.toggle("hidden", !(over && myNum !== 0));
    if (over && myNum !== 0) {
      const voted = (s.rematchVotes || []).includes(myNum);
      el.rematchBtn.disabled = voted;
      el.rematchBtn.textContent = voted ? "Waiting for opponent…" : "Rematch";
    }

    // Footer
    const spec = s.spectators ? ` · ${s.spectators} watching` : "";
    el.you.textContent =
      mySeat === "spectator"
        ? `You are spectating${spec}`
        : `You are ${mySeat === "red" ? "Red" : "Yellow"}${spec}`;
  }

  function paintPlayer(row, nameEl, player, isTurn) {
    if (player) {
      // textContent, never innerHTML — the server sanitises names too.
      nameEl.textContent = player.name;
      row.dataset.off = String(!player.connected);
      if (!player.connected) nameEl.textContent = player.name + " (away)";
    } else {
      nameEl.textContent = "Waiting…";
      row.dataset.off = "true";
    }
    row.dataset.turn = String(!!isTurn);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  // Reconnects replay history, so ids are tracked to avoid duplicate lines.
  const seenChatIds = new Set();

  /**
   * Appends one chat line.
   *
   * Every piece of text here comes from another player. It is written with
   * textContent and createTextNode ONLY — never innerHTML, insertAdjacentHTML,
   * or a template string assigned to markup. That is the invariant that makes a
   * message like `<img onerror=...>` render as the literal characters a player
   * typed rather than as an element. The server sanitises too, but this is the
   * layer that actually decides whether markup can execute.
   */
  function addChatMessage(m) {
    if (!m || typeof m !== "object") return;
    if (typeof m.text !== "string" || typeof m.name !== "string") return;
    if (typeof m.id === "number") {
      if (seenChatIds.has(m.id)) return;
      seenChatIds.add(m.id);
    }

    const empty = el.chatLog.querySelector(".chat-empty");
    if (empty) empty.remove();

    const seat = m.seat === "red" || m.seat === "yellow" ? m.seat : "spectator";

    const li = document.createElement("li");
    li.className = "chat-msg";
    li.dataset.seat = seat;

    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = m.name + ":";

    const text = document.createElement("span");
    text.className = "chat-text";
    text.textContent = m.text;

    li.append(who, text);

    // Only autoscroll if already at the bottom, so reading back isn't yanked.
    const atBottom =
      el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight <
      40;
    el.chatLog.appendChild(li);
    if (atBottom) el.chatLog.scrollTop = el.chatLog.scrollHeight;

    // Mirror the server's history cap so a long game can't grow the DOM forever.
    while (el.chatLog.children.length > 50) {
      el.chatLog.removeChild(el.chatLog.firstChild);
    }
  }

  function chatNote(text) {
    el.chatNote.textContent = text;
    if (text)
      setTimeout(() => {
        el.chatNote.textContent = "";
      }, 2500);
  }

  function dropIn(col) {
    if (!lastState || mySeat === "spectator") return;
    sendRaw({ type: "move", column: col });
  }

  function showEmptyChat() {
    if (el.chatLog.children.length > 0) return;
    const li = document.createElement("li");
    li.className = "chat-empty";
    li.textContent = "No messages yet.";
    el.chatLog.appendChild(li);
  }

  function showGame() {
    el.lobby.classList.add("hidden");
    el.game.classList.remove("hidden");
    el.roomCode.textContent = myCode;
    const link = `${location.origin}/?room=${encodeURIComponent(myCode)}`;
    el.inviteLink.value = link;
    if (history.replaceState)
      history.replaceState(null, "", `/?room=${encodeURIComponent(myCode)}`);
    showEmptyChat();
  }

  el.createBtn.addEventListener("click", () => {
    el.lobbyError.textContent = "";
    el.createBtn.disabled = true;
    sendRaw({ type: "create", name: myName() });
  });

  el.joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = (el.codeInput.value || "").trim().toUpperCase();
    if (code.length !== 6) {
      el.lobbyError.textContent = "Invite codes are 6 characters.";
      return;
    }
    el.lobbyError.textContent = "";
    el.joinBtn.disabled = true;
    sendRaw({ type: "join", code, token: loadToken(code), name: myName() });
  });

  el.rematchBtn.addEventListener("click", () => {
    el.rematchBtn.disabled = true;
    sendRaw({ type: "rematch" });
  });

  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    sendRaw({ type: "chat", text });
    el.chatInput.value = "";
    el.chatInput.focus();
  });

  el.leaveBtn.addEventListener("click", () => {
    intentionalClose = true;
    sendRaw({ type: "leave" });
    if (ws) ws.close();
    location.href = "/";
  });

  el.copyBtn.addEventListener("click", async () => {
    const link = el.inviteLink.value;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      el.inviteLink.select();
      document.execCommand("copy");
    }
    el.copyBtn.textContent = "Copied";
    setTimeout(() => {
      el.copyBtn.textContent = "Copy";
    }, 1400);
  });

  // Keyboard: 1-7 drops in that column.
  document.addEventListener("keydown", (e) => {
    if (el.game.classList.contains("hidden")) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= COLS) dropIn(n - 1);
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  setConn("connecting", "connecting…");

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get("room") || "").trim().toUpperCase();

  connect(() => {
    if (/^[A-Z2-9]{6}$/.test(roomParam)) {
      sendRaw({
        type: "join",
        code: roomParam,
        token: loadToken(roomParam),
        name: myName(),
      });
    }
  });
})();
