const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

function isObj(a) {
  return typeof a === 'object' && a !== null && !Array.isArray(a);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(day) {
  const t = new Date(day * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { status: 'available' | 'on_loan' | 'set_aside', queue: [{ memberId, seq }], borrower, readyUntil }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, borrowDay, dueDay, renewCount }] }
  const members = new Map();
  let latest = null;
  let holdSeq = 0;

  // Applies pickup expiry (§7) for date D.
  function expire(D) {
    for (const b of books.values()) {
      while (b.status === 'set_aside' && b.readyUntil < D) {
        b.queue.shift();
        if (b.queue.length === 0) {
          b.status = 'available';
          b.readyUntil = null;
        } else {
          b.readyUntil += PICKUP_DAYS;
        }
      }
    }
  }

  function advance(D) {
    latest = D;
    expire(D);
  }

  // Shared prelude for dated methods: object check, date remembered if valid
  // and in order, field checks, then time-order check.
  function gate(arg, checkOther) {
    if (!isObj(arg)) return { reason: 'invalid_input' };
    const day = parseDate(arg.date);
    const inOrder = day !== null && (latest === null || day >= latest);
    if (inOrder) advance(day);
    if (day === null || !checkOther(arg)) return { reason: 'invalid_input' };
    if (!inOrder) return { reason: 'date_out_of_order' };
    return { day };
  }

  function findLoan(m, bookId) {
    const idx = m.loans.findIndex(l => l.bookId === bookId);
    return idx < 0 ? null : { idx, loan: m.loans[idx] };
  }

  const api = {
    addBook(arg) {
      if (!isObj(arg) || !isId(arg.bookId)) return fail('invalid_input');
      const bookId = arg.bookId;
      if (books.has(bookId)) return fail('book_exists');
      books.set(bookId, { status: 'available', queue: [], borrower: null, readyUntil: null });
      return { ok: true };
    },

    addMember(arg) {
      if (!isObj(arg) || !isId(arg.memberId)) return fail('invalid_input');
      const memberId = arg.memberId;
      if (members.has(memberId)) return fail('member_exists');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },

    borrow(arg) {
      const g = gate(arg, a => isId(a.memberId) && isId(a.bookId));
      if (g.reason) return fail(g.reason);
      const D = g.day;
      const memberId = arg.memberId;
      const bookId = arg.bookId;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');

      if (b.status === 'on_loan') {
        return fail(b.borrower === memberId ? 'already_borrowed' : 'not_available');
      }
      if (b.status === 'set_aside' && b.queue[0].memberId !== memberId) {
        return fail('reserved_for_other');
      }
      if (m.loans.some(l => D > l.dueDay)) return fail('overdue_loans');
      if (m.owed >= FINE_BLOCK) return fail('fines_owed');
      if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

      if (b.status === 'set_aside') {
        b.queue.shift();
      }
      const dueDay = D + LOAN_DAYS;
      m.loans.push({ bookId, borrowDay: D, dueDay, renewCount: 0 });
      b.status = 'on_loan';
      b.borrower = memberId;
      b.readyUntil = null;
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook(arg) {
      const g = gate(arg, a => isId(a.memberId) && isId(a.bookId));
      if (g.reason) return fail(g.reason);
      const D = g.day;
      const memberId = arg.memberId;
      const bookId = arg.bookId;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');
      const found = findLoan(m, bookId);
      if (!found) return fail('not_borrowed');

      const late = Math.max(0, D - found.loan.dueDay);
      const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
      m.owed += fine;
      m.loans.splice(found.idx, 1);

      b.borrower = null;
      if (b.queue.length === 0) {
        b.status = 'available';
        b.readyUntil = null;
      } else {
        b.status = 'set_aside';
        b.readyUntil = D + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(arg) {
      const g = gate(arg, a => isId(a.memberId) && isId(a.bookId));
      if (g.reason) return fail(g.reason);
      const D = g.day;
      const memberId = arg.memberId;
      const bookId = arg.bookId;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');
      const found = findLoan(m, bookId);
      if (!found) return fail('not_borrowed');
      const loan = found.loan;

      if (D > loan.dueDay) return fail('overdue');
      if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
      if (b.queue.length > 0) return fail('has_holds');

      loan.dueDay += RENEW_DAYS;
      loan.renewCount += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(arg) {
      const g = gate(arg, a => isId(a.memberId) && isId(a.bookId));
      if (g.reason) return fail(g.reason);
      const memberId = arg.memberId;
      const bookId = arg.bookId;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');

      if (findLoan(m, bookId)) return fail('already_borrowed');
      if (b.queue.some(e => e.memberId === memberId)) return fail('already_held');
      if (b.status === 'available') return fail('book_available');

      holdSeq += 1;
      b.queue.push({ memberId, seq: holdSeq });
      return { ok: true, position: b.queue.length };
    },

    payFine(arg) {
      const g = gate(arg, a =>
        isId(a.memberId) && Number.isInteger(a.amount) && a.amount > 0
      );
      if (g.reason) return fail(g.reason);
      const memberId = arg.memberId;
      const amount = arg.amount;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      if (amount > m.owed) return fail('overpayment');

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(arg) {
      const g = gate(arg, a => isId(a.memberId));
      if (g.reason) return fail(g.reason);
      const memberId = arg.memberId;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.findIndex(e => e.memberId === memberId);
        if (idx < 0) continue;
        const setAsideForMe = b.status === 'set_aside' && idx === 0;
        holds.push({
          seq: b.queue[idx].seq,
          bookId,
          position: idx + 1,
          readyUntil: setAsideForMe ? formatDay(b.readyUntil) : null,
        });
      }
      holds.sort((x, y) => x.seq - y.seq);

      return {
        ok: true,
        loans: m.loans.map(l => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) })),
        owed: m.owed,
        holds: holds.map(h => ({ bookId: h.bookId, position: h.position, readyUntil: h.readyUntil })),
      };
    },
  };

  // Guarantee that no method throws, whatever the input.
  const safeApi = {};
  for (const name of Object.keys(api)) {
    const fn = api[name];
    safeApi[name] = function (arg) {
      try {
        return fn(arg);
      } catch {
        return fail('invalid_input');
      }
    };
  }
  return safeApi;
}
