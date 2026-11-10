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

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed }

  function advance(today) {
    for (const book of books.values()) {
      if (book.loan || book.readyUntil === null) continue;
      while (book.readyUntil !== null && book.readyUntil < today) {
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

  function fail(reason) {
    return { ok: false, reason };
  }

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
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('set aside for another member');
      if (loanCount(memberId) >= 5) return fail('loan limit');
      if (member.owed >= 1000) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = today + 21;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = today - book.loan.due;
      const fine = late >= 3 ? Math.min(late * 25, 500) : 0;
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) book.readyUntil = today + 3;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book || !book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= 2) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (today > book.loan.due) return fail('overdue');
      book.loan.due += 21;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const book = books.get(bookId);
      if (!members.has(memberId)) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return fail('invalid amount');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      advance(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && book.readyUntil !== null && !book.loan ? formatDay(book.readyUntil) : null,
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
