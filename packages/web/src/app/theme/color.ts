import { T3_CHAT_THEME, type ThemeAppearance, type ThemeColors } from "./palettes.ts"

export type ThemeRgbColor = {
  r: number
  g: number
  b: number
}

export type ThemeOklch = { L: number; C: number; h: number }
export type ParsedThemeColor = { color: ThemeOklch; alpha: number }

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 }
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 }
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 }
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 }

const HEX_PATTERN = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
const OKLCH_PATTERN =
  /^oklch\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg)?)\s*(?:\/\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*)?\)$/i
const RGB_PATTERN =
  /^rgba?\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*(?:,?\s+|,)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*(?:,?\s+|,)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*(?:(?:,|\/)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*)?\)$/i
const HSL_PATTERN =
  /^hsla?\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|turn)?)\s*(?:,?\s+|,)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*(?:,?\s+|,)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*(?:(?:,|\/)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%)?)\s*)?\)$/i

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const parseChannel = (text: string, max: number): number | null => {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(%)?$/.exec(text.trim())
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return match[2] === "%" ? (value / 100) * max : value
}

const parseAlpha = (text: string | undefined): number | null => {
  if (text === undefined) return 1
  const value = parseChannel(text, 1)
  return value === null ? null : clamp01(value)
}

const parseHue = (text: string): number | null => {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|turn)?$/.exec(text.trim())
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return match[2] === "turn" ? value * 360 : value
}

const hslToRgb = (hue: number, saturation: number, lightness: number): ThemeRgbColor => {
  const h = (((hue % 360) + 360) % 360) / 360
  const s = clamp01(saturation)
  const l = clamp01(lightness)
  const channel = (n: number): number => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return { r: channel(0) * 255, g: channel(8) * 255, b: channel(4) * 255 }
}

const srgbChannelToLinear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export const themeRgbToOklch = (color: ThemeRgbColor): ThemeOklch => {
  const r = srgbChannelToLinear(color.r)
  const g = srgbChannelToLinear(color.g)
  const b = srgbChannelToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

const parseHexColor = (input: string): ParsedThemeColor | null => {
  const match = HEX_PATTERN.exec(input)
  if (match === null) return null
  const hex = match[1] ?? ""
  const expand = (text: string): number => Number.parseInt(text.length === 1 ? text + text : text, 16)
  if (hex.length === 3 || hex.length === 4) {
    const r = expand(hex[0] ?? "0")
    const g = expand(hex[1] ?? "0")
    const b = expand(hex[2] ?? "0")
    const alpha = hex.length === 4 ? expand(hex[3] ?? "f") / 255 : 1
    return { color: themeRgbToOklch({ r, g, b }), alpha }
  }
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
  if (![r, g, b].every(Number.isFinite)) return null
  return { color: themeRgbToOklch({ r, g, b }), alpha }
}

const parseOklchColor = (input: string): ParsedThemeColor | null => {
  const match = OKLCH_PATTERN.exec(input)
  if (match === null) return null
  const lightnessText = match[1] ?? ""
  const chromaText = match[2] ?? ""
  const hueText = match[3] ?? ""
  const lightness = lightnessText.endsWith("%") ? (Number(lightnessText.slice(0, -1)) / 100) * 1 : Number(lightnessText)
  const chroma = Number(chromaText)
  const hue = parseHue(hueText)
  const alpha = parseAlpha(match[4])
  if (!Number.isFinite(lightness) || !Number.isFinite(chroma) || hue === null || alpha === null) return null
  return { color: { L: lightness, C: Math.max(0, chroma), h: hue }, alpha }
}

const parseRgbColor = (input: string): ParsedThemeColor | null => {
  const match = RGB_PATTERN.exec(input)
  if (match === null) return null
  const r = parseChannel(match[1] ?? "", 255)
  const g = parseChannel(match[2] ?? "", 255)
  const b = parseChannel(match[3] ?? "", 255)
  const alpha = parseAlpha(match[4])
  if (r === null || g === null || b === null || alpha === null) return null
  return { color: themeRgbToOklch({ r, g, b }), alpha }
}

const parseHslColor = (input: string): ParsedThemeColor | null => {
  const match = HSL_PATTERN.exec(input)
  if (match === null) return null
  const hue = parseHue(match[1] ?? "")
  const saturation = parseChannel(match[2] ?? "", 1)
  const lightness = parseChannel(match[3] ?? "", 1)
  const alpha = parseAlpha(match[4])
  if (hue === null || saturation === null || lightness === null || alpha === null) return null
  return { color: themeRgbToOklch(hslToRgb(hue, saturation, lightness)), alpha }
}

export const parseThemeColor = (value: unknown): ParsedThemeColor | null => {
  if (typeof value !== "string") return null
  const input = value.trim()
  if (input === "") return null
  const parsed = parseHexColor(input) ?? parseOklchColor(input) ?? parseRgbColor(input) ?? parseHslColor(input)
  if (parsed === null) return null
  const { color, alpha } = parsed
  if (![color.L, color.C, color.h, alpha].every(Number.isFinite)) return null
  return { color: { L: Math.min(1, Math.max(0, color.L)), C: Math.max(0, color.C), h: color.h }, alpha: clamp01(alpha) }
}

const formatThemeColorNumber = (value: number, precision: number): string => {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1")
}

export const formatOklchThemeColor = (color: ThemeOklch, alpha = 1): string => {
  const normalizedHue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360
  const body = `${formatThemeColorNumber(color.L, 6)} ${formatThemeColorNumber(color.C, 6)} ${formatThemeColorNumber(normalizedHue, 3)}`
  return alpha < 1 ? `oklch(${body} / ${formatThemeColorNumber(alpha, 4)})` : `oklch(${body})`
}

/** Canonical stored form for theme colors: an oklch literal, or null when the value is not a color. */
export const toCanonicalThemeColor = (value: unknown): string | null => {
  const parsed = parseThemeColor(value)
  return parsed ? formatOklchThemeColor(parsed.color, parsed.alpha) : null
}

export const isThemeColor = (value: unknown): value is string => toCanonicalThemeColor(value) !== null

const linearChannelToSrgb = (channel: number, round = true): number => {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  const srgb = Math.min(1, Math.max(0, c)) * 255
  return round ? Math.round(srgb) : srgb
}

const oklchToRgbUnclamped = ({ L, C, h }: ThemeOklch): { r: number; g: number; b: number } => {
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const bb = C * Math.sin(hr)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

const mapThemeOklchToSrgbGamut = (color: ThemeOklch): ThemeOklch => {
  const isInGamut = (chroma: number): boolean => {
    const linear = oklchToRgbUnclamped({ ...color, C: chroma })
    return [linear.r, linear.g, linear.b].every((channel) => channel >= -0.0001 && channel <= 1.0001)
  }
  if (isInGamut(color.C)) return color
  let low = 0
  let high = color.C
  const chromaResolution = 0.000001
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(color.C, chromaResolution)) - Math.log2(chromaResolution)))
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2
    if (isInGamut(mid)) low = mid
    else high = mid
  }
  return { ...color, C: low }
}

export const themeOklchToRgb = (color: ThemeOklch, round = true): ThemeRgbColor => {
  const linear = oklchToRgbUnclamped(mapThemeOklchToSrgbGamut(color))
  return {
    r: linearChannelToSrgb(linear.r, round),
    g: linearChannelToSrgb(linear.g, round),
    b: linearChannelToSrgb(linear.b, round),
  }
}

const themeRgbToHexColor = (color: ThemeRgbColor): string =>
  `#${[color.r, color.g, color.b].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`

const themeOklchToThemeColor = (color: ThemeOklch): string => formatOklchThemeColor(mapThemeOklchToSrgbGamut(color))

/** Hex form of a stored theme color, with an alpha suffix when the color is translucent. */
export const themeColorToHex = (value: string): string | null => {
  const parsed = parseThemeColor(value)
  if (parsed === null) return null
  const opaque = themeRgbToHexColor(themeOklchToRgb(parsed.color))
  if (parsed.alpha >= 1) return opaque
  return `${opaque}${Math.round(parsed.alpha * 255).toString(16).padStart(2, "0")}`
}

export const parseThemeRgbColor = (value: string, fallback: ThemeRgbColor): ThemeRgbColor => {
  const parsed = parseThemeColor(value)
  return parsed ? themeOklchToRgb(parsed.color) : fallback
}

export const mixThemeRgbColors = (base: ThemeRgbColor, overlay: ThemeRgbColor, amount: number): ThemeRgbColor => ({
  r: base.r + (overlay.r - base.r) * amount,
  g: base.g + (overlay.g - base.g) * amount,
  b: base.b + (overlay.b - base.b) * amount,
})

export const themeRelativeLuminance = (color: ThemeRgbColor): number => {
  const linearize = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
}

export const themeContrastRatio = (first: ThemeRgbColor, second: ThemeRgbColor): number => {
  const lighter = Math.max(themeRelativeLuminance(first), themeRelativeLuminance(second))
  const darker = Math.min(themeRelativeLuminance(first), themeRelativeLuminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

export const readableThemeForeground = (background: ThemeRgbColor): ThemeRgbColor => {
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND)
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND)
  if (Math.max(lightContrast, darkContrast) >= 4.5) return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND
  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >= themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND
}

const readableThemeText = (background: ThemeRgbColor, foreground: ThemeRgbColor, amount: number, minimumRatio: number): ThemeRgbColor => {
  const softened = mixThemeRgbColors(foreground, background, amount)
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened
  let readable = foreground
  let lowerAmount = 0
  let upperAmount = amount
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lowerAmount + upperAmount) / 2
    const candidate = mixThemeRgbColors(foreground, background, candidateAmount)
    if (themeContrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate
      lowerAmount = candidateAmount
    } else {
      upperAmount = candidateAmount
    }
  }
  return readable
}

const solveOklchLightness = (base: ThemeOklch, against: ReadonlyArray<ThemeRgbColor>, minContrast: number, direction: "lighter" | "darker"): ThemeOklch => {
  const contrastOf = (color: ThemeOklch): number => Math.min(...against.map((surface) => themeContrastRatio(themeOklchToRgb(color), surface)))
  let low = direction === "lighter" ? base.L : 0
  let high = direction === "lighter" ? 1 : base.L
  let candidate = { ...base }
  if (contrastOf(candidate) >= minContrast) return candidate
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2
    candidate = { ...base, L: mid }
    if (contrastOf(candidate) >= minContrast) {
      if (direction === "lighter") high = mid
      else low = mid
    } else {
      if (direction === "lighter") low = mid
      else high = mid
    }
  }
  return { ...base, L: direction === "lighter" ? high : low }
}

const STANDARD_MUTED_CONTRAST = { light: 4.705, dark: 5.082 } as const

const standardMutedThemeText = (background: ThemeRgbColor, foreground: ThemeRgbColor): ThemeRgbColor => {
  const target = themeRelativeLuminance(background) < 0.179 ? STANDARD_MUTED_CONTRAST.dark : STANDARD_MUTED_CONTRAST.light
  return readableThemeText(background, foreground, 1, target)
}

const STANDARD_STATUS_COLORS = {
  light: { error: "#fb2c36", errorForeground: "#c10007", warning: "#fe9a00", warningForeground: "#bb4d00" },
  dark: { error: "#fb414a", errorForeground: "#ff6467", warning: "#fe9a00", warningForeground: "#ffb900" },
} as const

const standardStatusColors = (
  canvas: ThemeRgbColor,
): Pick<ThemeColors, "error" | "errorForeground" | "errorSurface" | "warning" | "warningForeground" | "warningSurface"> => {
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? "dark" : "light"
  const standard = STANDARD_STATUS_COLORS[appearance]
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08
  const surfaceOf = (value: string): ThemeRgbColor => mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), surfaceMix)
  const readableOn = (foreground: string, surface: ThemeRgbColor): string =>
    themeOklchToThemeColor(solveOklchLightness(themeRgbToOklch(parseThemeRgbColor(foreground, canvas)), [surface], 4.6, appearance === "dark" ? "lighter" : "darker"))
  const errorSurface = surfaceOf(standard.error)
  const warningSurface = surfaceOf(standard.warning)
  const error = toCanonicalThemeColor(standard.error) ?? standard.error
  const warning = toCanonicalThemeColor(standard.warning) ?? standard.warning
  return {
    error,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeOklchToThemeColor(themeRgbToOklch(errorSurface)),
    warning,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeOklchToThemeColor(themeRgbToOklch(warningSurface)),
  }
}

export const getDefaultThemeColors = (appearance: ThemeAppearance): ThemeColors =>
  appearance === "dark" ? (T3_CHAT_THEME.variants?.dark ?? T3_CHAT_THEME.colors) : T3_CHAT_THEME.colors

/** Builds a full 61-role palette from a canvas background and an accent seed, keeping contrast readable. */
export const createVividThemeColors = (appearance: ThemeAppearance, backgroundValue: string, accentValue: string): ThemeColors => {
  const defaults = getDefaultThemeColors(appearance)
  const canvasRgb = parseThemeRgbColor(backgroundValue, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 })
  const accentRgb = parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 })
  const canvas = themeRgbToOklch(canvasRgb)
  const accent = themeRgbToOklch(accentRgb)
  const dark = themeRelativeLuminance(canvasRgb) < 0.179
  const hue = accent.C < 0.02 ? canvas.h : accent.h
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22))
  const step = dark ? 1 : -1
  const surfaceAt = (deltaL: number, chroma: number = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  })
  const themeColor = (color: ThemeOklch): string => themeOklchToThemeColor(color)
  const textBase: ThemeOklch = { L: dark ? 0.95 : 0.2, C: Math.min(0.035, accent.C * 0.25), h: hue }
  const text = solveOklchLightness(textBase, [canvasRgb], 7, dark ? "lighter" : "darker")
  const textRgb = themeOklchToRgb(text)
  const textMutedRgb = standardMutedThemeText(canvasRgb, textRgb)
  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  }
  const actionRgb = themeOklchToRgb(action)
  const actionForeground = readableThemeForeground(actionRgb)
  const accentForeground = readableThemeForeground(accentRgb)
  const sidebar = surfaceAt(0.045, tintC * 1.4)
  const sidebarRgb = themeOklchToRgb(sidebar)
  const surface = surfaceAt(0.015)
  const surfaceRaised = surfaceAt(0.05)
  const surfaceRaisedRgb = themeOklchToRgb(surfaceRaised)
  const surfaceOverlay = surfaceAt(0.075)
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35))
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4))
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5))
  const secondaryRgb = themeOklchToRgb(secondary)
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35))
  const mutedRgb = themeOklchToRgb(muted)
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55))
  const accentSurfaceRgb = themeOklchToRgb(accentSurface)
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6))
  const messageSurfaceRgb = themeOklchToRgb(messageSurface)
  const codeBackground = surfaceAt(0.035, tintC * 0.8)
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55))
  const foregroundOn = (surfaceRgb: ThemeRgbColor): string => themeOklchToThemeColor(solveOklchLightness(textBase, [surfaceRgb], 4.6, dark ? "lighter" : "darker"))
  const mutedForeground = themeOklchToThemeColor(themeRgbToOklch(readableThemeText(mutedRgb, textRgb, 1, 4.6)))
  const placeholder = themeOklchToThemeColor(themeRgbToOklch(readableThemeText(surfaceRaisedRgb, textRgb, 1, 4.6)))
  const searchMatch = themeOklchToRgb(surfaceAt(0.22, Math.min(0.12, accent.C)))
  const searchMatchActive = themeOklchToRgb(surfaceAt(0.4, Math.min(0.18, accent.C)))
  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) }
  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeOklchToThemeColor(themeRgbToOklch(canvasRgb)),
    chrome: themeOklchToThemeColor(themeRgbToOklch(canvasRgb)),
    toolbar: themeOklchToThemeColor(themeRgbToOklch(canvasRgb)),
    toolbarForeground: themeOklchToThemeColor(themeRgbToOklch(textRgb)),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeOklchToThemeColor(themeRgbToOklch(textRgb)),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeOklchToThemeColor(themeRgbToOklch(textRgb)),
    textMuted: themeOklchToThemeColor(themeRgbToOklch(textMutedRgb)),
    border: themeColor(border),
    input: themeColor(input),
    focus: themeOklchToThemeColor(accent),
    accent: themeOklchToThemeColor(accent),
    accentForeground: themeOklchToThemeColor(themeRgbToOklch(accentForeground)),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: themeOklchToThemeColor(themeRgbToOklch(textMutedRgb)),
    iconMuted: themeOklchToThemeColor(themeRgbToOklch(textMutedRgb)),
    update: themeOklchToThemeColor(accent),
    updateForeground: foregroundOn(themeOklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeOklchToThemeColor(themeRgbToOklch(actionRgb)),
    messageActionForeground: themeOklchToThemeColor(themeRgbToOklch(actionForeground)),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: themeOklchToThemeColor(themeRgbToOklch(textRgb)),
    searchMatchBackground: themeOklchToThemeColor(themeRgbToOklch(searchMatch)),
    searchMatchForeground: themeOklchToThemeColor(themeRgbToOklch(readableThemeForeground(searchMatch))),
    searchMatchActiveBackground: themeOklchToThemeColor(themeRgbToOklch(searchMatchActive)),
    searchMatchActiveForeground: themeOklchToThemeColor(themeRgbToOklch(readableThemeForeground(searchMatchActive))),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeOklchToThemeColor(themeRgbToOklch(standardMutedThemeText(sidebarRgb, textRgb))),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeOklchToThemeColor(themeRgbToOklch(canvasRgb)),
    terminalForeground: themeOklchToThemeColor(themeRgbToOklch(textRgb)),
    terminalCursor: themeOklchToThemeColor(accent),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: themeColor(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: themeColor(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  }
}

/** Editing one role repairs the roles derived from it so the palette keeps readable contrast. */
export const updateThemeColorFamily = (
  appearance: ThemeAppearance,
  colors: ThemeColors,
  role: keyof ThemeColors,
  value: string,
): ThemeColors => {
  const parsedSelected = parseThemeColor(value)
  if (parsedSelected === null) return { ...colors, [role]: value }
  const normalized = formatOklchThemeColor(parsedSelected.color, parsedSelected.alpha)
  const canvas = parseThemeRgbColor(colors.canvas, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 })
  const selected = themeOklchToRgb(parsedSelected.color)
  const selectedOn = (background: ThemeRgbColor): ThemeRgbColor => mixThemeRgbColors(background, selected, parsedSelected.alpha)
  const selectedOnCanvas = selectedOn(canvas)
  const canvasIsDark = themeRelativeLuminance(canvas) < 0.179
  const colorOf = (color: ThemeRgbColor): string => themeOklchToThemeColor(themeRgbToOklch(color))
  const foregroundOn = (background: ThemeRgbColor): string => colorOf(readableThemeForeground(background))
  const selectedToneOn = (background: ThemeRgbColor): string =>
    themeOklchToThemeColor(solveOklchLightness(parsedSelected.color, [background], 4.6, themeRelativeLuminance(background) < 0.179 ? "lighter" : "darker"))
  const statusColors = (): { foreground: string; surface: string } => {
    const surface = mixThemeRgbColors(canvas, selectedOnCanvas, canvasIsDark ? 0.16 : 0.08)
    return { foreground: selectedToneOn(surface), surface: colorOf(surface) }
  }
  switch (role) {
    case "canvas":
      return { ...colors, canvas: normalized, chrome: normalized, toolbar: normalized }
    case "surface":
    case "surfaceRaised":
    case "surfaceOverlay":
    case "input":
    case "sidebarControlSurface":
      return { ...colors, [role]: normalized }
    case "text":
      return { ...colors, text: normalized, toolbarForeground: normalized, toolbarControlForeground: normalized }
    case "mutedForeground":
      return {
        ...colors,
        textMuted: normalized,
        mutedForeground: normalized,
        placeholder: normalized,
        secondaryLabel: normalized,
        iconMuted: normalized,
        sidebarMutedForeground: normalized,
      }
    case "border":
      return { ...colors, border: normalized, toolbarBorder: normalized, sidebarBorder: normalized }
    case "secondary":
      return {
        ...colors,
        secondary: normalized,
        secondaryForeground: foregroundOn(selectedOnCanvas),
        muted: normalized,
        toolbarControl: normalized,
      }
    case "accentSurface":
      return {
        ...colors,
        accentSurface: normalized,
        accentSurfaceForeground: foregroundOn(selectedOnCanvas),
        toolbarControlHover: normalized,
      }
    case "accent": {
      const updateSurface = mixThemeRgbColors(canvas, selectedOnCanvas, canvasIsDark ? 0.32 : 0.16)
      return {
        ...colors,
        accent: normalized,
        accentForeground: foregroundOn(selectedOnCanvas),
        focus: normalized,
        update: normalized,
        updateForeground: selectedToneOn(updateSurface),
        updateSurface: colorOf(updateSurface),
        terminalCursor: normalized,
      }
    }
    case "messageAction": {
      const actionForeground = readableThemeForeground(selectedOnCanvas)
      return {
        ...colors,
        messageAction: normalized,
        messageActionForeground: colorOf(actionForeground),
        messageActionHover: colorOf(mixThemeRgbColors(selectedOnCanvas, actionForeground, 0.08)),
      }
    }
    case "error": {
      const status = statusColors()
      return { ...colors, error: normalized, errorForeground: status.foreground, errorSurface: status.surface }
    }
    case "warning": {
      const status = statusColors()
      return { ...colors, warning: normalized, warningForeground: status.foreground, warningSurface: status.surface }
    }
    default:
      return { ...colors, [role]: normalized }
  }
}
