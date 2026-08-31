import type { ProductFeedbackFrontendDiagnostic } from '@gadgets/workshop-shared/product-feedback'
import { PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH, PRODUCT_FEEDBACK_MAX_DIAGNOSTICS, sanitizeProductFeedbackText } from '@gadgets/workshop-shared/product-feedback'

const MAX_ENTRIES = PRODUCT_FEEDBACK_MAX_DIAGNOSTICS
const MAX_MESSAGE = PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH

const entries: ProductFeedbackFrontendDiagnostic[] = []

function push(level: ProductFeedbackFrontendDiagnostic['level'], message: string) {
  entries.push({ timestamp: new Date(), level, message: sanitizeProductFeedbackText(message).slice(0, MAX_MESSAGE) })
  while (entries.length > MAX_ENTRIES) entries.shift()
}

function formatArgs(args: unknown[]): string {
  return args.map((arg) => safePreview(arg)).join(' ')
}

function safePreview(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return '[symbol]'
  if (typeof value === 'function') return '[function]'
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (depth >= 2 || typeof value !== 'object') return '[object]'
  if (Array.isArray(value)) return `[${value.slice(0, 8).map((item) => safePreview(item, depth + 1)).join(', ')}${value.length > 8 ? ', …' : ''}]`
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `[${proto?.constructor?.name ?? 'object'}]`
  const out: string[] = []
  for (const key of Object.keys(value as Record<string, unknown>).slice(0, 8)) {
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !('value' in desc)) continue
    out.push(`${key}: ${safePreview(desc.value, depth + 1)}`)
  }
  return `{${out.join(', ')}${Object.keys(value as Record<string, unknown>).length > 8 ? ', …' : ''}}`
}

let installed = false

/** Installs a bounded current-tab diagnostic ring buffer for explicit feedback submissions. */
export function installProductFeedbackDiagnostics() {
  if (installed || typeof window === 'undefined') return
  installed = true
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      push(level, formatArgs(args))
      original.apply(console, args)
    }
  }
  window.addEventListener('error', (event) => push('error', event.message))
  window.addEventListener('unhandledrejection', (event) => push('error', `Unhandled rejection: ${String(event.reason)}`))
}

/** Returns a snapshot of current-tab diagnostics for a consented feedback submission. */
export function productFeedbackDiagnosticsSnapshot(): ProductFeedbackFrontendDiagnostic[] {
  return entries.slice()
}
