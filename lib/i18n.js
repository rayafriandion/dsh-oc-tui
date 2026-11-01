// The TUI's message catalog and locale resolution. Every user-facing string the
// TUI paints or toasts comes from here: `lib/locales/<id>.js` holds the
// translations, English is the source catalog (and the fallback for any key a
// translation has not covered yet).
//
// A catalog is a flat `{ 'area.key': 'text' }` map. Interpolation uses `{name}`
// placeholders, and a plural entry is a family of keys suffixed with the CLDR
// plural categories: `key.one`, `key.other`, `key.few`, `key.many`, `key.zero`,
// `key.two`. `tn()` picks the category with Intl.PluralRules for the active
// locale, falling back to `key.other` and then to the base key.
import en from './locales/en.js'
import zhCN from './locales/zh-CN.js'
import zhTW from './locales/zh-TW.js'
import ja from './locales/ja.js'
import ko from './locales/ko.js'
import de from './locales/de.js'
import fr from './locales/fr.js'
import es from './locales/es.js'
import ptBR from './locales/pt-BR.js'
import ru from './locales/ru.js'
import it from './locales/it.js'
import tr from './locales/tr.js'
import vi from './locales/vi.js'
import id from './locales/id.js'
import pl from './locales/pl.js'
import nl from './locales/nl.js'
import ar from './locales/ar.js'

// The languages offered by Settings -> General -> Language, in the order the
// picker lists them. `native` is what the row shows (a user looking for their
// own language finds it in its own script); `english` is only used by the docs
// and the tests. `bcp47` feeds Intl (plural rules, number formatting).
export const LOCALES = Object.freeze([
  { id: 'en', native: 'English', english: 'English', bcp47: 'en' },
  { id: 'zh-CN', native: '简体中文', english: 'Simplified Chinese', bcp47: 'zh-Hans' },
  { id: 'zh-TW', native: '繁體中文', english: 'Traditional Chinese', bcp47: 'zh-Hant' },
  { id: 'ja', native: '日本語', english: 'Japanese', bcp47: 'ja' },
  { id: 'ko', native: '한국어', english: 'Korean', bcp47: 'ko' },
  { id: 'de', native: 'Deutsch', english: 'German', bcp47: 'de' },
  { id: 'fr', native: 'Français', english: 'French', bcp47: 'fr' },
  { id: 'es', native: 'Español', english: 'Spanish', bcp47: 'es' },
  { id: 'pt-BR', native: 'Português (Brasil)', english: 'Portuguese (Brazil)', bcp47: 'pt-BR' },
  { id: 'ru', native: 'Русский', english: 'Russian', bcp47: 'ru' },
  { id: 'it', native: 'Italiano', english: 'Italian', bcp47: 'it' },
  { id: 'tr', native: 'Türkçe', english: 'Turkish', bcp47: 'tr' },
  { id: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', bcp47: 'vi' },
  { id: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', bcp47: 'id' },
  { id: 'pl', native: 'Polski', english: 'Polish', bcp47: 'pl' },
  { id: 'nl', native: 'Nederlands', english: 'Dutch', bcp47: 'nl' },
  { id: 'ar', native: 'العربية', english: 'Arabic', bcp47: 'ar' },
])

const CATALOGS = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  'pt-BR': ptBR,
  ru,
  it,
  tr,
  vi,
  id,
  pl,
  nl,
  ar,
}

const LOCALE_IDS = LOCALES.map((entry) => entry.id)
const LOCALE_BY_ID = new Map(LOCALES.map((entry) => [entry.id, entry]))
// Lookup is case-insensitive (`pt-br` from `pt_BR`, `zh-tw` from `zh-TW`), but
// the value handed back is always the catalog's own spelling.
const LOCALE_ID_BY_LOWER = new Map(LOCALES.map((entry) => [entry.id.toLowerCase(), entry.id]))

// Aliases a locale can arrive under: POSIX env values (zh_CN.UTF-8), the
// WebUI's two-letter ids (zh), and regional variants that have no catalog of
// their own (en-US, pt-PT, es-419...).
const ALIASES = {
  zh: 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  pt: 'pt-BR',
  in: 'id',
  'pt-pt': 'pt-BR',
  'en-us': 'en',
  'en-gb': 'en',
  'es-419': 'es',
}

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

// English until the plugin resolves the configured language at boot. Tests and
// modules that never boot the plugin therefore render English.
let currentLocale = 'en'
const pluralRules = new Map()

function normalizeId(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/_/g, '-').toLowerCase()
  if (value === '' || value === 'system' || value === 'auto' || value === 'c' || value === 'posix') return null
  const exact = LOCALE_ID_BY_LOWER.get(value)
  if (exact) return exact
  if (ALIASES[value]) return ALIASES[value]
  // `ja-JP`, `de-DE`, `ru-RU`: the bare language id is the catalog.
  const base = value.split('-')[0]
  const byBase = LOCALE_ID_BY_LOWER.get(base)
  if (byBase) return byBase
  if (ALIASES[base]) return ALIASES[base]
  return null
}

// The POSIX/Windows language variables, most specific first. `DSH_TUI_LOCALE`
// wins so a single run can be pinned without touching the settings file.
export function detectSystemLocale(env = process.env) {
  for (const name of ['DSH_TUI_LOCALE', 'LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env?.[name]
    if (typeof value !== 'string' || value.trim() === '') continue
    // LANGUAGE can be a colon-separated priority list.
    for (const part of value.split(':')) {
      const id = normalizeId(part)
      if (id) return id
    }
  }
  // Windows exports none of the above: its locale lives in the OS regional
  // settings, which Node's ICU default reflects. Only the real environment is
  // consulted — a caller that passes an explicit table is asking about that
  // table, not about this machine.
  if (env !== process.env) return null
  try {
    return normalizeId(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return null
  }
}

// Resolve a stored preference ('system' or a locale id) to a catalog id.
export function resolveLocale(preference, env = process.env) {
  if (preference !== undefined && preference !== null) {
    const direct = normalizeId(preference)
    if (direct) return direct
  }
  return detectSystemLocale(env) ?? 'en'
}

export function isLocaleId(id) {
  return typeof id === 'string' && LOCALE_BY_ID.has(id)
}

export function localeInfo(id) {
  return LOCALE_BY_ID.get(id) ?? LOCALE_BY_ID.get('en')
}

export function getLocale() {
  return currentLocale
}

// Switch the active catalog. Returns the id actually in effect (an unknown id
// falls back to English instead of throwing — a stale settings value must not
// take the TUI down).
export function setLocale(id) {
  const next = normalizeId(id) ?? 'en'
  currentLocale = next
  return currentLocale
}

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}

function lookup(catalog, key) {
  const value = catalog?.[key]
  return typeof value === 'string' ? value : undefined
}

// The message for `key` in the active locale. A missing translation falls back
// to English; a key missing from both returns the key itself, which makes an
// uncovered string visible in the UI instead of painting "undefined".
export function t(key, params) {
  const catalog = CATALOGS[currentLocale] ?? en
  const message = lookup(catalog, key) ?? lookup(en, key) ?? key
  return interpolate(message, params)
}

function categoryFor(localeId, count) {
  const info = localeInfo(localeId)
  let rules = pluralRules.get(info.bcp47)
  if (!rules) {
    try {
      rules = new Intl.PluralRules(info.bcp47)
    } catch {
      rules = new Intl.PluralRules('en')
    }
    pluralRules.set(info.bcp47, rules)
  }
  try {
    return rules.select(count)
  } catch {
    return 'other'
  }
}

// A pluralized message: `tn('transcript.turns', 3, { count: 3 })` selects
// `transcript.turns.other` (or `.one`, `.few`... per the locale's CLDR rules).
// The base key itself is the last fallback so a catalog may store a single
// form for languages that do not inflect.
export function tn(key, count, params) {
  const catalog = CATALOGS[currentLocale] ?? en
  const category = categoryFor(currentLocale, count)
  const candidates = [key + '.' + category, key + '.other', key]
  for (const candidate of candidates) {
    const message = lookup(catalog, candidate) ?? lookup(en, candidate)
    if (message !== undefined) return interpolate(message, { count, n: count, ...params })
  }
  return key
}

// Stored ids whose label key is not simply `value.<id>`.
const VALUE_KEY_ALIASES = { 'text only': 'value.textOnly', 'text + image': 'value.textImage' }

// The label of a stored choice value (`auto`, `queue`, `halfblock`...). A value
// with no catalog entry is shown verbatim, which is what keeps ids such as a
// preset name or a provider id readable — and what lets the technical values
// (`halfblock`, `chip`, `stdio`, `http`, `sse`) stay untranslated on purpose.
export function tv(value) {
  const id = String(value)
  const catalog = CATALOGS[currentLocale] ?? en
  for (const key of [VALUE_KEY_ALIASES[id] ?? 'value.' + id, 'common.' + id]) {
    const message = lookup(catalog, key) ?? lookup(en, key)
    if (message !== undefined) return message
  }
  return id
}

// Choice rows for a settings field: translated labels, unchanged values.
export function valueChoices(values) {
  return values.map((value) => {
    const label = tv(value)
    return label === String(value) ? value : { label, value }
  })
}

// The keys a catalog is missing relative to English (used by the i18n tests and
// by translators to check their work).
export function catalogGaps(localeId) {
  const catalog = CATALOGS[localeId]
  if (!catalog) return null
  return Object.keys(en).filter((key) => typeof catalog[key] !== 'string')
}

// Extra keys a catalog carries that English does not know about (a typo in a
// translation file, or a stale key left behind by an English rename). A CLDR
// plural form English happens not to use (`ru` needs `.few`/`.many`, `ar` also
// `.zero`/`.two`) is not an extra: it is a form of a family English does define.
export function catalogExtras(localeId) {
  const catalog = CATALOGS[localeId]
  if (!catalog) return null
  return Object.keys(catalog).filter((key) => {
    if (typeof en[key] === 'string') return false
    const dot = key.lastIndexOf('.')
    if (dot < 0) return true
    if (!PLURAL_CATEGORIES.includes(key.slice(dot + 1))) return true
    return typeof en[key.slice(0, dot) + '.other'] !== 'string'
  })
}

export function catalogKeys() {
  return Object.keys(en)
}

export function hasLocale(id) {
  return Object.hasOwn(CATALOGS, id)
}
