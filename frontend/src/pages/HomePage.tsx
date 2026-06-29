import { useAuthStore } from '@/store/authStore'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useEffect } from 'react'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Briefcase,
  MapPin,
  Star,
  TrendingUp,
  Clock,
  ArrowRight,
  Plus,
  Search,
  Bell,
} from 'lucide-react'
import type { components } from '@/types/api'

type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']
type Vouch = components['schemas']['VouchOut']

export default function HomePage() {
  const { user } = useAuthStore()

  // ────────── Data ──────────
  const { data: myJobs, isLoading: jobsLoading } = useQuery<Job[]>({
    queryKey: ['myJobsHome'],
    queryFn: async () => {
      const [c, p] = await Promise.all([
        api.get('/jobs/', { params: { my: 'client' } }),
        api.get('/jobs/', { params: { my: 'provider' } }),
      ])
      return [...c.data, ...p.data]
    },
  })

  const { data: myServices } = useQuery<Service[]>({
    queryKey: ['myServicesHome'],
    queryFn: async () => {
      const { data } = await api.get('/services/')
      return data
    },
  })

  const { data: myVouches, isLoading: vouchesLoading } = useQuery<Vouch[]>({
    queryKey: ['vouchesHome', user?.id],
    queryFn: async () => {
      if (!user?.id) return []
      const { data } = await api.get(`/vouches/user/${user.id}`)
      return data
    },
    enabled: !!user?.id,
  })

  const { data: nearbyServices } = useQuery<Service[]>({
    queryKey: ['nearbyServicesHome'],
    queryFn: async () => {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
        })
        const { data } = await api.get('/services/search/nearby', {
          params: { lat: pos.coords.latitude, lon: pos.coords.longitude, radius: 20 },
        })
        return data
      } catch {
        return []
      }
    },
  })

  const { data: openJobs } = useQuery<Job[]>({
    queryKey: ['openJobsHome'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/', { params: { status: 'open,assigned' } })
      return data
    },
  })

  // ────────── Send location on mount ──────────
  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        api.post('/users/me/location', {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }).catch(() => {})
      },
      () => {},
      { timeout: 5000 }
    )
  }, [])

  // ────────── Calculations ──────────
  const activeJobs = myJobs?.filter(j => !['completed', 'cancelled'].includes(j.status)) || []
  const completedJobs = myJobs?.filter(j => j.status === 'completed') || []
  const pendingApplications = activeJobs.filter(job => job.status === 'open' && job.client_id !== user?.id).length

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Welcome */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome back, {user?.display_name?.split(' ')[0]}
        </h1>
        <p className="text-gray-500 mt-1">Your neighborhood trusted marketplace</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="bg-white border-gray-100">
          <CardContent className="pt-6 text-center">
            <Briefcase className="w-7 h-7 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{activeJobs.length}</p>
            <p className="text-xs text-gray-500">Active</p>
          </CardContent>
        </Card>
        <Card className="bg-white border-gray-100">
          <CardContent className="pt-6 text-center">
            <Bell className="w-7 h-7 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{pendingApplications}</p>
            <p className="text-xs text-gray-500">Pending Apps</p>
          </CardContent>
        </Card>
        <Card className="bg-white border-gray-100">
          <CardContent className="pt-6 text-center">
            <Star className="w-7 h-7 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{myVouches?.length || 0}</p>
            <p className="text-xs text-gray-500">Vouches</p>
          </CardContent>
        </Card>
        <Card className="bg-white border-gray-100">
          <CardContent className="pt-6 text-center">
            <MapPin className="w-7 h-7 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{myServices?.length || 0}</p>
            <p className="text-xs text-gray-500">Services</p>
          </CardContent>
        </Card>
        <Card className="bg-white border-gray-100">
          <CardContent className="pt-6 text-center">
            <TrendingUp className="w-7 h-7 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{completedJobs.length}</p>
            <p className="text-xs text-gray-500">Completed</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="grid md:grid-cols-3 gap-6">
        <Link to="/dashboard/jobs?tab=open">
          <Card className="hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1 cursor-pointer h-full border-gray-100">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Search className="w-5 h-5" /> Find Work
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500">Browse open jobs in your area</p>
              <div className="mt-4 flex justify-between items-center">
                <span className="text-xs text-gray-400">{openJobs?.length || 0} open</span>
                <ArrowRight className="w-4 h-4 text-gray-400" />
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/dashboard/services">
          <Card className="hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1 cursor-pointer h-full border-gray-100">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="w-5 h-5" /> Hire a Pro
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500">Discover trusted providers near you</p>
              <div className="mt-4 flex justify-between items-center">
                <span className="text-xs text-gray-400">{nearbyServices?.length || 0} nearby</span>
                <ArrowRight className="w-4 h-4 text-gray-400" />
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/dashboard/activity">
          <Card className="hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1 cursor-pointer h-full border-gray-100">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-5 h-5" /> My Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-500">Track your jobs and reputation</p>
              <div className="mt-4 flex justify-between items-center">
                <span className="text-xs text-gray-400">{activeJobs.length} active</span>
                <ArrowRight className="w-4 h-4 text-gray-400" />
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Recent Activity Feed */}
      <div className="grid md:grid-cols-2 gap-8">
        {/* Recent Jobs */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Recent Jobs</h2>
            <Link to="/dashboard/activity">
              <Button variant="ghost" size="sm" className="text-gray-500">
                View all <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </Link>
          </div>
          {jobsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : myJobs?.length ? (
            <div className="space-y-3">
              {myJobs.slice(0, 5).map(job => (
                <Card key={job.id} className="border-gray-100">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{job.title}</p>
                      <p className="text-xs text-gray-500">
                        ₦{parseFloat(job.price as string).toLocaleString()} · {job.status}
                      </p>
                    </div>
                    <Badge variant="outline" className="capitalize ml-3">
                      {job.status}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
              <Briefcase className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-500">No jobs yet</p>
              <Link to="/dashboard/jobs">
                <Button variant="link" className="text-black mt-2">
                  <Plus className="w-4 h-4 mr-1" /> Post your first job
                </Button>
              </Link>
            </div>
          )}
        </div>

        {/* Recent Vouches */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Recent Vouches</h2>
            <Link to="/dashboard/profile">
              <Button variant="ghost" size="sm" className="text-gray-500">
                View all <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </Link>
          </div>
          {vouchesLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : myVouches?.length ? (
            <div className="space-y-3">
              {myVouches.slice(0, 5).map(vouch => (
                <Card key={vouch.id} className="border-gray-100">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="bg-black text-white text-xs">V</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm font-medium">On‑chain vouch received</p>
                        <p className="text-xs text-gray-500">
                          cNFT: {vouch.cnf_nft_id?.slice(0, 10)}...
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-gray-400">
                      {new Date(vouch.created_at).toLocaleDateString()}
                    </span>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
              <Star className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-500">No vouches yet</p>
              <p className="text-xs text-gray-400 mt-1">Complete jobs to build your reputation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}