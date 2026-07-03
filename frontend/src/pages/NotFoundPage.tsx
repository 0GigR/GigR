import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Home } from 'lucide-react'

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 text-center px-4">
      <h1 className="text-9xl font-extrabold text-gray-200 dark:text-gray-800 tracking-widest">404</h1>
      <div className="bg-emerald-600 text-white px-2 text-sm rounded rotate-12 absolute">
        Page Not Found
      </div>
      <div className="mt-8">
        <h3 className="text-2xl md:text-3xl font-semibold text-gray-800 dark:text-white mb-2">
          Oops! Looks like you're lost.
        </h3>
        <p className="text-gray-500 dark:text-gray-400 mb-8 max-w-md">
          The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
        </p>
        <Link to="/">
          <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
            <Home className="w-4 h-4" /> Go to Home
          </Button>
        </Link>
      </div>
    </div>
  )
}
