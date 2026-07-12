import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { motion } from 'framer-motion'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
}

export function EmptyState({ icon, title, description, actionLabel, actionHref, onAction }: EmptyStateProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center py-16 px-4 text-center border border-dashed border-gray-200 dark:border-gray-800 rounded-2xl bg-gray-50/50 dark:bg-gray-900/50"
    >
      <motion.div 
        initial={{ y: -10 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 15 }}
        className="bg-white dark:bg-gray-800 p-4 rounded-full shadow-sm mb-4 text-gray-400"
      >
        {icon}
      </motion.div>
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
      <p className="text-gray-500 max-w-sm mb-6 leading-relaxed">
        {description}
      </p>
      {actionLabel && (actionHref || onAction) && (
        actionHref ? (
          <Link to={actionHref}>
            <Button className="bg-black text-white hover:bg-gray-800 rounded-full px-6">
              {actionLabel}
            </Button>
          </Link>
        ) : (
          <Button onClick={onAction} className="bg-black text-white hover:bg-gray-800 rounded-full px-6">
            {actionLabel}
          </Button>
        )
      )}
    </motion.div>
  )
}
