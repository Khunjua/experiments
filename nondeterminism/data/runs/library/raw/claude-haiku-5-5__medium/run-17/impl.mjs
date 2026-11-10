const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 7;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_OWED = 1000;

const MS_DAY = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_DAY;
}

function toStr(n) {
  return new Date(n * MS_DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  // Removes a member from a book's waiting line (and from the member's hold list).
  function dropHold(book, memberId) {
    const idx = book.queue.indexOf(memberId);
    if (idx >= 0) book.queue.splice(idx, 1);
    const m = members.get(memberId);
    if (m) m.holds.delete(book.id);
  }

  // Applies lapsed pickup windows up to and including `today`.
  function expireAll(today) {
    for (const book of books.values()) {
      while (book.holdFor !== null && today > book.readyUntil) {
        const lapsed = book.holdFor;
        dropHold(book, lapsed);
        book.holdFor = null;
        book.readyUntil = null;
        if (book.queue.length > 0) {
          book.holdFor = book.queue[0];
          book.readyUntil = book.readyUntil === null ? null : book.readyUntil;
          // Next member's window starts after the previous window lapsed.
          book.readyUntil = (lapsedWindowEnd(book, lapsed) ?? today) + PICKUP_DAYS;
        }
      }
    }
  }

  // Helper used by expireAll: the end day of the window that just lapsed.
  // The lapsed window end is stored on the book before it is cleared.
  function lapsedWindowEnd(book, lapsed) {
    return book._lastWindowEnd ?? null;
  }

  function setAside(book, memberId, day) {
    book.holdFor = memberId;
    book.readyUntil = day + PICKUP_DAYS;
  }

  function ensureWindowTracking(book) {
    if (!('_lastWindowEnd' in book)) book._lastWindowEnd = null;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, {
        id: bookId,
        loan: null,
        queue: [],
        holdFor: null,
        readyUntil: null,
        _lastWindowEnd: null,
      });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { id: memberId, owed: 0, loans: new Map(), holds: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.loans.has(bookId)) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.holdFor !== null && b.holdFor !== memberId) return { ok: false };

      if (b.holdFor === memberId) {
        dropHold(b, memberId);
        b.holdFor = null;
        b.readyUntil = null;
        b._lastWindowEnd = null;
      }

      const dueDay = today + LOAN_DAYS;
      b.loan = { memberId, dueDay, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate: toStr(dueDay) };
    },

    returnBook({ memberId, bookId, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan || !b.loan || b.loan.memberId !== memberId) return { ok: false };

      const late = today - loan.dueDay;
      const chargeable = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
      m.owed += fine;

      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        setAside(b, b.queue[0], today);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (today > loan.dueDay) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      loan.dueDay = today + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: toStr(loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (m.loans.has(bookId)) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      // Only a book that is out (on loan or set aside for someone) can be held.
      if (b.loan === null && b.holdFor === null) return { ok: false };

      b.queue.push(memberId);
      m.holds.add(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const today = toDay(date);
      expireAll(today);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans].map(([bookId, loan]) => ({
        bookId,
        dueDate: toStr(loan.dueDay),
      }));

      const holds = [];
      for (const bookId of m.holds) {
        const b = books.get(bookId);
        if (!b) continue;
        const idx = b.queue.indexOf(memberId);
        if (idx < 0) continue;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: b.holdFor === memberId && b.readyUntil !== null
            ? toStr(b.readyUntil)
            : null,
        });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
