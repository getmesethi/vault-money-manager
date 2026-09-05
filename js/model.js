/* =========================================================
   model.js — default data, schema helpers, calculations.
   Everything here is pure functions over plain data so it's
   easy to unit-reason about and easy to re-derive dashboard
   numbers straight from the transaction log (never from
   manually-tracked running totals — see spec §31).
   ========================================================= */
const Model = (() => {

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const DEFAULT_CATEGORIES = [
    // Income
    { name: 'Salary Income', type: 'income', color: 'pal-1', icon: '💰' },
    { name: 'School Income', type: 'income', color: 'pal-2', icon: '🎓' },
    { name: 'Business Income', type: 'income', color: 'pal-6', icon: '🏢' },
    { name: 'Freelance Income', type: 'income', color: 'pal-9', icon: '💻' },
    { name: 'Interest', type: 'income', color: 'pal-4', icon: '🏦' },
    { name: 'Investment Income', type: 'income', color: 'pal-3', icon: '📈' },
    { name: 'Other Income', type: 'income', color: 'pal-7', icon: '➕' },
    // Expenses
    { name: 'Household', type: 'expense', color: 'pal-4', icon: '🏠' },
    { name: 'Groceries', type: 'expense', color: 'pal-1', icon: '🛒' },
    { name: 'Electricity', type: 'expense', color: 'pal-4', icon: '💡' },
    { name: 'Water', type: 'expense', color: 'pal-2', icon: '🚰' },
    { name: 'Internet', type: 'expense', color: 'pal-2', icon: '📶' },
    { name: 'Mobile', type: 'expense', color: 'pal-6', icon: '📱' },
    { name: 'School/Education', type: 'expense', color: 'pal-2', icon: '📚' },
    { name: 'Transport', type: 'expense', color: 'pal-6', icon: '🚌' },
    { name: 'Fuel', type: 'expense', color: 'pal-5', icon: '⛽' },
    { name: 'Medical', type: 'expense', color: 'pal-5', icon: '💊' },
    { name: 'Shopping', type: 'expense', color: 'pal-8', icon: '🛍️' },
    { name: 'Entertainment', type: 'expense', color: 'pal-3', icon: '🎬' },
    { name: 'Travel', type: 'expense', color: 'pal-6', icon: '✈️' },
    { name: 'Dining', type: 'expense', color: 'pal-0', icon: '🍽️' },
    { name: 'Card Expenditure', type: 'expense', color: 'pal-2', icon: '💳' },
    { name: 'UPI Expenditure', type: 'expense', color: 'pal-7', icon: '📲' },
    { name: 'Cash Expenditure', type: 'expense', color: 'pal-9', icon: '💵' },
    { name: 'Other Expense', type: 'expense', color: 'pal-5', icon: '➖' },
    // Financial
    { name: 'Savings', type: 'financial', color: 'pal-2', icon: '🏦' },
    { name: 'Investments', type: 'financial', color: 'pal-3', icon: '📊' },
    { name: 'Loans', type: 'financial', color: 'pal-5', icon: '📄' },
    { name: 'Credit Card', type: 'financial', color: 'pal-2', icon: '💳' },
    { name: 'Debt', type: 'financial', color: 'pal-5', icon: '⚠️' },
    { name: 'EMI', type: 'financial', color: 'pal-4', icon: '🧾' },
  ];

  const PALETTE = ['pal-0','pal-1','pal-2','pal-3','pal-4','pal-5','pal-6','pal-7','pal-8','pal-9'];
  const ICON_CHOICES = ['🏠','💰','🎓','🏢','💻','🏦','📈','➕','🛒','💡','🚰','📶','📱','📚','🚌','⛽','💊','🛍️','🎬','✈️','🍽️','💳','📲','💵','➖','📊','📄','⚠️','🧾','🎁','🐾','⚽','🎮','☕','👕','🔧','📷','🎵','🚗','🏥'];

  const PAYMENT_METHODS = ['Cash','UPI','Debit Card','Credit Card','Bank Transfer','Cheque','Other'];
  const ACCOUNT_TYPES = [
    { value: 'bank', label: 'Bank Account', icon: '🏦' },
    { value: 'cash', label: 'Cash', icon: '💵' },
    { value: 'upi', label: 'UPI', icon: '📲' },
    { value: 'credit_card', label: 'Credit Card', icon: '💳' },
    { value: 'savings', label: 'Savings Account', icon: '🏦' },
    { value: 'other', label: 'Other', icon: '💼' },
  ];

  function defaultCategories() {
    return DEFAULT_CATEGORIES.map((c, i) => ({ id: uid('cat'), order: i, archived: false, ...c }));
  }

  function emptyData() {
    return {
      accounts: [],
      categories: defaultCategories(),
      transactions: [],
      budgets: [],
      recurring: [],
      upiIds: [],
    };
  }

  function seedAccount(type, openingBalance) {
    const meta = ACCOUNT_TYPES.find(a => a.value === type) || ACCOUNT_TYPES[5];
    return { id: uid('acc'), name: meta.label, type, openingBalance: openingBalance || 0, archived: false };
  }

  // ---------------- Date helpers ----------------
  function todayStr() { return fmtDate(new Date()); }
  function fmtDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function humanDate(s) {
    const d = parseDate(s);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function humanDateShort(s) {
    const d = parseDate(s);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }
  function humanTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
  }
  function monthKey(s) { return s.slice(0, 7); }
  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  function rangeForPeriod(period, custom) {
    const now = new Date();
    let start, end;
    if (period === 'today') { start = end = new Date(now); }
    else if (period === 'week') {
      const day = now.getDay();
      start = new Date(now); start.setDate(now.getDate() - day);
      end = new Date(now);
    } else if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now);
    } else if (period === 'lastmonth') {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
    } else if (period === 'year') {
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now);
    } else if (period === 'custom' && custom) {
      start = parseDate(custom.from); end = parseDate(custom.to);
    } else if (period === 'all') {
      return null;
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(now);
    }
    return { from: fmtDate(start), to: fmtDate(end) };
  }

  function inRange(dateStr, range) {
    if (!range) return true;
    return dateStr >= range.from && dateStr <= range.to;
  }

  // ---------------- Calculations ----------------
  function txnsInRange(transactions, range) {
    return transactions.filter(t => inRange(t.date, range));
  }

  function sumCredit(transactions) { return transactions.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0); }
  function sumDebit(transactions) { return transactions.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0); }

  function accountBalance(account, transactions) {
    const own = transactions.filter(t => t.accountId === account.id);
    return account.openingBalance + sumCredit(own) - sumDebit(own);
  }

  function totalBalance(accounts, transactions) {
    return accounts.filter(a => !a.archived && a.type !== 'credit_card')
      .reduce((s, a) => s + accountBalance(a, transactions), 0)
      + accounts.filter(a => !a.archived && a.type === 'credit_card')
        .reduce((s, a) => s + accountBalance(a, transactions), 0); // credit card balance included (usually negative-ish outstanding modeled as debit)
  }

  function categoryTotal(categoryId, transactions, range) {
    const list = txnsInRange(transactions, range).filter(t => t.categoryId === categoryId);
    return sumCredit(list) - 0 + sumDebit(list); // magnitude shown on card = total activity
  }
  function categoryNet(categoryId, transactions, range) {
    const list = txnsInRange(transactions, range).filter(t => t.categoryId === categoryId);
    return sumCredit(list) - sumDebit(list);
  }

  function creditDebtOutstanding(accounts, categories, transactions) {
    const ccAccounts = accounts.filter(a => a.type === 'credit_card' && !a.archived);
    let ccDebt = 0;
    ccAccounts.forEach(a => { const bal = accountBalance(a, transactions); if (bal < 0) ccDebt += -bal; });
    const debtCats = categories.filter(c => ['Loans', 'Debt', 'EMI'].includes(c.name)).map(c => c.id);
    let catDebt = 0;
    debtCats.forEach(id => { const net = categoryNet(id, transactions, null); if (net < 0) catDebt += -net; });
    return ccDebt + catDebt;
  }

  function investmentTotal(categories, transactions) {
    const cat = categories.find(c => c.name === 'Investments');
    if (!cat) return 0;
    const net = categoryNet(cat.id, transactions, null);
    return net < 0 ? -net : 0;
  }

  function expenseByCategory(categories, transactions, range) {
    const list = txnsInRange(transactions, range).filter(t => t.type === 'debit');
    const map = {};
    list.forEach(t => { map[t.categoryId] = (map[t.categoryId] || 0) + t.amount; });
    return Object.entries(map).map(([categoryId, amount]) => ({
      categoryId, amount, category: categories.find(c => c.id === categoryId)
    })).filter(x => x.category).sort((a, b) => b.amount - a.amount);
  }

  function monthlySeries(transactions, months) {
    const now = new Date();
    const keys = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(fmtDate(d).slice(0, 7));
    }
    return keys.map(key => {
      const list = transactions.filter(t => monthKey(t.date) === key);
      return { key, label: monthLabel(key), income: sumCredit(list), expense: sumDebit(list) };
    });
  }

  function budgetSpent(categoryId, transactions) {
    const now = new Date();
    const key = fmtDate(now).slice(0, 7);
    return transactions.filter(t => t.categoryId === categoryId && t.type === 'debit' && monthKey(t.date) === key)
      .reduce((s, t) => s + t.amount, 0);
  }

  function isValidUpi(id) {
    return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(id);
  }

  function currencyFmt(amount, symbol) {
    symbol = symbol || '₹';
    const n = Math.abs(amount || 0);
    const sign = amount < 0 ? '-' : '';
    let str;
    if (symbol === '₹') {
      // Indian digit grouping (e.g. 1,25,450)
      str = indianGroup(n.toFixed(n % 1 === 0 ? 0 : 2));
    } else {
      str = n.toLocaleString(undefined, { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
    }
    return `${sign}${symbol}${str}`;
  }
  function indianGroup(numStr) {
    const [intPart, dec] = numStr.split('.');
    let last3 = intPart.slice(-3);
    let rest = intPart.slice(0, -3);
    if (rest !== '') last3 = ',' + last3;
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return rest + last3 + (dec ? '.' + dec : '');
  }

  return {
    uid, DEFAULT_CATEGORIES, PALETTE, ICON_CHOICES, PAYMENT_METHODS, ACCOUNT_TYPES,
    defaultCategories, emptyData, seedAccount,
    todayStr, fmtDate, nowTime, parseDate, humanDate, humanDateShort, humanTime, monthKey, monthLabel,
    rangeForPeriod, inRange, txnsInRange, sumCredit, sumDebit,
    accountBalance, totalBalance, categoryTotal, categoryNet, creditDebtOutstanding, investmentTotal,
    expenseByCategory, monthlySeries, budgetSpent, isValidUpi, currencyFmt
  };
})();
