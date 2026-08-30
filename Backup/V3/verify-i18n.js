const fs = require('fs');
const html = fs.readFileSync('C:/Users/user/Desktop/BlackLab/BlackSpace/index.html', 'utf8');
const i18nBlock = html.match(/const I18N = \{([\s\S]*?)\};\s*\n\s*function t\(/);
if (!i18nBlock) {
  console.error('I18N block not found');
  process.exit(1);
}
const I18N = new Function('return {' + i18nBlock[1] + '}')();
const keys = [
  'lbl-total', 'sub-bank-inv', 'lbl-bank', 'sub-manual', 'lbl-investments', 'sub-cash-mktval',
  'lbl-total-spent', 'sub-all-time', 'lbl-avg-monthly', 'sub-excl-income',
  'lbl-annual-income', 'lbl-annual-exp', 'lbl-annual-inv', 'lbl-annual-cf', 'lbl-annual-savrate',
  'nav-dashboard', 'nav-monthly', 'nav-investments', 'nav-categories', 'nav-apps',
  'settings-language', 'settings-privacy', 'btn-signout',
  'card-ai-title', 'card-ai-sub', 'card-ai-refresh', 'card-monthly-trend', 'card-cat-annual', 'card-cat-monthly'
];
const missing = [];
for (const k of keys) {
  if (!I18N.zh[k]) missing.push('zh:' + k);
  if (!I18N.en[k]) missing.push('en:' + k);
}
console.log(missing.length ? ('Missing keys:\n' + missing.join('\n')) : 'All checked i18n keys present in zh and en');

const ids = ['dash-kpis', 'dash-v2-section', 'dash-line-chart', 'dash-donut-wrap', 'dash-ai-body', 'dash-ai-refresh', 'edit-bank-btn', 'settings-lang', 'app-wrapper', 'nav', 'mini-apps-menu'];
for (const id of ids) {
  if (!html.includes('id="' + id + '"')) console.log('MISSING ID:', id);
}
console.log('ID check done');
