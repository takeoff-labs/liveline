import type { LivelinePalette, ChartLayout, OrderbookData, TradeStreamData, TradeStreamEvent } from '../types'

// Green: rgb(34, 197, 94), Red: rgb(239, 68, 68)
const GREEN: [number, number, number] = [34, 197, 94]
const RED: [number, number, number] = [239, 68, 68]

interface StreamLabel {
  y: number
  text: string
  green: boolean
  life: number
  maxLife: number
  intensity: number // 0-1, bigger orders = brighter
}

export interface OrderbookState {
  labels: StreamLabel[]
  spawnTimer: number
  smoothSpeed: number
  seenTradeIds: Set<string | number>
  seenTradeQueue: Array<string | number>
  // Orderbook churn tracking
  prevBidTotal: number
  prevAskTotal: number
  churnRate: number // smoothed 0-1, how much the book is changing
}

export function createOrderbookState(): OrderbookState {
  return {
    labels: [], spawnTimer: 0, smoothSpeed: BASE_SPEED,
    seenTradeIds: new Set(), seenTradeQueue: [],
    prevBidTotal: 0, prevAskTotal: 0, churnRate: 0,
  }
}

const MAX_LABELS = 50
const LABEL_LIFETIME = 6 // seconds
const SPAWN_INTERVAL = 40 // ms
const MIN_LABEL_GAP = 22 // px
const BASE_SPEED = 60 // px/s calm
const MAX_SPEED = 160 // px/s during big activity
const MAX_SEEN_TRADES = 1000

function mixColor(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): string {
  const r = Math.round(from[0] + (to[0] - from[0]) * t)
  const g = Math.round(from[1] + (to[1] - from[1]) * t)
  const b = Math.round(from[2] + (to[2] - from[2]) * t)
  return `rgb(${r},${g},${b})`
}

function normalizeTradeStream(tradeStream?: TradeStreamData | null): TradeStreamEvent[] {
  if (!tradeStream) return []
  return Array.isArray(tradeStream) ? tradeStream : [tradeStream]
}

function rememberTrade(state: OrderbookState, id: string | number): void {
  if (state.seenTradeIds.has(id)) return
  state.seenTradeIds.add(id)
  state.seenTradeQueue.push(id)
  while (state.seenTradeQueue.length > MAX_SEEN_TRADES) {
    const oldId = state.seenTradeQueue.shift()
    if (oldId !== undefined) state.seenTradeIds.delete(oldId)
  }
}

function pushLabel(
  state: OrderbookState,
  bottomY: number,
  size: number,
  green: boolean,
  intensity: number,
  yOffset = 0,
): void {
  if (state.labels.length >= MAX_LABELS) return
  state.labels.push({
    y: bottomY - yOffset,
    text: `+ ${formatSize(size)}`,
    green,
    life: LABEL_LIFETIME,
    maxLife: LABEL_LIFETIME,
    intensity,
  })
}

/**
 * Kalshi-style orderbook: left-aligned column spanning full chart height.
 * Labels decelerate as they rise — fast entry at bottom, slow drift at top.
 * Speed driven by two signals:
 *   1. swingMagnitude — price momentum (proxy for activity)
 *   2. orderbook churn — how much the bid/ask data itself is changing
 * Whichever signal is stronger wins. Works with both demo and production data.
 */
export function drawOrderbook(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  orderbook: OrderbookData | undefined,
  dt: number,
  state: OrderbookState,
  swingMagnitude: number,
  tradeStream?: TradeStreamData | null,
): void {
  const { pad, h, chartH } = layout
  const dtSec = dt / 1000

  let maxSize = 0
  let bidTotal = 0
  let askTotal = 0
  const bids = orderbook?.bids ?? []
  const asks = orderbook?.asks ?? []
  const hasBookLevels = bids.length > 0 || asks.length > 0
  for (const [, size] of bids) { bidTotal += size; if (size > maxSize) maxSize = size }
  for (const [, size] of asks) { askTotal += size; if (size > maxSize) maxSize = size }

  const tradeEvents = normalizeTradeStream(tradeStream)
  for (const trade of tradeEvents) {
    if (trade.size > maxSize) maxSize = trade.size
  }

  // Measure orderbook churn: how much total size changed since last frame
  // Normalized by the total size so it's scale-independent
  const totalSize = bidTotal + askTotal
  const prevTotal = state.prevBidTotal + state.prevAskTotal
  let churnSignal = 0
  if (prevTotal > 0) {
    const delta = Math.abs(bidTotal - state.prevBidTotal) + Math.abs(askTotal - state.prevAskTotal)
    churnSignal = Math.min(delta / prevTotal, 1) // 0-1
  }
  state.prevBidTotal = bidTotal
  state.prevAskTotal = askTotal

  // Smooth the churn rate (fast attack, slower decay)
  const churnLerp = churnSignal > state.churnRate ? 0.3 : 0.05
  state.churnRate += (churnSignal - state.churnRate) * churnLerp

  // Activity = max of price momentum and orderbook churn
  const activity = Math.max(Math.min(swingMagnitude * 5, 1), state.churnRate)

  // Drive speed from activity
  const targetSpeed = BASE_SPEED + activity * (MAX_SPEED - BASE_SPEED)
  const speedLerp = 1 - Math.pow(0.95, dt / 16.67)
  state.smoothSpeed += (targetSpeed - state.smoothSpeed) * speedLerp
  const speed = state.smoothSpeed

  const labelX = pad.left + 8
  const bottomY = h - pad.bottom - 6
  const topY = pad.top
  const bg = palette.bgRgb

  // Discrete trade tape: spawn exactly once per unseen trade id, no timer.
  let tradeSpawnOffset = 0
  for (const trade of tradeEvents) {
    if (state.seenTradeIds.has(trade.id)) continue
    rememberTrade(state, trade.id)
    if (trade.size <= 0) continue
    const sizeRatio = maxSize > 0 ? Math.min(trade.size / maxSize, 1) : 1
    pushLabel(
      state,
      bottomY,
      trade.size,
      trade.side === 'buy',
      0.5 + sizeRatio * 0.5,
      tradeSpawnOffset,
    )
    tradeSpawnOffset += MIN_LABEL_GAP
  }

  // Spawn new labels at bottom
  if (hasBookLevels && maxSize > 0) {
    state.spawnTimer += dt
  }
  while (hasBookLevels && maxSize > 0 && state.spawnTimer >= SPAWN_INTERVAL && state.labels.length < MAX_LABELS) {
    state.spawnTimer -= SPAWN_INTERVAL

    // Check overlap against ALL existing labels near spawn point
    let tooClose = false
    for (let j = 0; j < state.labels.length; j++) {
      if (Math.abs(state.labels[j].y - bottomY) < MIN_LABEL_GAP) {
        tooClose = true
        break
      }
    }
    if (tooClose) break

    // Weighted random pick
    const allLevels: { size: number; green: boolean }[] = []
    for (const [, size] of bids) {
      if (size > 0) allLevels.push({ size, green: true })
    }
    for (const [, size] of asks) {
      if (size > 0) allLevels.push({ size, green: false })
    }
    if (allLevels.length === 0) break

    let totalWeight = 0
    for (const l of allLevels) totalWeight += l.size
    let r = Math.random() * totalWeight
    let picked = allLevels[0]
    for (const l of allLevels) {
      r -= l.size
      if (r <= 0) { picked = l; break }
    }

    const sizeRatio = picked.size / maxSize
    pushLabel(state, bottomY, picked.size, picked.green, 0.5 + sizeRatio * 0.5)
  }
  if (!hasBookLevels) state.spawnTimer = 0

  // Update positions — decelerate as labels rise (fast at bottom, slow at top)
  const range = bottomY - topY
  let writeIdx = 0
  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i]
    l.life -= dtSec
    if (l.life <= 0) continue
    const yProgress = range > 0 ? (l.y - topY) / range : 1 // 1 at bottom, 0 at top
    l.y -= speed * (0.7 + 0.3 * yProgress) * dtSec
    if (l.y < topY - 14) continue
    state.labels[writeIdx++] = l
  }
  state.labels.length = writeIdx

  if (state.labels.length === 0) return

  // Draw
  const baseAlpha = ctx.globalAlpha
  ctx.save()
  ctx.font = '600 13px "SF Mono", Menlo, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = baseAlpha

  const outlineColor = `rgb(${bg[0]},${bg[1]},${bg[2]})`

  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i]
    const lifeRatio = l.life / l.maxLife

    // Fade in quickly, fade out near top of chart
    const fadeIn = Math.min((1 - lifeRatio) * 10, 1)
    const yRatio = (l.y - topY) / chartH
    const fadeOut = yRatio < 0.45 ? yRatio / 0.45 : 1

    const colorStrength = l.intensity * fadeIn * fadeOut
    const baseColor = l.green ? GREEN : RED
    const fillColor = mixColor(baseColor, bg, 1 - colorStrength)

    ctx.strokeStyle = outlineColor
    ctx.lineWidth = 4
    ctx.lineJoin = 'round'
    ctx.strokeText(l.text, labelX, l.y)

    ctx.fillStyle = fillColor
    ctx.fillText(l.text, labelX, l.y)
  }

  ctx.restore()
}

function formatSize(size: number): string {
  if (size >= 10) return `$${Math.round(size)}`
  if (size >= 1) return `$${size.toFixed(1)}`
  return `$${size.toFixed(2)}`
}
