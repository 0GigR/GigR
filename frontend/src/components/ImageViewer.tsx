import { Dialog, DialogContent } from '@/components/ui/dialog'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  src: string
  alt?: string
}

export function ImageViewer({ open, onClose, src, alt }: Props) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[90vw] max-h-[90vh] p-0 bg-transparent border-none shadow-none">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="flex items-center justify-center w-full h-full">
          <img
            src={src}
            alt={alt || ''}
            className="max-w-full max-h-[85vh] object-contain rounded-lg"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}