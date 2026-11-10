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

function addDays(s, k) {
  return formatDay(parseDate(s) + k);
}

function diffDays(a, b) {
  return parseDate(a) - parseDate(b);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && diffDays(date, book.readyUntil) > 0) {
        const old = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? addDays(old, 3) : null;
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      advance(date);
      if (book.loan) return fail('book on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('set aside for another member');
      if (member.owed >= 1000) return fail('owes too much');
      if (loanCount(memberId) >= 5) return fail('loan limit');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      advance(date);
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = diffDays(date, book.loan.dueDate);
      const fine = late <= 2 ? 0 : Math.min(late * 25, 500);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) book.readyUntil = addDays(date, 3);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      advance(date);
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= 2) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (diffDays(date, loan.dueDate) > 0) return fail('overdue');
      loan.dueDate = addDays(loan.dueDate, 21);
      loan.renewals++;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      advance(date);
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('duplicate hold');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      advance(date);
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      advance(date);
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && book.readyUntil !== null ? book.readyUntil : null,
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
