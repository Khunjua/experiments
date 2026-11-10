const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

function toDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals}|null, holds: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed }

  function advance(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        b.holds.shift();
        if (b.holds.length) b.readyUntil += PICKUP_DAYS;
        else b.readyUntil = null;
      }
    }
  }

  function addBook({ bookId } = {}) {
    if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false, reason: 'invalid or duplicate' };
    books.set(bookId, { loan: null, holds: [], readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false, reason: 'invalid or duplicate' };
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const d = toDay(date);
    if (Number.isNaN(d)) return { ok: false, reason: 'bad date' };
    advance(d);
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return { ok: false, reason: 'unknown' };
    if (b.loan) return { ok: false, reason: 'already on loan' };
    if (m.owed >= BORROW_BLOCK_OWED) return { ok: false, reason: 'owes too much' };
    if (b.readyUntil !== null && b.holds[0] !== memberId) return { ok: false, reason: 'set aside for another member' };
    if (b.holds.includes(memberId)) {
      b.holds = b.holds.filter(x => x !== memberId);
      b.readyUntil = null;
      // any remaining holders keep waiting for the next return
    }
    b.loan = { memberId, due: d + LOAN_DAYS, renewals: 0 };
    return { ok: true, dueDate: fromDay(b.loan.due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const d = toDay(date);
    if (Number.isNaN(d)) return { ok: false, reason: 'bad date' };
    advance(d);
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, reason: 'no such loan' };
    const late = Math.max(0, d - b.loan.due);
    const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
    m.owed += fine;
    b.loan = null;
    if (b.holds.length) b.readyUntil = d + PICKUP_DAYS;
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const d = toDay(date);
    if (Number.isNaN(d)) return { ok: false, reason: 'bad date' };
    advance(d);
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, reason: 'no such loan' };
    if (d > b.loan.due) return { ok: false, reason: 'overdue' };
    if (b.loan.renewals >= MAX_RENEWALS) return { ok: false, reason: 'renewal limit' };
    if (b.holds.length) return { ok: false, reason: 'held by others' };
    b.loan.renewals++;
    b.loan.due = d + LOAN_DAYS;
    return { ok: true, dueDate: fromDay(b.loan.due) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const d = toDay(date);
    if (Number.isNaN(d)) return { ok: false, reason: 'bad date' };
    advance(d);
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return { ok: false, reason: 'unknown' };
    if (!b.loan) return { ok: false, reason: 'book available' };
    if (b.loan.memberId === memberId) return { ok: false, reason: 'already borrowed by member' };
    if (b.holds.includes(memberId)) return { ok: false, reason: 'already holding' };
    b.holds.push(memberId);
    return { ok: true, position: b.holds.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const d = toDay(date);
    if (Number.isNaN(d)) return { ok: false, reason: 'bad date' };
    advance(d);
    const m = members.get(memberId);
    if (!m) return { ok: false, reason: 'unknown' };
    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false, reason: 'bad amount' };
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember({ memberId, date } = {}) {
    const d = toDay(date);
    if (!Number.isNaN(d)) advance(d);
    const m = members.get(memberId);
    if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
    const loans = [], holds = [];
    for (const [bookId, b] of books) {
      if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: fromDay(b.loan.due) });
      const i = b.holds.indexOf(memberId);
      if (i >= 0) holds.push({
        bookId,
        position: i + 1,
        readyUntil: i === 0 && b.readyUntil !== null ? fromDay(b.readyUntil) : null,
      });
    }
    return { loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
