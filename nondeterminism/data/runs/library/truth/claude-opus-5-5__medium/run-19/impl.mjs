const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, holds: [], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed }

  function advance(day) {
    for (const book of books.values()) {
      if (book.loan || book.readyUntil === null) continue;
      while (book.readyUntil !== null && book.readyUntil < day) {
        book.holds.shift();
        if (book.holds.length === 0) book.readyUntil = null;
        else book.readyUntil += 3;
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  function isSetAside(book) {
    return !book.loan && book.readyUntil !== null && book.holds.length > 0;
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (member.owed >= 1000) return fail('owes too much');
      if (loanCount(memberId) >= 5) return fail('loan limit');
      if (isSetAside(book)) {
        if (book.holds[0] !== memberId) return fail('set aside for another member');
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = day + 21;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }
      const late = day - book.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(late * 25, 500);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? day + 3 : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }
      if (book.loan.renewals >= 2) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (day > book.loan.due) return fail('overdue');
      book.loan.due += 21;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && !isSetAside(book)) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
      advance(day);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil = idx === 0 && isSetAside(book) ? formatDay(book.readyUntil) : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
