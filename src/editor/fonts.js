import { listFonts, fontUrl } from '../api.js'
import { registerFont } from './text.js'

/**
 * Loads the imported fonts into the browser once, so text can be drawn in
 * them, on screen and in the export alike.
 */
const loaded = new Map()

export async function loadFont ({ file, family }) {
  if (loaded.has(file)) return loaded.get(file)
  const job = new FontFace(family, `url(${fontUrl(file)})`).load()
    .then((face) => { document.fonts.add(face); registerFont(family); return family })
    .catch(() => null)
  loaded.set(file, job)
  return job
}

export async function loadFonts () {
  try {
    const { fonts } = await listFonts()
    await Promise.all(fonts.map(loadFont))
    return fonts
  } catch {
    return []
  }
}
