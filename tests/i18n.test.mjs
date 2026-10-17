// i18n: the catalog layer itself (completeness, placeholder parity, plural
// selection) and the locale resolution the settings row and boot path share.
// Runs standalone — no dsh, no terminal.
import {
  LOCALES,
  catalogExtras,
  catalogGaps,
  catalogKeys,
  detectSystemLocale,
  getLocale,
  hasLocale,
  isLocaleId,
  localeInfo,
  resolveLocale,
  setLocale,
  t,
  tn,
  tv,
  valueChoices,
} from '../lib/i18n.js'
import en from '../lib/locales/en.js'

let failures = 0
function ok(name, condition) {
  if (condition) { console.log('ok   ' + name); return }
  failures++
  console.log('FAIL ' + name)
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { console.log('ok   ' + name); return }
  failures++
  console.log('FAIL ' + name + '\n     actual:   ' + a + '\n     expected: ' + b)
}

// ---- catalog shape --------------------------------------------------------

eq('18 locales are offered', LOCALES.length, 18)
ok('every locale id is unique', new Set(LOCALES.map((entry) => entry.id)).size === LOCALES.length)
ok('every locale has a native name and a bcp47 tag', LOCALES.every((entry) => entry.native && entry.bcp47))
ok('english is the first entry', LOCALES[0].id === 'en')
ok('every locale ships a catalog', LOCALES.every((entry) => hasLocale(entry.id)))
ok('chinese, japanese, korean, arabic and hindi are among them',
  ['zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'hi'].every((id) => isLocaleId(id)))

const sourceKeys = catalogKeys()
ok('the english source carries the whole UI', sourceKeys.length > 450)

// Plural families in the source: the base key must not exist on its own, and
// `.other` must always be present.
const pluralFamilies = new Map()
for (const key of sourceKeys) {
  const dot = key.lastIndexOf('.')
  if (dot < 0) continue
  const category = key.slice(dot + 1)
  if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(category)) continue
  const base = key.slice(0, dot)
  if (!pluralFamilies.has(base)) pluralFamilies.set(base, new Set())
  pluralFamilies.get(base).add(category)
}
ok('plural families exist', pluralFamilies.size >= 8)
ok('every plural family carries `.other`', [...pluralFamilies.values()].every((set) => set.has('other')))

// ---- per-locale completeness ---------------------------------------------

for (const { id, native } of LOCALES) {
  if (id === 'en') continue
  const gaps = catalogGaps(id)
  const extras = catalogExtras(id)
  ok(native + ': no missing keys (' + id + ')', gaps.length === 0)
  ok(native + ': no unknown keys (' + id + ')', extras.length === 0)
  if (gaps.length > 0) console.log('     missing: ' + gaps.slice(0, 8).join(', '))
  if (extras.length > 0) console.log('     unknown: ' + extras.slice(0, 8).join(', '))
}

// Placeholder parity: a translation must not drop, rename or invent a
// `{placeholder}`, and must keep the leading/trailing spaces that concatenated
// strings rely on.
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
const catalogFor = async (id) => (await import('../lib/locales/' + id + '.js')).default
for (const { id, native } of LOCALES) {
  if (id === 'en') continue
  const catalog = await catalogFor(id)
  const bad = []
  for (const key of sourceKeys) {
    const translation = catalog[key]
    if (typeof translation !== 'string') continue
    if (placeholders(translation) !== placeholders(en[key])) bad.push(key + ' (placeholders)')
    else if (translation !== translation.trim() && en[key] === en[key].trim()) bad.push(key + ' (space)')
    else if (translation === translation.trim() && en[key] !== en[key].trim()) bad.push(key + ' (space)')
  }
  ok(native + ': placeholders and spacing match (' + id + ')', bad.length === 0)
  if (bad.length > 0) console.log('     ' + bad.slice(0, 8).join(', '))
}

// ---- message resolution ---------------------------------------------------

setLocale('en')
eq('english lookup', t('settings.language'), 'Language')
eq('interpolation', t('session.modelSet', { model: 'x' }), 'model set to x (applies to the next request)')
eq('missing key surfaces as the key', t('no.such.key'), 'no.such.key')
eq('missing placeholder stays verbatim', t('session.modelSet', {}), 'model set to {model} (applies to the next request)')

// Plural selection across the languages that actually inflect.
setLocale('en')
eq('en 1 step', tn('transcript.steps', 1, { count: 1 }), '1 step')
eq('en 2 steps', tn('transcript.steps', 2, { count: 2 }), '2 steps')
setLocale('zh-CN')
ok('zh-CN plural resolves', tn('transcript.steps', 3, { count: 3 }).includes('3'))
setLocale('ru')
const ru1 = tn('transcript.steps', 1, { count: 1 })
const ru2 = tn('transcript.steps', 2, { count: 2 })
const ru5 = tn('transcript.steps', 5, { count: 5 })
ok('ru picks distinct forms for 1 / 2 / 5', new Set([ru1, ru2, ru5]).size === 3)
ok('ru forms are all native (no english fallback)', [ru1, ru2, ru5].every((form) => !/step/.test(form)))
setLocale('ar')
const ar0 = tn('transcript.steps', 0, { count: 0 })
ok('ar has a dedicated zero form', ar0 !== tn('transcript.steps', 3, { count: 3 }) && ar0 !== tn('transcript.steps', 11, { count: 11 }))
setLocale('en')

// A count the locale has no dedicated form for falls back to `.other`.
eq('unknown category falls back to .other', tn('transcript.steps', 1_000_000, { count: 1_000_000 }), '1000000 steps')

// ---- stored value labels --------------------------------------------------

setLocale('en')
eq('value label falls back to common.*', tv('on'), 'on')
eq('value label for a translated id', tv('text + image'), 'text + image')
eq('technical id renders verbatim', tv('halfblock'), 'halfblock')
setLocale('zh-CN')
eq('zh-CN queue label', tv('queue'), '排队')
eq('zh-CN text+image label', tv('text + image'), '文本 + 图像')
eq('zh-CN technical id stays verbatim', tv('stdio'), 'stdio')
eq('choice rows keep their value', valueChoices(['queue', 'steer'])[0].value, 'queue')
eq('choice rows translate their label', valueChoices(['queue', 'steer'])[0].label, '排队')
setLocale('en')

// ---- locale resolution ----------------------------------------------------

eq('explicit preference wins over the environment', resolveLocale('ja', { LANG: 'de_DE.UTF-8' }), 'ja')
eq('`system` reads the environment', resolveLocale('system', { LANG: 'de_DE.UTF-8' }), 'de')
eq('undefined preference reads the environment', resolveLocale(undefined, { LANG: 'fr_FR.UTF-8' }), 'fr')
eq('DSH_TUI_LOCALE wins over LANG', resolveLocale('system', { DSH_TUI_LOCALE: 'ko', LANG: 'de_DE.UTF-8' }), 'ko')
eq('LANGUAGE priority list', detectSystemLocale({ LANGUAGE: 'pt_BR:es' }), 'pt-BR')
eq('LC_ALL beats LANG', detectSystemLocale({ LC_ALL: 'it_IT.UTF-8', LANG: 'de_DE.UTF-8' }), 'it')
eq('a locale with a region and a codeset', resolveLocale('system', { LANG: 'ru_RU.KOI8-R' }), 'ru')
eq('no environment at all falls back to english', resolveLocale('system', {}), 'en')
eq('an unknown preference falls back to english', resolveLocale('kl_GL', {}), 'en')
eq('aliases: zh', resolveLocale('zh', {}), 'zh-CN')
eq('aliases: zh-hans', resolveLocale('zh-hans', {}), 'zh-CN')
eq('aliases: zh-hant', resolveLocale('zh-hant', {}), 'zh-TW')
eq('aliases: pt-PT', resolveLocale('pt-PT', {}), 'pt-BR')
eq('aliases: en-US', resolveLocale('en-US', {}), 'en')
eq('aliases: a bare country code', resolveLocale('de-AT', {}), 'de')

// ---- switching ------------------------------------------------------------

eq('setLocale returns the id in effect', setLocale('ja'), 'ja')
eq('getLocale reports it', getLocale(), 'ja')
eq('the interface is translated', t('settings.language'), '言語')
eq('an unknown id falls back to english', setLocale('xx-YY'), 'en')
eq('and the catalog follows', t('settings.language'), 'Language')
eq('localeInfo names the language', localeInfo('zh-TW').native, '繁體中文')
eq('localeInfo of an unknown id degrades to english', localeInfo('xx').id, 'en')

if (failures > 0) {
  console.log('\n' + failures + ' test(s) failed')
  process.exitCode = 1
} else {
  console.log('\nall i18n tests passed')
}
