import { Toaster } from 'sonner'

export function ToastProvider() {
  return (
    <Toaster
      position="bottom-center"
      closeButton
      richColors
      toastOptions={{
        style: {
          background: '#111',
          color: '#fff',
          border: '1px solid #333',
          borderRadius: '12px',
          fontSize: '14px',
        },
      }}
    />
  )
}