import { Home, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 text-center px-4">
      <h1 className="text-9xl font-extrabold text-gray-200 dark:text-gray-800 tracking-widest select-none">
        404
      </h1>
      <div className="bg-emerald-600 text-white px-2 text-sm rounded rotate-12 absolute">
        Page Not Found
      </div>
      <div className="mt-8 space-y-4">
        <h3 className="text-2xl md:text-3xl font-semibold text-gray-800 dark:text-white">
          Oops! Looks like you're lost.
        </h3>
        <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto">
          The page you're looking for doesn't exist or you may have reached it through a stale link.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          {/* Hard navigation — resets to root even if the router is in a broken state */}
          <Button
            size="lg"
            className="bg-black hover:bg-gray-800 text-white gap-2"
            onClick={() => { window.location.href = '/' }}
          >
            <Home className="w-4 h-4" /> Go to Home
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="gap-2"
            onClick={() => window.history.back()}
          >
            <RefreshCw className="w-4 h-4" /> Go Back
          </Button>
        </div>
      </div>
    </div>
  )
}
