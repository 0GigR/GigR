/**
 * Renders a chat message's content. If the content is an image URL (Cloudinary
 * or any http(s) image), it always renders as an image — for BOTH sender and
 * receiver — like a normal chat app. Otherwise renders text.
 *
 * Detection is tolerant: Cloudinary URLs frequently have no file extension, so
 * we match by host/path patterns as well as extensions.
 */
interface Props {
  content: string
  imageUrl?: string | null
  onImageClick?: (src: string) => void
  className?: string
}

// True if the string looks like an image URL we should render inline.
export function looksLikeImageUrl(s: string | null | undefined): boolean {
  if (!s) return false
  const t = s.trim()
  if (!/^https?:\/\//i.test(t)) return false
  // Explicit image extension anywhere before a query string
  if (/\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)(\?.*)?$/i.test(t)) return true
  // Cloudinary / common image CDNs (URLs often have no extension)
  if (/res\.cloudinary\.com\/.+\/image\/upload\//i.test(t)) return true
  if (/\/image\/upload\//i.test(t)) return true
  return false
}

export default function ChatMessageContent({ content, imageUrl, onImageClick, className }: Props) {
  // Prefer an explicit image_url field; fall back to content-that-is-a-url
  const src = imageUrl && looksLikeImageUrl(imageUrl)
    ? imageUrl
    : looksLikeImageUrl(content)
      ? content
      : null

  if (src) {
    return (
      <img
        src={src}
        alt="shared image"
        loading="lazy"
        className={`rounded-lg max-w-full max-h-64 object-cover cursor-pointer ${className || ''}`}
        onClick={() => onImageClick?.(src)}
      />
    )
  }
  return <p className={`text-sm whitespace-pre-wrap break-words ${className || ''}`}>{content}</p>
}
