const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDate(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return id !== undefined && id !== null;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, holds, readyFor, readyUntil }
  const members = new Map(); // memberId -> { owed, loans:Set }

  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  // Lazily expire set-aside periods up to (and excluding) the given day.
  function advance(day) {
    for (const book of books.values()) {
      while (book.readyFor !== null && book.readyUntil < day) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyFor = book.holds[0];
          book.readyUntil = book.readyUntil + 3;
        } else {
          book.readyFor = null;
          book.readyUntil = null;
        }
      }
    }
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], readyFor: null, readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: new Set() });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date', { dueDate: null });
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member', { dueDate: null });
    if (!book) return fail('unknown book', { dueDate: null });
    if (book.loan) return fail('book on loan', { dueDate: null });
    if (book.readyFor !== null && book.readyFor !== memberId) return fail('set aside for another member', { dueDate: null });
    if (member.loans.size >= 5) return fail('loan limit', { dueDate: null });
    if (member.owed >= 1000) return fail('owes too much', { dueDate: null });

    if (book.readyFor === memberId) {
      book.holds.shift();
      book.readyFor = null;
      book.readyUntil = null;
    }
    const due = day + 21;
    book.loan = { memberId, dueDate: due, renewals: 0 };
    member.loans.add(bookId);
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date', { fine: 0 });
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member', { fine: 0 });
    }
    const late = day - book.loan.dueDate;
    const fine = late >= 3 ? Math.min(late * 25, 500) : 0;
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.holds.length > 0) {
      book.readyFor = book.holds[0];
      book.readyUntil = day + 3;
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date', { dueDate: null });
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member', { dueDate: null });
    }
    const loan = book.loan;
    if (loan.renewals >= 2) return fail('renewal limit', { dueDate: formatDate(loan.dueDate) });
    if (book.holds.length > 0) return fail('book has holds', { dueDate: formatDate(loan.dueDate) });
    if (day > loan.dueDate) return fail('overdue', { dueDate: formatDate(loan.dueDate) });
    loan.dueDate += 21;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date', { position: null });
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member', { position: null });
    if (!book) return fail('unknown book', { position: null });
    if (!book.loan && book.readyFor === null) return fail('book is on shelf', { position: null });
    if (book.loan && book.loan.memberId === memberId) return fail('member has book', { position: null });
    if (book.holds.includes(memberId)) return fail('already holding', { position: null });
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date', { owed: null });
    advance(day);
    const member = members.get(memberId);
    if (!member) return fail('unknown member', { owed: null });
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount', { owed: member.owed });
    if (amount > member.owed) return fail('overpayment', { owed: member.owed });
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const day = parseDate(date);
    if (day !== null) advance(day);
    const member = members.get(memberId);
    if (!member) return { ok: false, loans: [], owed: 0, holds: [] };
    const loans = [];
    for (const bookId of member.loans) {
      loans.push({ bookId, dueDate: formatDate(books.get(bookId).loan.dueDate) });
    }
    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.holds.indexOf(memberId);
      if (idx === -1) continue;
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: book.readyFor === memberId ? formatDate(book.readyUntil) : null,
      });
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
