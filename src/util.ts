import type { Payload, PayloadRequest } from 'payload'

import type { ID, Req, ResolvedNotifications } from './types.js'

export const configOf = (payload: Payload): ResolvedNotifications => {
  const o = payload.config.custom?.notifications as ResolvedNotifications | undefined
  if (!o) throw new Error('Notifications: the plugin is not configured on this site.')
  return o
}

export const idOf = (v: unknown): ID | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object') return ((v as { id?: ID }).id ?? null) as ID | null
  return v as ID
}

export const asReq = (payload: Payload, req?: Req) => ({ ...(req ?? {}), payload }) as PayloadRequest

/** A failure's name and code only: messages from mail servers and databases can carry addresses and values. */
export const errorShape = (error: unknown) => {
  const e = error as { name?: unknown; code?: unknown } | null
  return { error: typeof e?.name === 'string' ? e.name : 'Error', ...(typeof e?.code === 'string' || typeof e?.code === 'number' ? { code: e.code } : {}) }
}

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
