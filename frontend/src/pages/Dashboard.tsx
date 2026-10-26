import { useAuthStore } from '@/store/authStore'

export default function Dashboard() {
  const { user } = useAuthStore()

  return (
    <div className="animate-in fade-in duration-500">
      <h1 className="text-3xl font-bold mb-2">Welcome, {user?.display_name}</h1>
      <p className="text-gray-500 dark:text-muted-foreground">Email: {user?.email}</p>
      {/* Placeholder for activity feed, nearby services, etc. */}
    </div>
  )
}