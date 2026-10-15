/**
 * mapPins.ts — Custom SVG pin generators for interactive Leaflet maps.
 *
 * Provides lightweight vector pins without external raster images or CDN dependencies.
 */

import L from 'leaflet'

export interface PinOptions {
  isSelected?: boolean
  accentColor?: string
}

/** Create a circular service provider pin with custom accent and drop shadow */
export function makeServicePin(
  title: string,
  price?: number | null,
  options: PinOptions = {}
): L.DivIcon {
  const { isSelected = false, accentColor = '#7c3aed' } = options
  const initial = (title || 'G').trim().charAt(0).toUpperCase()
  const priceTag = price != null ? `₦${Number(price).toLocaleString()}` : ''

  const halo = isSelected
    ? `<div style="position:absolute;inset:-4px;border-radius:9999px;background:${accentColor};opacity:0.35;animation:pulse 1.8s infinite;"></div>`
    : ''

  const html = `
    <div style="position:relative;width:34px;height:44px;display:flex;flex-direction:column;align-items:center;">
      ${halo}
      <div style="width:32px;height:32px;border-radius:9999px;background:${accentColor};display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.35);border:2px solid #ffffff;${isSelected ? 'outline:2px solid ' + accentColor + ';outline-offset:1px;' : ''}">
        <span style="color:#ffffff;font-size:12px;font-weight:700;line-height:1;font-family:sans-serif;">${initial}</span>
      </div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:9px solid ${accentColor};margin-top:-1px;"></div>
      ${priceTag ? `<div style="position:absolute;top:34px;white-space:nowrap;background:rgba(15,23,42,0.85);color:#ffffff;font-size:9px;font-weight:600;padding:1px 4px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.3);">${priceTag}</div>` : ''}
    </div>
  `

  return L.divIcon({
    html,
    className: 'gigr-service-pin',
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40],
  })
}

/** Create a square badge pin for job listings */
export function makeJobPin(
  title: string,
  price?: number | null,
  options: PinOptions = {}
): L.DivIcon {
  const { isSelected = false, accentColor = '#2563eb' } = options
  const priceDisplay = price != null ? `₦${Number(price).toLocaleString()}` : title.slice(0, 4)

  const halo = isSelected
    ? `<div style="position:absolute;inset:-4px;border-radius:8px;background:${accentColor};opacity:0.35;animation:pulse 1.8s infinite;"></div>`
    : ''

  const html = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      ${halo}
      <div style="background:${accentColor};color:#ffffff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:7px;box-shadow:0 3px 8px rgba(0,0,0,0.35);border:1.5px solid #ffffff;white-space:nowrap;${isSelected ? 'outline:2px solid ' + accentColor + ';outline-offset:1px;' : ''}">
        ${priceDisplay}
      </div>
      <div style="width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:7px solid ${accentColor};margin-top:-1px;"></div>
    </div>
  `

  return L.divIcon({
    html,
    className: 'gigr-job-pin',
    iconSize: [48, 30],
    iconAnchor: [24, 30],
    popupAnchor: [0, -28],
  })
}

/** Pulsing beacon pin representing user position */
export function makeUserBeaconPin(): L.DivIcon {
  const html = `
    <div style="position:relative;width:24px;height:24px;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;inset:0;border-radius:9999px;background:rgba(16,185,129,0.35);animation:ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>
      <div style="width:12px;height:12px;border-radius:9999px;background:#10b981;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
    </div>
  `

  return L.divIcon({
    html,
    className: 'gigr-user-beacon',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  })
}
