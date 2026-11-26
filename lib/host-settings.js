import z from '@deepseek-ai/schemastery'
import { t, tv } from './i18n.js'
import { valueAt } from './providers.js'

function walk(node, path) {
  if (!node || path.length === 0) return node
  if (node.type === 'union' || node.type === 'intersect') {
    return node.list?.map((part) => walk(part, path)).find(Boolean)
  }
  const [key, ...rest] = path
  return walk(node.type === 'object' ? node.dict?.[key] : node.inner, rest)
}

export function settingSchema(descriptor, path) {
  try { return walk(new z(descriptor.schema), path) } catch { return undefined }
}

function descriptorFor(descriptors, preferred, fields) {
  const matches = ([, descriptor]) => fields.every((field) => settingSchema(descriptor, [field]))
  const named = descriptors.get(preferred)
  if (named && matches([preferred, named])) return [preferred, named]
  const candidates = [...descriptors].filter(matches)
  return candidates.length === 1 ? candidates[0] : undefined
}

function hostRow(ns, descriptor, path, label, { options, type = 'string', fallback, ...extra } = {}) {
  const raw = valueAt(descriptor.value, path)
  const value = raw === undefined ? 'default' : type === 'list' ? raw.join(', ') : String(raw)
  return {
    kind: 'host-setting', ns, path, label, value,
    valueLabel: value === 'default' ? (fallback === undefined ? tv('auto') : String(fallback)) : value,
    options, valueType: type, revision: descriptor.revision,
    ...extra,
  }
}

export function webSettingRows(ctx, descriptors, writable) {
  const items = []
  const web = descriptorFor(descriptors, 'web', ['searchProvider', 'fetchProvider'])
  if (web) {
    const [ns, descriptor] = web
    let providers
    try { providers = ctx.get('web')?.listProviders?.() } catch { /* not ready */ }
    for (const capability of ['search', 'fetch']) {
      const choices = [{ value: 'default', label: tv('auto') },
        ...(providers?.[capability] ?? []).map((provider) => ({ value: provider.id, label: provider.title || provider.id }))]
      const field = capability + 'Provider'
      const stored = descriptor.value?.[field]
      if (stored && !choices.some((choice) => choice.value === stored)) choices.push({ value: stored, label: stored })
      items.push(hostRow(ns, descriptor, [field], t('web.' + field), { options: choices, disabled: !writable }))
    }
  }
  const api = descriptorFor(descriptors, 'web-deepseek-api', ['searchBilling', 'fetchBilling'])
  if (api) {
    const [ns, descriptor] = api
    for (const field of ['searchBilling', 'fetchBilling']) {
      const node = settingSchema(descriptor, [field])
      const options = node?.list?.filter((entry) => typeof entry.value === 'string')
        .map((entry) => ({ value: entry.value, label: t('web.billing.' + entry.value) }))
      if (options?.length) items.push(hostRow(ns, descriptor, [field], t('web.' + field), {
        options, disabled: !writable, value: descriptor.value?.[field] ?? node.meta?.default ?? 'auto',
        valueLabel: t('web.billing.' + (descriptor.value?.[field] ?? node.meta?.default ?? 'auto')),
      }))
    }
  }
  return items.length ? [{ kind: 'header', label: t('web.title'), disabled: true, value: '' }, ...items] : []
}

export function retrySettingRows(ns, descriptor, path, writable) {
  const base = [...path, 'retryPolicy']
  if (!settingSchema(descriptor, base)) return []
  const policy = valueAt(descriptor.value, base)
  const inherited = { value: 'default', label: tv('auto') }
  const items = [hostRow(ns, descriptor, base, t('retry.mode'), {
    options: [inherited, ...['normal', 'always'].map((mode) => ({ value: mode, label: t('retry.' + mode) }))],
    value: policy?.mode ?? 'default',
    valueLabel: policy?.mode ? t('retry.' + policy.mode) : tv('auto'),
    retryMode: true, disabled: !writable,
  })]
  const fields = [
    ['maxRetries', 'number'], ['retryableCodes', 'list'],
    ['backoff.initialDelayMs', 'number'], ['backoff.maxDelayMs', 'number'], ['backoff.jitterRatio', 'number'],
  ]
  for (const [field, type] of fields) {
    if (policy?.mode === 'always' && !field.startsWith('backoff.')) continue
    const fieldPath = [...base, ...field.split('.')]
    const node = settingSchema(descriptor, fieldPath)
    if (!node) continue
    const fallback = node.meta?.default
    items.push(hostRow(ns, descriptor, fieldPath, t('retry.' + field.split('.').at(-1)), {
      type, fallback: Array.isArray(fallback) ? fallback.join(', ') : fallback,
      ensureMode: policy?.mode ? undefined : [...base, 'mode'],
      disabled: !writable, indent: 1,
    }))
  }
  return items
}

export async function saveHostSetting(settings, item, input) {
  const text = input.trim()
  const reset = text === '' || text === 'default'
  let value = text
  if (!reset && item.retryMode) {
    const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === item.ns)
    const previous = valueAt(descriptor?.value, item.path)
    value = { ...previous, mode: text }
    if (text === 'always') { delete value.maxRetries; delete value.retryableCodes }
  } else if (!reset && item.valueType === 'number') {
    value = Number(text)
    if (!Number.isFinite(value)) throw new Error(t('retry.invalidNumber'))
  } else if (!reset && item.valueType === 'list') {
    value = [...new Set(text.split(',').map((code) => code.trim()).filter(Boolean))]
  }
  const ops = []
  if (!reset && item.ensureMode) ops.push({ op: 'set', path: item.ensureMode, value: 'normal' })
  ops.push(reset ? { op: 'unset', path: item.path } : { op: 'set', path: item.path, value })
  return settings.mutate(item.ns, ops, item.revision)
}
